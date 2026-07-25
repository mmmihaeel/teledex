import readline from "node:readline";

import {
  TELEDEX_APP_NAME,
  TELEDEX_DISPLAY_NAME,
} from "../config/app-identity.js";
import {
  buildCodexChildEnv,
  getCodexProviderEnvKeyNames,
} from "../runtime/codex-child-env.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";
import { createCompactJsonlLogMirror } from "../codex-exec/jsonl-log-mirror.js";
import {
  hasChildExited,
  isRelevantWarning,
} from "../pty-worker/codex-runner-common.js";
import {
  findInProgressTurn,
  isNoActiveTurnSteerError,
  normalizeOptionalText,
} from "../pty-worker/codex-runner-thread-history.js";
import { buildTurnInput } from "../pty-worker/turn-input.js";
import { buildCodexAppServerV2Args } from "./app-server-v2-args.js";
import {
  clearPendingGoalContinuationStartTimer,
  setGoalAndWaitForContinuation,
} from "./goal-continuation.js";
import { createJsonLineRpcClient } from "./jsonl-rpc-client.js";
import {
  handleNotification,
  markTerminalTurnObserved,
} from "./notifications.js";
import {
  APP_SERVER_BOOT_TIMEOUT_MS,
  APP_SERVER_CONTROL_TIMEOUT_MS,
  APP_SERVER_SHUTDOWN_GRACE_MS,
  GOAL_CONTINUATION_START_TIMEOUT_MS,
  GOAL_REQUEST_TIMEOUT_MS,
  INTERRUPT_RETRY_DELAYS_MS,
  STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS,
  STEER_REQUEST_TIMEOUT_MS,
  THREAD_RESUME_RETRY_DELAYS_MS,
  TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS,
} from "./runner-constants.js";
import {
  buildThreadParams,
  buildTurnStartParams,
  defaultServerRequestHandler,
  publishRuntimeState,
  updateThreadStateFromResponse,
} from "./thread-state.js";
import { requestThreadResume } from "./thread-control.js";
import {
  isFinalizingTurnState,
  requestTurnInterrupt,
  runPendingSteerFlush,
  schedulePendingSteerFlush,
} from "./steering.js";

export const CODEX_APP_SERVER_V2_BACKEND = "app-server-v2";

function createDeferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function stopChild(child, graceMs) {
  if (hasChildExited(child)) {
    return;
  }

  signalChildProcessTree(child, "SIGTERM");
  setTimeout(() => {
    if (!hasChildExited(child)) {
      signalChildProcessTree(child, "SIGKILL");
    }
  }, graceMs).unref();
}

function finish(context, payload) {
  const { state } = context;
  if (state.settled) {
    return;
  }

  state.settled = true;
  state.shuttingDown = true;
  if (state.pendingTurnCompletionTimer) {
    clearTimeout(state.pendingTurnCompletionTimer);
    state.pendingTurnCompletionTimer = null;
  }
  clearPendingGoalContinuationStartTimer(state);
  try {
    state.rpc?.close();
  } catch {}
  stopChild(context.child, context.appServerShutdownGraceMs);
  const resolvedThreadId = payload.threadId ?? state.latestThreadId ?? null;
  const resolvedRolloutPath = payload.rolloutPath ?? state.latestRolloutPath ?? null;
  const preserveContinuity = payload.preserveContinuity ?? (
    Boolean(resolvedThreadId)
    && (
      payload.abortReason === "transport_lost"
      || payload.abortReason === "process_closed_before_terminal"
    )
  );
  context.finished.resolve({
    backend: CODEX_APP_SERVER_V2_BACKEND,
    providerSessionId: null,
    rolloutPath: resolvedRolloutPath,
    contextSnapshot: null,
    warnings: state.warnings,
    resumeReplacement: null,
    preserveContinuity,
    ...payload,
    threadId: resolvedThreadId,
  });
}

function fail(context, error) {
  const { state } = context;
  if (state.settled) {
    return;
  }

  state.settled = true;
  state.shuttingDown = true;
  clearPendingGoalContinuationStartTimer(state);
  try {
    state.rpc?.close();
  } catch {}
  stopChild(context.child, context.appServerShutdownGraceMs);
  context.finished.reject(error);
}

function finishTransportLossAfterNotifications(context, payload) {
  const { state } = context;
  state.notificationChain
    .catch(() => {})
    .then(() => {
      if (state.settled || state.shuttingDown || state.pendingTurnCompletionTimer) {
        return;
      }
      finish(context, payload);
    });
}

function isRecoverableStartupControlError(error) {
  const message = String(error?.message || error || "");
  return /\b(timed out|transport closed|EPIPE|ECONNRESET)\b/iu.test(message);
}

function createJsonlEventMirror({ jsonlLogPath = null, onWarning = null } = {}) {
  const mirror = createCompactJsonlLogMirror({
    jsonlLogPath,
    onWarning,
    label: "app-server-v2 JSONL",
  });
  if (!mirror) {
    return null;
  }
  return async (event) => {
    mirror.appendEvent(event);
    await mirror.settle();
  };
}

function finishRecoverableStartupControlError(context, error) {
  const { state } = context;
  const threadId = state.latestThreadId || state.primaryThreadId || context.sessionThreadId || null;
  if (!threadId || !isRecoverableStartupControlError(error)) {
    return false;
  }

  finish(context, {
    ok: false,
    exitCode: null,
    signal: null,
    threadId,
    interrupted: false,
    interruptReason: null,
    abortReason: "control_rpc_failed",
    preserveContinuity: true,
    warnings: [
      ...state.warnings,
      error?.message || String(error),
    ],
  });
  return true;
}

function finishRecoverableStartupTransportError(context, error) {
  const { state } = context;
  const threadId = state.latestThreadId || state.primaryThreadId || context.sessionThreadId || null;
  const message = String(error?.message || error || "");
  if (threadId || !/\b(transport closed|EPIPE|ECONNRESET)\b/iu.test(message)) {
    return false;
  }

  finish(context, {
    ok: false,
    exitCode: null,
    signal: null,
    threadId: null,
    interrupted: false,
    interruptReason: null,
    abortReason: "transport_lost_before_thread",
    warnings: [
      ...state.warnings,
      error?.message || String(error),
    ],
  });
  return true;
}

async function startAppServerV2(context) {
  const { state } = context;
  state.rpc = createJsonLineRpcClient({
    input: context.child.stdout,
    output: context.child.stdin,
    label: "Codex app-server-v2",
    onNotification(event) {
      markTerminalTurnObserved(context, event);
      state.notificationChain = state.notificationChain
        .catch(() => {})
        .then(() => handleNotification(context, event));
    },
    onRequest: context.onServerRequest || defaultServerRequestHandler,
    onWarning(line) {
      state.warnings.push(line);
      context.onWarning?.(line);
    },
    onDisconnect(error) {
      if (state.shuttingDown || state.settled) {
        return;
      }

      const threadId = state.latestThreadId || state.primaryThreadId || context.sessionThreadId || null;
      finishTransportLossAfterNotifications(context, {
        ok: false,
        exitCode: null,
        signal: null,
        threadId,
        interrupted: false,
        interruptReason: null,
        abortReason: threadId ? "transport_lost" : "transport_lost_before_thread",
        warnings: [
          ...state.warnings,
          error?.message || "Codex app-server-v2 transport closed",
        ],
      });
    },
  });

  await state.rpc.request("initialize", {
    clientInfo: {
      name: TELEDEX_APP_NAME,
      title: TELEDEX_DISPLAY_NAME,
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  }, {
    timeoutMs: context.appServerBootTimeoutMs,
  });
  state.rpc.notify("initialized");

  const resumeThreadId = normalizeOptionalText(context.sessionThreadId);
  const threadResponse = resumeThreadId
    ? await requestThreadResume(context, {
        ...context.threadParams,
        threadId: resumeThreadId,
        ...(context.knownRolloutPath ? { path: context.knownRolloutPath } : {}),
      })
    : await state.rpc.request("thread/start", context.threadParams, {
        timeoutMs: context.appServerControlTimeoutMs,
      });
  updateThreadStateFromResponse(state, threadResponse?.thread);
  state.primaryThreadId = state.latestThreadId;
  await publishRuntimeState(state, context.onRuntimeState, {
    threadId: state.latestThreadId,
    activeTurnId: state.activeTurnId,
    rolloutPath: state.latestRolloutPath,
  });

  async function startNewTurn(input) {
    const turnResponse = await state.rpc.request("turn/start", buildTurnStartParams({
      threadId: state.latestThreadId,
      input,
      cwd: context.cwd,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
    }), {
      timeoutMs: context.appServerControlTimeoutMs,
    });
    state.activeTurnId = normalizeOptionalText(turnResponse?.turn?.id) || state.activeTurnId;
    await publishRuntimeState(state, context.onRuntimeState, {
      threadId: state.latestThreadId,
      activeTurnId: state.activeTurnId,
      rolloutPath: state.latestRolloutPath,
    });
    schedulePendingSteerFlush(context);
  }

  const openTurn = resumeThreadId ? findInProgressTurn(threadResponse?.thread) : null;
  if (context.goalStart) {
    if (!state.latestThreadId) {
      throw new Error("app-server-v2 goal runs require an existing materialized thread");
    }
    if (!resumeThreadId) {
      state.goalSetAfterMaterialization = true;
      await startNewTurn(context.initialInput);
      return;
    }
    if (openTurn) {
      state.activeTurnId = normalizeOptionalText(openTurn.id) || state.activeTurnId;
      await publishRuntimeState(state, context.onRuntimeState, {
        threadId: state.latestThreadId,
        activeTurnId: state.activeTurnId,
      });
    }
    await setGoalAndWaitForContinuation(context);
    return;
  }

  if (openTurn) {
    state.activeTurnId = normalizeOptionalText(openTurn.id) || state.activeTurnId;
    await publishRuntimeState(state, context.onRuntimeState, {
      threadId: state.latestThreadId,
      activeTurnId: state.activeTurnId,
    });
    if (Array.isArray(context.initialInput) && context.initialInput.length > 0) {
      state.pendingSteerInputs.push(...context.initialInput);
      try {
        await runPendingSteerFlush(context);
      } catch (error) {
        if (!isNoActiveTurnSteerError(error)) {
          throw error;
        }

        const fallbackInput = state.pendingSteerInputs.splice(0, state.pendingSteerInputs.length);
        state.warnings.push(`resumed app-server-v2 turn was not steerable: ${error?.message || error}`);
        state.activeTurnId = null;
        await startNewTurn(fallbackInput.length > 0 ? fallbackInput : context.initialInput);
      }
      return;
    }
    schedulePendingSteerFlush(context);
    return;
  }

  await startNewTurn(context.initialInput);
}

export function runCodexAppServerV2Task({
  codexBinPath,
  cwd,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  sessionThreadId = null,
  knownRolloutPath = null,
  imagePaths = [],
  onEvent,
  onWarning,
  onRuntimeState = null,
  onServerRequest = null,
  spawnImpl,
  appServerBootTimeoutMs = APP_SERVER_BOOT_TIMEOUT_MS,
  appServerControlTimeoutMs = APP_SERVER_CONTROL_TIMEOUT_MS,
  appServerShutdownGraceMs = APP_SERVER_SHUTDOWN_GRACE_MS,
  threadResumeRetryDelaysMs = THREAD_RESUME_RETRY_DELAYS_MS,
  steerRequestTimeoutMs = STEER_REQUEST_TIMEOUT_MS,
  steerActiveTurnRefreshRetryDelaysMs = STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS,
  interruptRetryDelaysMs = INTERRUPT_RETRY_DELAYS_MS,
  turnCompletionFinalMessageGraceMs = TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS,
  goalContinuationStartTimeoutMs = GOAL_CONTINUATION_START_TIMEOUT_MS,
  goalStart = null,
  jsonlLogPath = null,
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
  platform = process.platform,
  spawnCommand = codexBinPath,
  spawnArgs = null,
  spawnCwd = cwd,
}) {
  const args = Array.isArray(spawnArgs)
    ? spawnArgs
    : buildCodexAppServerV2Args({
      model,
      modelProvider,
      modelProviderConfig,
      reasoningEffort,
      contextWindow,
      autoCompactTokenLimit,
      configOverrides,
    });
  const child = spawnRuntimeCommand(spawnCommand, args, {
    cwd: spawnCwd,
    env: buildCodexChildEnv(process.env, {
      extraAllowedEnvNames: getCodexProviderEnvKeyNames(modelProviderConfig),
      platform,
    }),
    platform,
    stdio: ["pipe", "pipe", "pipe"],
    detached: platform !== "win32",
    spawnImpl,
  });
  const stderrReader = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });
  const finished = createDeferred();
  const state = {
    warnings: [],
    latestThreadId: normalizeOptionalText(sessionThreadId),
    latestRolloutPath: normalizeOptionalText(knownRolloutPath),
    primaryThreadId: normalizeOptionalText(sessionThreadId),
    activeTurnId: null,
    rpc: null,
    shuttingDown: false,
    settled: false,
    interruptRequested: false,
    notificationChain: Promise.resolve(),
    flushChain: Promise.resolve(),
    pendingSteerInputs: [],
    pendingGoalContinuationStartTimer: null,
    goalSetAfterMaterialization: false,
    sawPrimaryFinalAnswer: false,
    pendingTurnCompletionTimer: null,
    terminalTurnObserved: false,
  };

  const context = {
    child,
    cwd,
    sessionThreadId,
    knownRolloutPath: normalizeOptionalText(knownRolloutPath),
    initialInput: buildTurnInput({ prompt, imagePaths }),
    threadParams: buildThreadParams({
      cwd,
      developerInstructions,
      baseInstructions,
      model,
      modelProvider,
      reasoningEffort,
    }),
    model,
    reasoningEffort,
    state,
    finished,
    onEvent,
    onWarning,
    onRuntimeState,
    onServerRequest,
    mirrorEvent: createJsonlEventMirror({ jsonlLogPath, onWarning }),
    appServerBootTimeoutMs,
    appServerControlTimeoutMs,
    appServerShutdownGraceMs,
    threadResumeRetryDelaysMs,
    steerRequestTimeoutMs,
    steerActiveTurnRefreshRetryDelaysMs,
    interruptRetryDelaysMs,
    turnCompletionFinalMessageGraceMs,
    goalContinuationStartTimeoutMs,
    goalStart,
  };
  context.finishRun = (payload) => finish(context, payload);

  stderrReader.on("line", (line) => {
    if (!line || isRelevantWarning(line)) {
      return;
    }

    state.warnings.push(line);
    onWarning?.(line);
  });
  child.on("error", (error) => fail(context, error));
  child.on("close", (code, signal) => {
    if (state.settled || state.shuttingDown) {
      return;
    }

    const threadId = state.latestThreadId || state.primaryThreadId || sessionThreadId || null;
    finishTransportLossAfterNotifications(context, {
      ok: false,
      exitCode: code ?? 1,
      signal,
      threadId,
      interrupted: false,
      interruptReason: null,
      abortReason: threadId ? "process_closed_before_terminal" : "process_closed_before_thread",
    });
  });

  startAppServerV2(context).catch((error) => {
    if (state.interruptRequested) {
      finish(context, {
        ok: false,
        exitCode: null,
        signal: "SIGINT",
        interrupted: true,
        interruptReason: "user",
        abortReason: "interrupted",
      });
      return;
    }

    if (finishRecoverableStartupControlError(context, error)) {
      return;
    }

    if (finishRecoverableStartupTransportError(context, error)) {
      return;
    }

    fail(context, error);
  });

  return {
    child,
    finished: finished.promise,
    steer({ input } = {}) {
      const normalizedInput = Array.isArray(input) ? input.filter(Boolean) : [];
      if (normalizedInput.length === 0) {
        return Promise.resolve({ ok: false, reason: "empty" });
      }

      if (isFinalizingTurnState(state)) {
        return Promise.resolve({ ok: false, reason: "finalizing" });
      }

      state.pendingSteerInputs.push(...normalizedInput);
      if (!state.rpc || !state.latestThreadId || !state.activeTurnId) {
        return Promise.resolve({
          ok: true,
          reason: "steer-buffered",
          inputCount: normalizedInput.length,
        });
      }

      return runPendingSteerFlush(context).catch((error) => ({
        ok: false,
        reason: "steer-failed",
        error,
      }));
    },
    interrupt({ threadId = state.latestThreadId, turnId = state.activeTurnId } = {}) {
      state.interruptRequested = true;
      return requestTurnInterrupt(context, { threadId, turnId });
    },
    setGoal({ objective = null, status = null, tokenBudget = undefined } = {}) {
      if (!state.rpc || !state.latestThreadId) {
        return Promise.reject(new Error("No active app-server-v2 thread"));
      }

      return state.rpc.request("thread/goal/set", {
        threadId: state.latestThreadId,
        ...(objective !== null && objective !== undefined ? { objective } : {}),
        ...(status !== null && status !== undefined ? { status } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      }, {
        timeoutMs: GOAL_REQUEST_TIMEOUT_MS,
      });
    },
    getGoal() {
      if (!state.rpc || !state.latestThreadId) {
        return Promise.reject(new Error("No active app-server-v2 thread"));
      }

      return state.rpc.request("thread/goal/get", {
        threadId: state.latestThreadId,
      }, {
        timeoutMs: GOAL_REQUEST_TIMEOUT_MS,
      });
    },
    clearGoal() {
      if (!state.rpc || !state.latestThreadId) {
        return Promise.reject(new Error("No active app-server-v2 thread"));
      }

      return state.rpc.request("thread/goal/clear", {
        threadId: state.latestThreadId,
      }, {
        timeoutMs: GOAL_REQUEST_TIMEOUT_MS,
      });
    },
  };
}

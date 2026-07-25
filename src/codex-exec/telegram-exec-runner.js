import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { summarizeCodexExecEvent } from "./exec-event-summary.js";
import { createJsonlProcessor } from "./exec-jsonl-processor.js";
import { createCompactJsonlLogMirror } from "./jsonl-log-mirror.js";
import {
  buildRemoteCodexExecSshArgs,
  buildRemoteInputRunSegment,
  cleanupRemoteInputRoot,
  prepareRemoteExecPaths,
  sanitizePathSegment,
  stageExecImagesToRemote,
} from "../runtime/remote-codex-staging.js";
import { resolveExecutionCwd } from "../hosts/host-paths.js";
import {
  buildCodexChildEnv,
  getCodexProviderEnvKeyNames,
} from "../runtime/codex-child-env.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";

export const CODEX_EXEC_BACKEND = "exec-json";
export { summarizeCodexExecEvent };
export { buildRemoteCodexExecSshArgs };

const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_BYTES = 16 * 1024;
const STDERR_TAIL_LINE_MAX_BYTES = 2 * 1024;
const STREAM_CLOSE_GRACE_MS = 1000;

function runtimeLabelForBackend(backend) {
  return backend === CODEX_EXEC_BACKEND
    ? "Codex exec"
    : backend === "deepseek-http"
      ? "DeepSeek HTTP runtime"
      : "runtime";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function truncateUtf8(text, maxBytes) {
  const normalized = String(text ?? "");
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  const suffix = "... [truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const availableBytes = Math.max(maxBytes - suffixBytes, 0);
  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(0, mid), "utf8") <= availableBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${normalized.slice(0, low)}${suffix}`;
}

function tailBytes(lines) {
  return Buffer.byteLength(lines.join("\n"), "utf8");
}

function rememberTail(
  lines,
  line,
  {
    maxBytes = STDERR_TAIL_MAX_BYTES,
    maxLineBytes = STDERR_TAIL_LINE_MAX_BYTES,
    maxLines = STDERR_TAIL_LINES,
  } = {},
) {
  const normalized = truncateUtf8(String(line ?? "").trimEnd(), maxLineBytes);
  if (!normalized) {
    return;
  }

  lines.push(normalized);
  while (lines.length > maxLines || tailBytes(lines) > maxBytes) {
    lines.shift();
  }
}

function isInterruptExit({ code, signal }) {
  return (
    signal === "SIGINT"
    || signal === "SIGTERM"
    || signal === "SIGKILL"
    || code === 130
    || code === 143
  );
}

function resolveDeveloperInstructions({
  developerInstructions = null,
  baseInstructions = null,
} = {}) {
  return normalizeOptionalText(developerInstructions)
    || normalizeOptionalText(baseInstructions);
}

function detectCodexAuthFailure(stderrTail = []) {
  const text = Array.isArray(stderrTail)
    ? stderrTail.join("\n")
    : String(stderrTail || "");
  if (!text.trim()) {
    return null;
  }
  if (
    /access token could not be refreshed/iu.test(text)
    || /refresh token was already used/iu.test(text)
    || /please log out and sign in again/iu.test(text)
  ) {
    return "Codex auth failed: refresh token was rejected; refresh Codex auth on the execution host.";
  }
  return null;
}

export function buildCodexExecPrompt({ prompt = "" } = {}) {
  return String(prompt || "");
}

export function buildCodexExecTaskArgs({
  cwd,
  sessionThreadId = null,
  imagePaths = [],
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
  developerInstructions = null,
} = {}) {
  const normalizedCwd = normalizeOptionalText(cwd);
  if (!normalizedCwd) {
    throw new Error("codex exec requires cwd");
  }

  const normalizedThreadId = normalizeOptionalText(sessionThreadId);
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    normalizedCwd,
  ];

  if (normalizedThreadId) {
    args.push("resume");
  }

  appendCodexRuntimeConfigArgs(args, {
    model,
    modelProvider,
    modelProviderConfig,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    configOverrides,
    developerInstructions,
  });

  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    const normalizedImagePath = normalizeOptionalText(imagePath);
    if (normalizedImagePath) {
      args.push("-i", normalizedImagePath);
    }
  }

  if (normalizedThreadId) {
    args.push(normalizedThreadId, "-");
  } else {
    args.push("-");
  }

  return args;
}

async function waitForReaderClose(reader, closePromise, graceMs) {
  const result = await Promise.race([
    closePromise.then(() => "closed"),
    sleep(graceMs).then(() => "timeout"),
  ]);
  if (result === "timeout") {
    reader.close();
  }
  await closePromise.catch(() => null);
}

export function startExecChild({
  backend = CODEX_EXEC_BACKEND,
  command,
  args,
  cwd = undefined,
  prompt,
  onEvent,
  onWarning,
  onRuntimeState,
  spawnImpl,
  platform = process.platform,
  detached = platform !== "win32",
  providerEnvKeys = [],
  jsonlLogPath = null,
  sessionThreadId = null,
  streamCloseGraceMs = STREAM_CLOSE_GRACE_MS,
  terminateOnTerminalEvent = true,
}) {
  const child = spawnRuntimeCommand(command, args, {
    cwd,
    env: buildCodexChildEnv(process.env, {
      extraAllowedEnvNames: providerEnvKeys,
      platform,
    }),
    platform,
    stdio: ["pipe", "pipe", "pipe"],
    detached,
    spawnImpl,
  });
  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  const stderrTail = [];
  const processor = createJsonlProcessor({ onEvent, onWarning, onRuntimeState });
  const jsonlLogMirror = createCompactJsonlLogMirror({
    jsonlLogPath,
    onWarning,
    label: "codex exec JSONL",
  });

  stdoutReader.on("line", (line) => {
    jsonlLogMirror?.appendLine(line);
    processor.ingestLine(line);
  });
  stderrReader.on("line", (line) => {
    rememberTail(stderrTail, line);
  });

  const closePromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const exitSettledPromise = closePromise.then(
    (exit) => ({ kind: "child-exit", exit }),
    (error) => ({ kind: "child-error", error }),
  );
  const terminalSettledPromise = processor.terminalEventPromise.then(
    (event) => ({ kind: "terminal-event", event }),
  );
  const stdoutClosed = once(stdoutReader, "close").catch(() => null);
  const stderrClosed = once(stderrReader, "close").catch(() => null);

  if (child.stdin) {
    child.stdin.end(String(prompt || ""));
  }

  let userInterruptRequested = false;
  let steerInterruptRequested = false;

  const finished = (async () => {
    const firstCompletion = await Promise.race([
      exitSettledPromise,
      terminalSettledPromise,
    ]);
    if (firstCompletion.kind === "child-error") {
      throw firstCompletion.error;
    }

    let exit = firstCompletion.kind === "child-exit"
      ? firstCompletion.exit
      : null;
    const completedFromTerminalEvent = firstCompletion.kind === "terminal-event";
    if (completedFromTerminalEvent) {
      if (terminateOnTerminalEvent) {
        signalChildProcessTree(child, "SIGTERM", { platform });
      }
      const maybeExit = await Promise.race([
        exitSettledPromise,
        sleep(streamCloseGraceMs).then(() => null),
      ]);
      if (maybeExit?.kind === "child-exit") {
        exit = maybeExit.exit;
      } else if (terminateOnTerminalEvent) {
        signalChildProcessTree(child, "SIGKILL", { platform });
        const killedExit = await Promise.race([
          exitSettledPromise,
          sleep(streamCloseGraceMs).then(() => null),
        ]);
        if (killedExit?.kind === "child-exit") {
          exit = killedExit.exit;
        }
      }
    }

    await Promise.all([
      waitForReaderClose(stdoutReader, stdoutClosed, streamCloseGraceMs),
      waitForReaderClose(stderrReader, stderrClosed, streamCloseGraceMs),
    ]);
    await jsonlLogMirror?.settle();
    await processor.settle();
    exit ??= { code: null, signal: null };

    const requestedInterrupt = userInterruptRequested || steerInterruptRequested;
    const requestedInterruptWithoutTerminalEvent =
      requestedInterrupt
      && !processor.state.sawTurnCompleted
      && !processor.state.sawTurnFailed
      && !processor.state.fatalError;
    const interrupted =
      !completedFromTerminalEvent
      && (
        isInterruptExit(exit)
        || requestedInterruptWithoutTerminalEvent
      );
    const warnings = [];
    if (processor.state.malformedLineCount > 0) {
      warnings.push(
        `Ignored malformed codex exec JSONL lines: ${processor.state.malformedLineCount}`,
      );
    }
    if (processor.state.fatalError?.message && !interrupted) {
      warnings.push(
        `${runtimeLabelForBackend(backend)} failed: ${processor.state.fatalError.message}`,
      );
    }
    if (
      !completedFromTerminalEvent
      && (exit.code !== 0 || exit.signal)
      && stderrTail.length > 0
      && !interrupted
    ) {
      warnings.push(`codex exec stderr:\n${stderrTail.join("\n")}`);
    }
    const codexAuthFailure = !interrupted
      ? detectCodexAuthFailure(stderrTail)
      : null;
    if (codexAuthFailure) {
      warnings.unshift(codexAuthFailure);
    }
    if (!processor.state.sawTurnCompleted && !interrupted) {
      warnings.push("Codex exec stream ended before turn.completed");
    }

    const ok =
      (completedFromTerminalEvent || exit.code === 0)
      && (completedFromTerminalEvent || !exit.signal)
      && processor.state.sawTurnCompleted
      && !processor.state.fatalError;
    const requestedThreadId = normalizeOptionalText(sessionThreadId);
    const codexExecBackend = backend === CODEX_EXEC_BACKEND;
    const resumeReplacement =
      codexExecBackend
      && requestedThreadId
      && !processor.state.latestThreadId
      && !interrupted
      && !ok
      && !codexAuthFailure
        ? {
          requestedThreadId,
          replacementThreadId: null,
          reason: "exec-resume-unavailable",
        }
        : null;
    const abortReason = interrupted
      ? "interrupted"
      : resumeReplacement
        ? "resume_unavailable"
        : codexAuthFailure
          ? "codex_auth_failed"
        : processor.state.sawTurnFailed
          ? "turn_failed"
          : processor.state.fatalError
            ? "exec_stream_error"
            : !processor.state.sawTurnCompleted
              ? "exec_stream_incomplete"
              : null;

    return {
      backend,
      ok,
      exitCode: exit.code,
      signal: exit.signal,
      interrupted,
      interruptReason: interrupted
        ? steerInterruptRequested
          ? "upstream"
          : userInterruptRequested
          ? "user"
          : "upstream"
        : null,
      preserveContinuity: Boolean(processor.state.latestThreadId || requestedThreadId),
      threadId: processor.state.latestThreadId || requestedThreadId,
      warnings,
      resumeReplacement,
      abortReason,
    };
  })();

  return {
    child,
    finished,
    interrupt() {
      userInterruptRequested = true;
      return Promise.resolve(
        signalChildProcessTree(child, "SIGINT", { platform }),
      );
    },
    async steer() {
      steerInterruptRequested = true;
      const signalled = await Promise.resolve(
        signalChildProcessTree(child, "SIGINT", { platform }),
      );
      if (signalled === false) {
        steerInterruptRequested = false;
      }
      return {
        ok: signalled !== false,
        reason: signalled === false ? "steer-failed" : "steered",
      };
    },
  };
}

export function runCodexExecTask({
  codexBinPath,
  cwd,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  sessionThreadId = null,
  imagePaths = [],
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
  onEvent,
  onWarning,
  onRuntimeState,
  jsonlLogPath = null,
  spawnImpl,
  platform = process.platform,
  streamCloseGraceMs = STREAM_CLOSE_GRACE_MS,
}) {
  const args = buildCodexExecTaskArgs({
    cwd,
    sessionThreadId,
    imagePaths,
    model,
    modelProvider,
    modelProviderConfig,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    configOverrides,
    developerInstructions: resolveDeveloperInstructions({
      developerInstructions,
      baseInstructions,
    }),
  });

  return startExecChild({
    command: codexBinPath,
    args,
    cwd,
    prompt: buildCodexExecPrompt({ prompt }),
    onEvent,
    onWarning,
    onRuntimeState,
    jsonlLogPath,
    spawnImpl,
    platform,
    providerEnvKeys: getCodexProviderEnvKeyNames(modelProviderConfig),
    sessionThreadId,
    streamCloseGraceMs,
  });
}

export async function runRemoteCodexExecTask({
  codexBinPath,
  connectTimeoutSecs = 8,
  currentHostId,
  executionHost,
  host = executionHost?.host ?? null,
  imagePaths = [],
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
  onEvent,
  onRuntimeState = null,
  onWarning,
  jsonlLogPath = null,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  execFileImpl,
  reasoningEffort = null,
  session,
  sessionKey = null,
  sessionThreadId = null,
  spawnImpl,
  platform = process.platform,
  streamCloseGraceMs = STREAM_CLOSE_GRACE_MS,
}) {
  const resolvedHost = host || null;
  const hostId = normalizeOptionalText(executionHost?.hostId || resolvedHost?.host_id);
  if (!resolvedHost || !hostId || !resolvedHost.ssh_target) {
    throw new Error("Remote execution host is missing ssh_target metadata");
  }

  const rawRemoteCwd = resolveExecutionCwd({
    workspaceBinding: session?.workspace_binding,
    host: resolvedHost,
    currentHostId,
  });
  if (!rawRemoteCwd) {
    throw new Error(`Cannot resolve remote cwd for host ${hostId}`);
  }

  const rawRemoteInputRoot = path.posix.join(
    resolvedHost.worker_runtime_root || resolvedHost.repo_root || rawRemoteCwd,
    "remote-inputs",
    sanitizePathSegment(sessionKey || session?.session_key || hostId, hostId),
    buildRemoteInputRunSegment(),
  );
  const rawRemoteCodexBinPath = resolvedHost.codex_bin_path || codexBinPath;
  let remoteInputRoot = null;
  let execTask = null;
  try {
    const preparedPaths = await prepareRemoteExecPaths({
      codexBinPath: rawRemoteCodexBinPath,
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host: resolvedHost,
      hostId,
      remoteCwd: rawRemoteCwd,
      remoteInputRoot: rawRemoteInputRoot,
    });
    const {
      remoteCwd,
      remoteCodexBinPath,
    } = preparedPaths;
    remoteInputRoot = preparedPaths.remoteInputRoot;

    const stagedImagePaths = await stageExecImagesToRemote({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host: resolvedHost,
      imagePaths,
      platform,
      remoteInputRoot,
    });
    const args = buildCodexExecTaskArgs({
      cwd: remoteCwd,
      sessionThreadId,
      imagePaths: stagedImagePaths,
      model,
      modelProvider,
      modelProviderConfig,
      reasoningEffort,
      contextWindow,
      autoCompactTokenLimit,
      configOverrides,
      developerInstructions: resolveDeveloperInstructions({
        developerInstructions,
        baseInstructions,
      }),
    });
    const sshArgs = buildRemoteCodexExecSshArgs({
      host: resolvedHost,
      connectTimeoutSecs,
      codexBinPath: remoteCodexBinPath,
      args,
    });

    execTask = startExecChild({
      command: "ssh",
      args: sshArgs,
      prompt: buildCodexExecPrompt({ prompt }),
      onEvent,
      onWarning,
      onRuntimeState,
      jsonlLogPath,
      spawnImpl,
      platform,
      detached: platform !== "win32",
      sessionThreadId,
      streamCloseGraceMs,
    });
    return {
      ...execTask,
      finished: execTask.finished.finally(async () => {
        await cleanupRemoteInputRoot({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host: resolvedHost,
          remoteInputRoot,
        }).catch((error) => {
          onWarning?.(`Failed to clean remote exec input staging: ${error.message}`);
        });
      }),
    };
  } catch (error) {
    if (remoteInputRoot && !execTask) {
      await cleanupRemoteInputRoot({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host: resolvedHost,
        remoteInputRoot,
      }).catch((cleanupError) => {
        onWarning?.(`Failed to clean remote exec input staging: ${cleanupError.message}`);
      });
    }
    throw error;
  }
}

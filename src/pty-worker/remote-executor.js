import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import {
  buildSshBaseArgs,
  shellQuote,
} from "../hosts/host-command-runner.js";
import {
  buildRemoteInputRunSegment,
  cleanupRemoteInputRoot,
} from "../runtime/remote-codex-staging.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";
import {
  buildRpcError,
  buildRpcRequest,
  buildRpcResult,
  createRpcError,
  parseRpcLine,
} from "./remote-executor-contract.js";
import {
  createDeferred,
  createIdGenerator,
  createSerialMessageQueue,
  writeMessage,
} from "./remote-executor/rpc.js";
import {
  assertSafeRemoteGatewayRepoRoot,
  buildRemoteExecutorCommand,
  ensureRemoteDirectory,
  localizeRemoteInputItems,
  resolveRemoteExecutionCwd,
  sanitizePathSegment,
  stageImageToRemote,
  syncGatewayRepoToRemote,
} from "./remote-executor/staging.js";

export {
  assertSafeRemoteGatewayRepoRoot,
} from "./remote-executor/staging.js";

const REMOTE_EXECUTOR_START_TIMEOUT_MS = 20_000;
const REMOTE_EXECUTOR_STEER_TIMEOUT_MS = 20_000;
const REMOTE_EXECUTOR_STDERR_TAIL_LINES = 20;

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function buildRemoteStartRunParams({
  resolvedHost,
  codexBinPath,
  remoteCwd,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  localizedImagePaths = [],
  sessionKey = null,
  sessionThreadId = null,
  providerSessionId = null,
  knownRolloutPath = null,
  skipThreadHistoryLookup = false,
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
} = {}) {
  const normalizedDeveloperInstructions =
    normalizeOptionalText(developerInstructions)
    || normalizeOptionalText(baseInstructions);
  return {
    codexBinPath: resolvedHost?.codex_bin_path || codexBinPath,
    cwd: remoteCwd,
    prompt,
    ...(normalizedDeveloperInstructions
      ? {
          developerInstructions: normalizedDeveloperInstructions,
          baseInstructions: normalizedDeveloperInstructions,
        }
      : {}),
    imagePaths: Array.isArray(localizedImagePaths) ? localizedImagePaths : [],
    sessionKey,
    sessionThreadId,
    providerSessionId,
    knownRolloutPath,
    skipThreadHistoryLookup,
    model,
    modelProvider,
    modelProviderConfig,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    configOverrides,
  };
}

function rememberStderrLine(lines, line) {
  const normalized = String(line ?? "").trimEnd();
  if (!normalized) {
    return;
  }

  lines.push(normalized);
  if (lines.length > REMOTE_EXECUTOR_STDERR_TAIL_LINES) {
    lines.shift();
  }
}

function buildStartupErrorMessage(hostId, stderrTail, fallbackMessage) {
  if (stderrTail.length === 0) {
    return fallbackMessage;
  }

  return [
    fallbackMessage,
    `Recent remote executor stderr for ${hostId}:`,
    ...stderrTail,
  ].join("\n");
}

export async function runRemoteCodexTask({
  codexBinPath,
  connectTimeoutSecs,
  currentHostId,
  executionHost,
  host = executionHost?.host ?? null,
  imagePaths = [],
  knownRolloutPath = null,
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
  onEvent,
  onRuntimeState = null,
  onWarning,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  execFileImpl,
  providerSessionId = null,
  reasoningEffort = null,
  session,
  sessionKey = null,
  sessionThreadId = null,
  platform = process.platform,
  skipThreadHistoryLookup = false,
  spawnImpl,
}) {
  const resolvedHost = host || null;
  const hostId = normalizeOptionalText(executionHost?.hostId || resolvedHost?.host_id);
  if (!resolvedHost || !hostId || !resolvedHost.ssh_target) {
    throw new Error("Remote execution host is missing ssh_target metadata");
  }
  if (!resolvedHost.repo_root) {
    throw new Error(`Remote execution host ${hostId} is missing repo_root`);
  }
  assertSafeRemoteGatewayRepoRoot(resolvedHost.repo_root, hostId);
  if (!resolvedHost.worker_runtime_root) {
    throw new Error(`Remote execution host ${hostId} is missing worker_runtime_root`);
  }

  const remoteCwd = resolveRemoteExecutionCwd({
    currentHostId,
    host: resolvedHost,
    session,
  });
  if (!remoteCwd) {
    throw new Error(`Cannot resolve remote cwd for host ${hostId}`);
  }

  await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    directory: resolvedHost.repo_root,
    create: true,
  });
  await syncGatewayRepoToRemote({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    platform,
  });

  await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    directory: remoteCwd,
  }).catch((error) => {
    throw new Error(`Remote cwd is unavailable on ${hostId}: ${error.message}`);
  });

  const remoteInputRoot = path.posix.join(
    resolvedHost.worker_runtime_root,
    "remote-inputs",
    sanitizePathSegment(sessionKey || session?.session_key || hostId, hostId),
    buildRemoteInputRunSegment(),
  );
  const resolvedRemoteInputRoot = await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    directory: remoteInputRoot,
    create: true,
  });

  const cleanupRemoteInputs = async () => {
    await cleanupRemoteInputRoot({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host: resolvedHost,
      remoteInputRoot: resolvedRemoteInputRoot,
    }).catch((error) => {
      onWarning?.(`Failed to clean remote fallback input staging: ${error.message}`);
    });
  };

  let cleanupRegistered = false;
  try {
    const stagedImageCache = new Map();
    const localizedImagePaths = [];
    for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
      localizedImagePaths.push(
        await stageImageToRemote({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host: resolvedHost,
          imagePath,
          platform,
          remoteInputRoot: resolvedRemoteInputRoot,
          cache: stagedImageCache,
        }),
      );
    }

    const child = spawnRuntimeCommand(
      "ssh",
      [
        ...buildSshBaseArgs(resolvedHost.ssh_target, connectTimeoutSecs),
        `bash -c ${shellQuote(buildRemoteExecutorCommand(resolvedHost.repo_root))}`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: platform !== "win32",
        platform,
        spawnImpl,
      },
    );
    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });
    const nextRequestId = createIdGenerator("n");
    const pendingRequests = new Map();
    const remoteFinished = createDeferred();
    const stderrTail = [];
    let settled = false;
    const enqueueStdoutLine = createSerialMessageQueue();

    const settleRemote = (error, result = null) => {
      if (settled) {
        return;
      }

      settled = true;
      for (const pending of pendingRequests.values()) {
        pending.reject(error);
      }
      pendingRequests.clear();
      if (error) {
        remoteFinished.reject(error);
        return;
      }
      remoteFinished.resolve(result || {
        exitCode: 0,
        signal: null,
        threadId: null,
        warnings: [],
        resumeReplacement: null,
      });
    };

    const sendRequest = async (method, params, { timeoutMs = 0 } = {}) => {
      const id = nextRequestId();
      const deferred = createDeferred();
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          pendingRequests.delete(id);
          deferred.reject(new Error(`Remote executor request timed out: ${method}`));
        }, timeoutMs);
      }
      pendingRequests.set(id, {
        resolve: (value) => {
          if (timer) {
            clearTimeout(timer);
          }
          deferred.resolve(value);
        },
        reject: (error) => {
          if (timer) {
            clearTimeout(timer);
          }
          deferred.reject(error);
        },
        method,
      });
      try {
        await writeMessage(child.stdin, buildRpcRequest(id, method, params));
      } catch (error) {
        pendingRequests.delete(id);
        if (timer) {
          clearTimeout(timer);
        }
        throw error;
      }
      return deferred.promise;
    };

    const handleRequest = async (message) => {
      if (!message?.method || message.id === undefined) {
        return;
      }

      try {
        switch (message.method) {
          case "onRuntimeState":
            await onRuntimeState?.(message.params || {});
            await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
            return;
          case "onEvent":
            await onEvent?.(message.params?.summary ?? null, null);
            await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
            return;
          case "finished":
            await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
            settleRemote(null, message.params?.result || {
              exitCode: 0,
              signal: null,
              threadId: null,
              warnings: [],
              resumeReplacement: null,
            });
            return;
          case "failed":
            await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
            settleRemote(
              createRpcError(
                message.params?.error || {
                  message: message.params?.message || "Remote executor failed",
                },
                "Remote executor failed",
              ),
            );
            return;
          default:
            await writeMessage(
              child.stdin,
              buildRpcError(
                message.id,
                { message: `Unknown remote executor method: ${message.method}` },
                "Unknown remote executor method",
              ),
            );
        }
      } catch (error) {
        await writeMessage(
          child.stdin,
          buildRpcError(
            message.id,
            error,
            `Remote executor callback failed: ${message.method}`,
          ),
        ).catch(() => {});
        if (message.method === "finished" || message.method === "failed") {
          settleRemote(error);
        }
      }
    };

    stdoutReader.on("line", (line) => {
      enqueueStdoutLine(
        async () => {
          const message = parseRpcLine(line);
          if (!message) {
            return;
          }

          if (message.method) {
            await handleRequest(message);
            return;
          }

          const pending = pendingRequests.get(message.id);
          if (!pending) {
            return;
          }

          pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(
              createRpcError(
                message.error,
                `Remote executor request failed: ${pending.method}`,
              ),
            );
            return;
          }

          pending.resolve(message.result ?? null);
        },
        (error) => {
          settleRemote(error);
        },
      );
    });

    stderrReader.on("line", (line) => {
      rememberStderrLine(stderrTail, line);
      onWarning?.(`[remote:${hostId}] ${line}`);
    });

    child.on("error", (error) => {
      settleRemote(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settleRemote(
        new Error(
          buildStartupErrorMessage(
            hostId,
            stderrTail,
            `Remote executor exited before finishing (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        ),
      );
    });

    try {
      await sendRequest(
        "startRun",
        buildRemoteStartRunParams({
          resolvedHost,
          codexBinPath,
          remoteCwd,
          prompt,
          developerInstructions,
          baseInstructions,
          localizedImagePaths,
          sessionKey,
          sessionThreadId,
          providerSessionId,
          knownRolloutPath,
          skipThreadHistoryLookup,
          model,
          modelProvider,
          modelProviderConfig,
          reasoningEffort,
          contextWindow,
          autoCompactTokenLimit,
          configOverrides,
        }),
        {
          timeoutMs: REMOTE_EXECUTOR_START_TIMEOUT_MS,
        },
      );
    } catch (error) {
      signalChildProcessTree(child, "SIGTERM", { platform });
      throw error;
    }

    cleanupRegistered = true;
    return {
      child,
      finished: remoteFinished.promise.finally(cleanupRemoteInputs),
      async steer({ input } = {}) {
        const localizedInput = await localizeRemoteInputItems({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host: resolvedHost,
          input,
          platform,
          remoteInputRoot: resolvedRemoteInputRoot,
          cache: stagedImageCache,
        });
        return sendRequest(
          "steer",
          {
            input: localizedInput,
          },
          {
            timeoutMs: REMOTE_EXECUTOR_STEER_TIMEOUT_MS,
          },
        );
      },
      interrupt({ threadId, turnId } = {}) {
        return sendRequest("interrupt", { threadId, turnId })
          .then((result) => Boolean(result))
          .catch(() => false);
      },
    };
  } catch (error) {
    if (!cleanupRegistered) {
      await cleanupRemoteInputs();
    }
    throw error;
  }
}

import path from "node:path";

import {
  buildRemoteCodexStdioSshArgs,
  buildRemoteInputRunSegment,
  cleanupRemoteInputRoot,
  localizeRemoteInputItems,
  prepareRemoteExecPaths,
  sanitizePathSegment,
  stageExecImagesToRemote,
} from "../runtime/remote-codex-staging.js";
import { resolveExecutionCwd } from "../hosts/host-paths.js";
import { buildCodexAppServerV2Args } from "./app-server-v2-args.js";
import { runCodexAppServerV2Task } from "./app-server-v2-runner.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export async function runRemoteCodexAppServerV2Task({
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
  onServerRequest = null,
  onWarning,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  execFileImpl,
  reasoningEffort = null,
  session,
  sessionKey = null,
  sessionThreadId = null,
  knownRolloutPath = null,
  spawnImpl,
  platform = process.platform,
  appServerBootTimeoutMs,
  appServerControlTimeoutMs,
  appServerShutdownGraceMs,
  steerRequestTimeoutMs,
  steerActiveTurnRefreshRetryDelaysMs,
  turnCompletionFinalMessageGraceMs,
  goalContinuationStartTimeoutMs,
  goalStart = null,
  jsonlLogPath = null,
}) {
  const resolvedHost = host || null;
  const hostId = normalizeOptionalText(executionHost?.hostId || resolvedHost?.host_id);
  if (!resolvedHost || !hostId || !resolvedHost.ssh_target) {
    throw new Error("Remote app-server-v2 host is missing ssh_target metadata");
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
  let task = null;
  const stagedImageCache = new Map();
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
      cache: stagedImageCache,
    });
    const appServerArgs = buildCodexAppServerV2Args({
      model,
      modelProvider,
      modelProviderConfig,
      reasoningEffort,
      contextWindow,
      autoCompactTokenLimit,
      configOverrides,
    });
    const sshArgs = buildRemoteCodexStdioSshArgs({
      host: resolvedHost,
      connectTimeoutSecs,
      codexBinPath: remoteCodexBinPath,
      args: appServerArgs,
    });

    task = runCodexAppServerV2Task({
      codexBinPath: "ssh",
      cwd: remoteCwd,
      prompt,
      developerInstructions,
      baseInstructions,
      sessionThreadId,
      knownRolloutPath,
      imagePaths: stagedImagePaths,
      onEvent,
      onRuntimeState,
      onServerRequest,
      onWarning,
      spawnImpl,
      platform,
      spawnCommand: "ssh",
      spawnArgs: sshArgs,
      spawnCwd: process.cwd(),
      appServerBootTimeoutMs,
      appServerControlTimeoutMs,
      appServerShutdownGraceMs,
      steerRequestTimeoutMs,
      steerActiveTurnRefreshRetryDelaysMs,
      turnCompletionFinalMessageGraceMs,
      goalContinuationStartTimeoutMs,
      goalStart,
      jsonlLogPath,
      model,
      modelProvider,
      modelProviderConfig,
      reasoningEffort,
      contextWindow,
      autoCompactTokenLimit,
      configOverrides,
    });

    return {
      ...task,
      async steer({ input } = {}) {
        const localizedInput = await localizeRemoteInputItems({
          connectTimeoutSecs,
          execFileImpl,
          host: resolvedHost,
          input,
          platform,
          remoteInputRoot,
          cache: stagedImageCache,
        });
        return task.steer({ input: localizedInput });
      },
      finished: task.finished.finally(async () => {
        await cleanupRemoteInputRoot({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host: resolvedHost,
          remoteInputRoot,
        }).catch((error) => {
          onWarning?.(`Failed to clean remote app-server-v2 input staging: ${error.message}`);
        });
      }),
    };
  } catch (error) {
    if (remoteInputRoot && !task) {
      await cleanupRemoteInputRoot({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host: resolvedHost,
        remoteInputRoot,
      }).catch((error) => {
        onWarning?.(`Failed to clean remote app-server-v2 input staging: ${error.message}`);
      });
    }
    throw error;
  }
}

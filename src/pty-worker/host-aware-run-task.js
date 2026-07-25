import { runCodexTask } from "./codex-runner.js";
import { runRemoteCodexTask } from "./remote-executor.js";
import {
  CODEX_APP_SERVER_V2_BACKEND,
  runCodexAppServerV2Task,
} from "../app-server-v2/app-server-v2-runner.js";
import { runRemoteCodexAppServerV2Task } from "../app-server-v2/remote-app-server-v2-runner.js";
import {
  CODEX_EXEC_BACKEND,
  runCodexExecTask,
  runRemoteCodexExecTask,
} from "../codex-exec/telegram-exec-runner.js";
import {
  DEEPSEEK_HTTP_BACKEND,
  runRemoteDeepSeekHttpTask,
} from "../deepseek-runtime/deepseek-http-runner.js";

const CODEX_APP_SERVER_BACKEND = "app-server";

function normalizeCodexGatewayBackend(
  value,
  {
    legacyAppServerEnabled = false,
    legacyExecJsonEnabled = false,
    appServerV2Enabled = false,
  } = {},
) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return CODEX_EXEC_BACKEND;
  }
  if (normalized === CODEX_EXEC_BACKEND) {
    if (legacyExecJsonEnabled) {
      return CODEX_EXEC_BACKEND;
    }
    throw new Error(
      "TELEDEX_BACKEND=exec-json is legacy compatibility only; public Teledex requires Codez App Server v2. Set TELEDEX_ENABLE_LEGACY_EXEC_JSON=1 only for explicit compatibility tests.",
    );
  }
  if (normalized === CODEX_APP_SERVER_BACKEND) {
    if (!legacyAppServerEnabled) {
      throw new Error(
        "TELEDEX_BACKEND=app-server requires TELEDEX_ENABLE_LEGACY_APP_SERVER=1.",
      );
    }
    return CODEX_APP_SERVER_BACKEND;
  }
  if (normalized === CODEX_APP_SERVER_V2_BACKEND) {
    if (!appServerV2Enabled) {
      throw new Error(
        "TELEDEX_BACKEND=app-server-v2 requires TELEDEX_ENABLE_APP_SERVER_V2=1.",
      );
    }
    return CODEX_APP_SERVER_V2_BACKEND;
  }

  throw new Error(`Unsupported Teledex backend: ${value}`);
}

export function createHostAwareRunTask({
  config,
  hostRegistryService,
  runLocalTask = runCodexTask,
  runLocalAppServerV2Task = runCodexAppServerV2Task,
  runRemoteTask = runRemoteCodexTask,
  runLocalExecTask = runCodexExecTask,
  runRemoteExecTask = runRemoteCodexExecTask,
  runRemoteAppServerV2Task = runRemoteCodexAppServerV2Task,
  runRemoteDeepSeekTask = runRemoteDeepSeekHttpTask,
} = {}) {
  const backend = normalizeCodexGatewayBackend(
    config?.codexGatewayBackend || CODEX_APP_SERVER_V2_BACKEND,
    {
      legacyAppServerEnabled:
        config?.codexEnableLegacyAppServer === true
        || config?.enableLegacyAppServerBackend === true,
      legacyExecJsonEnabled:
        config?.codexEnableLegacyExecJson === true
        || config?.enableLegacyExecJsonBackend === true,
      appServerV2Enabled:
        config?.codexEnableAppServerV2 === true
        || config?.enableAppServerV2Backend === true
        || !config?.codexGatewayBackend,
    },
  );
  const localTask = backend === CODEX_EXEC_BACKEND
    ? runLocalExecTask
    : backend === CODEX_APP_SERVER_V2_BACKEND
      ? runLocalAppServerV2Task
      : runLocalTask;
  const remoteTask = backend === CODEX_EXEC_BACKEND
    ? runRemoteExecTask
    : runRemoteTask;

  return async function hostAwareRunTask(args = {}) {
    const executionHost = args.executionHost
      || (typeof hostRegistryService?.resolveSessionExecution === "function" && args.session
        ? await hostRegistryService.resolveSessionExecution(args.session)
        : null);
    if (executionHost?.ok === false) {
      const hostLabel = executionHost.hostLabel || executionHost.hostId || "unknown";
      const error = new Error(`Execution host unavailable: ${hostLabel}`);
      error.code = "EXECUTION_HOST_UNAVAILABLE";
      error.hostId = executionHost.hostId || null;
      error.hostLabel = hostLabel;
      error.failureReason = executionHost.failureReason || "host-unavailable";
      throw error;
    }
    const isLocal = executionHost?.isLocal !== false;

    if (!executionHost || isLocal) {
      if (args.runtimeBackend === DEEPSEEK_HTTP_BACKEND) {
        throw new Error("DeepSeek HTTP runtime profile requires a remote execution host");
      }
      return localTask(args);
    }

    if (args.runtimeBackend === DEEPSEEK_HTTP_BACKEND) {
      return runRemoteDeepSeekTask({
        ...args,
        connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
        currentHostId: config.currentHostId,
        executionHost,
      });
    }

    if (backend === CODEX_APP_SERVER_V2_BACKEND) {
      return runRemoteAppServerV2Task({
        ...args,
        connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
        currentHostId: config.currentHostId,
        executionHost,
      });
    }

    return remoteTask({
      ...args,
      connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
      currentHostId: config.currentHostId,
      executionHost,
    });
  };
}

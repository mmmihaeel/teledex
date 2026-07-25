import readline from "node:readline";

import {
  buildRemoteCodexStdioSshArgs,
  prepareRemoteExecPaths,
} from "../runtime/remote-codex-staging.js";
import { resolveExecutionCwd } from "../hosts/host-paths.js";
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
import { buildCodexAppServerV2Args } from "./app-server-v2-args.js";
import { createJsonLineRpcClient } from "./jsonl-rpc-client.js";

const GOAL_CONTROL_TIMEOUT_MS = 15000;
const GOAL_CONTROL_SHUTDOWN_GRACE_MS = 3000;
const GOAL_THREAD_RESUME_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function buildThreadResumeParams({ threadId, cwd, rolloutPath = null }) {
  return {
    threadId,
    ...(rolloutPath ? { path: rolloutPath } : {}),
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

function stopChild(child, platform, graceMs = GOAL_CONTROL_SHUTDOWN_GRACE_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChildProcessTree(child, "SIGTERM", { platform });
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signalChildProcessTree(child, "SIGKILL", { platform });
    }
  }, graceMs).unref();
}

function createUnsupportedServerRequestError(method) {
  const error = new Error(`Unsupported app-server server request during goal RPC: ${method}`);
  error.code = -32601;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableThreadResumeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("failed to resolve rollout path");
}

async function resolveGoalProcessLaunch({
  codexBinPath,
  config,
  connectTimeoutSecs = config?.hostSshConnectTimeoutSecs ?? 8,
  currentHostId = config?.currentHostId ?? null,
  executionHost,
  execFileImpl,
  session,
}) {
  const host = executionHost?.host ?? null;
  const isLocal = !executionHost || executionHost.isLocal !== false;
  if (isLocal) {
    const cwd = normalizeOptionalText(session?.workspace_binding?.cwd)
      || normalizeOptionalText(config?.workspaceRootPath)
      || process.cwd();
    return {
      command: codexBinPath,
      args: buildCodexAppServerV2Args(),
      cwd,
      threadCwd: cwd,
    };
  }

  const hostId = normalizeOptionalText(executionHost?.hostId || host?.host_id);
  if (!host || !hostId || !host.ssh_target) {
    throw new Error("Remote app-server-v2 goal host is missing ssh_target metadata");
  }

  const rawRemoteCwd = resolveExecutionCwd({
    workspaceBinding: session?.workspace_binding,
    host,
    currentHostId,
  });
  if (!rawRemoteCwd) {
    throw new Error(`Cannot resolve remote cwd for host ${hostId}`);
  }

  const rawRemoteInputRoot = host.worker_runtime_root || host.repo_root || rawRemoteCwd;
  const rawRemoteCodexBinPath = host.codex_bin_path || codexBinPath;
  const {
    remoteCwd,
    remoteCodexBinPath,
  } = await prepareRemoteExecPaths({
    codexBinPath: rawRemoteCodexBinPath,
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    hostId,
    remoteCwd: rawRemoteCwd,
    remoteInputRoot: rawRemoteInputRoot,
  });

  return {
    command: "ssh",
    args: buildRemoteCodexStdioSshArgs({
      host,
      connectTimeoutSecs,
      codexBinPath: remoteCodexBinPath,
      args: buildCodexAppServerV2Args(),
    }),
    cwd: process.cwd(),
    threadCwd: remoteCwd,
  };
}

export async function runCodexAppServerV2GoalRpc({
  action,
  codexBinPath,
  config = {},
  execFileImpl,
  executionHost = null,
  modelProviderConfig = null,
  objective = null,
  platform = process.platform,
  session,
  spawnImpl,
  status = null,
  tokenBudget = undefined,
}) {
  const threadId = normalizeOptionalText(session?.codex_thread_id);
  if (!threadId) {
    throw new Error("No app-server-v2 thread is available for /goal");
  }

  const launch = await resolveGoalProcessLaunch({
    codexBinPath,
    config,
    executionHost,
    execFileImpl,
    session,
  });
  const child = spawnRuntimeCommand(launch.command, launch.args, {
    cwd: launch.cwd,
    env: buildCodexChildEnv(process.env, {
      extraAllowedEnvNames: getCodexProviderEnvKeyNames(modelProviderConfig),
      platform,
    }),
    platform,
    stdio: ["pipe", "pipe", "pipe"],
    detached: platform !== "win32",
    spawnImpl,
  });
  let childError = null;
  const childErrorPromise = new Promise((_, reject) => {
    child.once("error", (error) => {
      childError = error;
      reject(error);
    });
  });
  childErrorPromise.catch(() => {});
  const withChildError = (promise) => {
    if (childError) {
      return Promise.reject(childError);
    }
    return Promise.race([promise, childErrorPromise]);
  };
  const warnings = [];
  const stderrReader = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });
  stderrReader.on("line", (line) => {
    const normalized = normalizeOptionalText(line);
    if (normalized) {
      warnings.push(normalized);
    }
  });
  const rpc = createJsonLineRpcClient({
    input: child.stdout,
    output: child.stdin,
    label: "Codex app-server-v2 goal",
    onRequest({ method }) {
      throw createUnsupportedServerRequestError(method);
    },
    onWarning(message) {
      warnings.push(message);
    },
  });

  try {
    await withChildError(rpc.request("initialize", {
      clientInfo: {
        name: TELEDEX_APP_NAME,
        title: TELEDEX_DISPLAY_NAME,
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    }, {
      timeoutMs: GOAL_CONTROL_TIMEOUT_MS,
    }));
    rpc.notify("initialized");
    const resumeParams = buildThreadResumeParams({
      threadId,
      cwd: launch.threadCwd,
      rolloutPath: normalizeOptionalText(session?.codex_rollout_path),
    });
    for (let attempt = 0; attempt <= GOAL_THREAD_RESUME_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await withChildError(rpc.request("thread/resume", resumeParams, {
          timeoutMs: GOAL_CONTROL_TIMEOUT_MS,
        }));
        break;
      } catch (error) {
        if (
          !isRetryableThreadResumeError(error)
          || attempt >= GOAL_THREAD_RESUME_RETRY_DELAYS_MS.length
        ) {
          throw error;
        }
        await sleep(GOAL_THREAD_RESUME_RETRY_DELAYS_MS[attempt]);
      }
    }

    let result;
    if (action === "get") {
      result = await withChildError(rpc.request("thread/goal/get", { threadId }, {
        timeoutMs: GOAL_CONTROL_TIMEOUT_MS,
      }));
    } else if (action === "clear") {
      result = await withChildError(rpc.request("thread/goal/clear", { threadId }, {
        timeoutMs: GOAL_CONTROL_TIMEOUT_MS,
      }));
    } else if (action === "set") {
      result = await withChildError(rpc.request("thread/goal/set", {
        threadId,
        ...(objective !== null && objective !== undefined ? { objective } : {}),
        ...(status !== null && status !== undefined ? { status } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      }, {
        timeoutMs: GOAL_CONTROL_TIMEOUT_MS,
      }));
    } else {
      throw new Error(`Unsupported app-server-v2 goal action: ${action}`);
    }

    return {
      result,
      warnings,
    };
  } finally {
    try {
      rpc.close();
    } catch {}
    stopChild(child, platform);
  }
}

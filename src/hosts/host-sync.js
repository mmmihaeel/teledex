import path from "node:path";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";

import { writeTextAtomic } from "../state/file-utils.js";
import { captureHostModelsCacheSnapshot } from "./codex-model-catalog.js";
import { renderCodexSpace, getCodexSpaceLayout } from "./teledex-context.js";
import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "./host-command-runner.js";

async function syncRenderedDirectory({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  localDirectory,
  remoteDirectory,
}) {
  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remoteDirectory)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'mkdir -p "$target"',
      'printf "%s\\n" "$target"',
    ].join("; "),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  });
  const resolvedRemoteDirectory = stdout.trim().split("\n").at(-1) || remoteDirectory;
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      normalizeRsyncLocalPath(`${localDirectory}${path.sep}`),
      buildRsyncRemotePath(host.ssh_target, `${resolvedRemoteDirectory}/`),
    ],
    {
      execFileImpl,
      timeoutMs: 30_000,
    },
  );
}

async function directoryExists(directory) {
  try {
    const stat = await fs.stat(directory);
    return stat.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function requireDirectory(directory, label) {
  if (!await directoryExists(directory)) {
    throw new Error(`${label} does not exist: ${directory}`);
  }
}

async function syncWorkspaceManifestMirror({
  registryMirrorRoot,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
}) {
  if (!registryMirrorRoot) {
    return;
  }

  const localMirror = path.join(registryMirrorRoot, host.host_id);
  const workspaceRoot = host.workspace_root || "~/workspace";
  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(workspaceRoot)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'printf "%s\\n" "$target"',
    ].join("; "),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  });
  const resolvedWorkspaceRoot = stdout.trim().split("\n").at(-1) || workspaceRoot;
  await fs.mkdir(localMirror, { recursive: true });
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      "--prune-empty-dirs",
      "--include=*/",
      "--include=project.toml",
      "--exclude=*",
      buildRsyncRemotePath(host.ssh_target, `${resolvedWorkspaceRoot}/`),
      normalizeRsyncLocalPath(`${localMirror}${path.sep}`),
    ],
    {
      execFileImpl,
      timeoutMs: 30_000,
    },
  );
}

export async function runHostSync({
  registryMirrorRoot = null,
  workspaceSkillsRoot = null,
  codexSpaceRoot,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  registryService,
  targetHostId = null,
}) {
  if (currentHostId !== "local") {
    throw new Error("Host sync is only supported from local");
  }

  const hosts = await registryService.listHosts({ allowStaleFallback: false });
  const { layout } = await renderCodexSpace({
    codexSpaceRoot,
    currentHostId,
    hosts,
  });
  const selectedHosts = targetHostId
    ? hosts.filter((host) => host.host_id === targetHostId)
    : hosts.filter((host) => host.host_id !== currentHostId);

  if (targetHostId && selectedHosts.length === 0) {
    throw new Error(`Unknown host for sync: ${targetHostId}`);
  }

  const results = [];
  const normalizedWorkspaceSkillsRoot =
    typeof workspaceSkillsRoot === "string" && workspaceSkillsRoot.trim()
      ? workspaceSkillsRoot.trim()
      : null;
  const normalizedWorkspaceScoutMirrorRoot =
    typeof registryMirrorRoot === "string" && registryMirrorRoot.trim()
      ? registryMirrorRoot.trim()
      : null;
  const shouldSyncWorkspaceSkills = Boolean(normalizedWorkspaceSkillsRoot);
  if (shouldSyncWorkspaceSkills) {
    await requireDirectory(normalizedWorkspaceSkillsRoot, "workspace skills root");
  }
  const currentHost = hosts.find((host) => host.host_id === currentHostId);
  if (currentHost) {
    await captureHostModelsCacheSnapshot({
      codexSpaceRoot,
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host: currentHost,
    });
  }

  for (const host of selectedHosts) {
    if (host.enabled === false) {
      results.push({
        host_id: host.host_id,
        status: "skipped",
        reason: host.failure_reason || "host-disabled",
      });
      continue;
    }
    if (!host.ssh_target) {
      results.push({
        host_id: host.host_id,
        status: "skipped",
        reason: "missing-ssh-target",
      });
      continue;
    }
    if (!host.worker_runtime_root) {
      results.push({
        host_id: host.host_id,
        status: "skipped",
        reason: "missing-worker-runtime-root",
      });
      continue;
    }

    const localSharedRendered = layout.sharedRendered;
    const localHostRendered = getCodexSpaceLayout(
      codexSpaceRoot,
      host.host_id,
    ).hostRendered;
    const remoteBase = path.posix.join(host.worker_runtime_root, "teledex-context");
    const remoteSharedRendered = path.posix.join(remoteBase, "shared", "rendered");
    const remoteHostRendered = path.posix.join(
      remoteBase,
      "hosts",
      host.host_id,
      "rendered",
    );

    try {
      await captureHostModelsCacheSnapshot({
        codexSpaceRoot,
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
      });
      await syncWorkspaceManifestMirror({
        registryMirrorRoot: normalizedWorkspaceScoutMirrorRoot,
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
      });
      await syncRenderedDirectory({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        localDirectory: localSharedRendered,
        remoteDirectory: remoteSharedRendered,
      });
      await syncRenderedDirectory({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        localDirectory: localHostRendered,
        remoteDirectory: remoteHostRendered,
      });
      if (shouldSyncWorkspaceSkills) {
        await syncRenderedDirectory({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host,
          localDirectory: normalizedWorkspaceSkillsRoot,
          remoteDirectory: path.posix.join(
            host.workspace_root || "~/workspace",
            ".teledex", "workflow-skills",
          ),
        });
      }
      results.push({
        host_id: host.host_id,
        status: "synced",
        reason: null,
      });
    } catch (error) {
      results.push({
        host_id: host.host_id,
        status: "failed",
        reason: String(error?.stderr || error?.message || "sync failed").trim() || "sync failed",
      });
    }
  }

  await writeTextAtomic(
    path.join(hostsRoot, "sync-last-run.json"),
    `${JSON.stringify({
      ran_at: new Date().toISOString(),
      current_host_id: currentHostId,
      results,
    }, null, 2)}\n`,
  );

  return results;
}

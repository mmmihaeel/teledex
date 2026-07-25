import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
} from "../hosts/host-command-runner.js";
import { translateWorkspacePathForHost } from "../hosts/host-paths.js";
import { sanitizeFileName } from "../telegram/file-name-sanitizer.js";

export async function resolveExistingRealPath(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function isPathInsideRoot(targetPath, rootPath) {
  return isPathInsideRootWithModule(targetPath, rootPath, path);
}

function isPathInsideRootWithModule(targetPath, rootPath, pathModule) {
  const relativePath = pathModule.relative(rootPath, targetPath);
  return (
    relativePath === ""
    || (!relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath))
  );
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export async function resolveRemoteDeliveryHost(pool, session) {
  const hostId = normalizeOptionalText(session?.execution_host_id);
  if (!hostId) {
    return null;
  }

  const currentHostId = normalizeOptionalText(pool?.config?.currentHostId);
  if (currentHostId && hostId === currentHostId) {
    return null;
  }

  if (typeof pool?.hostRegistryService?.getHost !== "function") {
    return null;
  }

  const host = await pool.hostRegistryService.getHost(hostId);
  if (!host?.ssh_target) {
    return null;
  }

  return host;
}

function resolveRemoteDocumentDeliveryRoots(pool, session, host) {
  const currentHostId = normalizeOptionalText(pool?.config?.currentHostId);
  const roots = [
    translateWorkspacePathForHost(
      session.workspace_binding?.worktree_path ?? null,
      {
        workspaceBinding: session.workspace_binding,
        host,
        currentHostId,
      },
    ),
    translateWorkspacePathForHost(
      session.workspace_binding?.cwd ?? null,
      {
        workspaceBinding: session.workspace_binding,
        host,
        currentHostId,
      },
    ),
  ].filter(Boolean);
  if (pool?.config?.allowSystemTempDelivery === true) {
    roots.push("/tmp");
  }
  return roots;
}

export function buildOutsideDeliveryRootsMessage(_language, { remote = false } = {}) {
  return remote
    ? "path is outside allowed delivery roots; copy the file into the bound host worktree first"
    : "path is outside allowed delivery roots; copy the file into the worktree or session state first";
}

export async function stageRemoteDocumentForDelivery(
  pool,
  session,
  filePath,
  document,
  language,
) {
  const host = await resolveRemoteDeliveryHost(pool, session);
  if (!host) {
    return null;
  }

  const remoteAllowedRoots = resolveRemoteDocumentDeliveryRoots(pool, session, host);
  if (
    !remoteAllowedRoots.some((rootPath) =>
      isPathInsideRootWithModule(filePath, path.posix.normalize(rootPath), path.posix),
    )
  ) {
    return {
      failure: buildOutsideDeliveryRootsMessage(language, { remote: true }),
    };
  }

  const localStageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-remote-document-"),
  );
  const localFilePath = path.join(
    localStageDir,
    typeof document?.fileName === "string" && document.fileName.trim()
      ? sanitizeFileName(document.fileName.trim(), "file")
      : sanitizeFileName(path.posix.basename(filePath), "file"),
  );
  try {
    await runCommand(
      "rsync",
      [
        ...buildRsyncBaseArgs(pool?.config?.hostSshConnectTimeoutSecs || 10),
        buildRsyncRemotePath(host.ssh_target, filePath),
        normalizeRsyncLocalPath(localFilePath),
      ],
      {
        execFileImpl:
          typeof pool?.config?.hostExecFileImpl === "function"
            ? pool.config.hostExecFileImpl
            : undefined,
        timeoutMs: 30_000,
      },
    );
  } catch (error) {
    await fs.rm(localStageDir, { recursive: true, force: true }).catch(() => null);
    const details = String(error?.stderr || error?.message || "").trim();
    return {
      failure: details || `file not found on host ${host.host_id}: ${filePath}`,
    };
  }

  return {
    resolvedFilePath: await fs.realpath(localFilePath),
    stageDir: localStageDir,
  };
}

export async function resolveDocumentDeliveryRoots(pool, session) {
  const candidates = [
    session.workspace_binding?.worktree_path ?? null,
    session.workspace_binding?.cwd ?? null,
    typeof pool.sessionStore?.getSessionDir === "function"
      ? pool.sessionStore.getSessionDir(session.chat_id, session.topic_id)
      : null,
  ].filter(Boolean);
  if (pool?.config?.allowSystemTempDelivery === true) {
    candidates.push(os.tmpdir());
  }
  const roots = [];

  for (const candidate of candidates) {
    const resolved = await resolveExistingRealPath(candidate);
    if (resolved && !roots.includes(resolved)) {
      roots.push(resolved);
    }
  }

  return roots;
}

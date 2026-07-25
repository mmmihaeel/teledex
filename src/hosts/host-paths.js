import path from "node:path";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function isAbsolutePosixPath(value) {
  return String(value || "").startsWith("/");
}

function inferHomePathFromHostRoot(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized || !isAbsolutePosixPath(normalized)) {
    return null;
  }

  if (normalized === "/workspace/project") {
    return null;
  }
  if (normalized.endsWith("/workspace/project")) {
    return normalized.slice(0, -"/workspace/project".length) || "/";
  }
  if (normalized.endsWith("/teledex-state")) {
    return normalized.slice(0, -"/teledex-state".length) || "/";
  }
  return null;
}

function inferHomePathFromKnownPath(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized || !isAbsolutePosixPath(normalized)) {
    return null;
  }

  for (const marker of ["/teledex-state/", "/workspace/project/"]) {
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex > 0) {
      return normalized.slice(0, markerIndex) || "/";
    }
  }
  return null;
}

function inferHostHomePath(host) {
  return (
    normalizeOptionalText(host?.home_path)
    || normalizeOptionalText(host?.homePath)
    || inferHomePathFromHostRoot(host?.host_root)
    || inferHomePathFromHostRoot(host?.state_root)
    || inferHomePathFromKnownPath(host?.codex_bin_path)
    || inferHomePathFromKnownPath(host?.worker_runtime_root)
    || inferHomePathFromKnownPath(host?.repo_root)
    || inferHomePathFromKnownPath(host?.workspace_root)
    || (normalizeOptionalText(host?.host_user)
      ? path.posix.join("/home", normalizeOptionalText(host.host_user))
      : null)
  );
}

export function expandHostHomePath(value, host) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }
  const homePath = inferHostHomePath(host);
  if (normalized === "~") {
    return homePath;
  }
  if (normalized.startsWith("~/")) {
    if (!homePath) {
      return null;
    }
    return path.posix.join(homePath, normalized.slice(2));
  }
  return normalized;
}

function isSameOrDescendantPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toPosixRelativePath(value) {
  return String(value || ".").replace(/\\/gu, "/");
}

function resolveWorkspaceRelativePath(workspaceBinding, absolutePath) {
  const normalizedAbsolutePath = normalizeOptionalText(absolutePath);
  const workspaceRootPath = normalizeOptionalText(
    workspaceBinding?.workspace_root_path,
  );
  if (!normalizedAbsolutePath || !workspaceRootPath) {
    return null;
  }

  if (!isSameOrDescendantPath(workspaceRootPath, normalizedAbsolutePath)) {
    return null;
  }

  return toPosixRelativePath(path.relative(workspaceRootPath, normalizedAbsolutePath) || ".");
}

export function resolveBindingRelativeCwd(workspaceBinding) {
  const explicitRelativePath = normalizeOptionalText(
    workspaceBinding?.cwd_relative_to_workspace_root,
  );
  if (explicitRelativePath) {
    return explicitRelativePath;
  }

  return resolveWorkspaceRelativePath(
    workspaceBinding,
    workspaceBinding?.cwd,
  );
}

export function translateWorkspacePathForHost(
  absolutePath,
  {
    workspaceBinding,
    host,
    currentHostId,
  },
) {
  const normalizedAbsolutePath = normalizeOptionalText(absolutePath);
  const normalizedWorkspaceRoot = normalizeOptionalText(host?.workspace_root);
  const normalizedHostId = normalizeOptionalText(host?.host_id);
  const normalizedCurrentHostId = normalizeOptionalText(currentHostId);
  const hostWorkspaceRoot = expandHostHomePath(normalizedWorkspaceRoot, host);

  if (!normalizedAbsolutePath) {
    return null;
  }
  if (normalizedHostId && normalizedHostId === normalizedCurrentHostId) {
    return normalizedAbsolutePath;
  }
  if (!hostWorkspaceRoot) {
    return null;
  }

  const relativePath = resolveWorkspaceRelativePath(
    workspaceBinding,
    normalizedAbsolutePath,
  );
  if (!relativePath) {
    return null;
  }

  return relativePath === "."
    ? hostWorkspaceRoot
    : path.posix.join(hostWorkspaceRoot, toPosixRelativePath(relativePath));
}

export function resolveExecutionCwd({
  workspaceBinding,
  host,
  currentHostId,
}) {
  const normalizedHostId = normalizeOptionalText(host?.host_id);
  const normalizedCurrentHostId = normalizeOptionalText(currentHostId);
  const localCwd = normalizeOptionalText(workspaceBinding?.cwd);

  if (normalizedHostId && normalizedHostId === normalizedCurrentHostId) {
    return localCwd;
  }

  const hostWorkspaceRoot = expandHostHomePath(host?.workspace_root, host);
  if (!hostWorkspaceRoot) {
    return null;
  }

  const relativeCwd = resolveBindingRelativeCwd(workspaceBinding);
  if (!relativeCwd) {
    return null;
  }

  return relativeCwd === "."
    ? hostWorkspaceRoot
    : path.posix.join(
        hostWorkspaceRoot,
        toPosixRelativePath(relativeCwd),
      );
}

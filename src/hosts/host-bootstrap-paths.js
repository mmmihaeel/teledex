import os from "node:os";
import path from "node:path";

export function expandHomePath(value, homeDir = os.homedir()) {
  if (!value) {
    return null;
  }

  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return joinHomePath(homeDir, value.slice(2));
  }

  return value;
}

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/u.test(String(value || "")) || String(value || "").includes("\\");
}

function joinHomePath(homeDir, childPath) {
  if (isWindowsPath(homeDir)) {
    return path.join(homeDir, childPath);
  }

  return path.posix.join(homeDir, String(childPath || "").replace(/\\/gu, "/"));
}

function replaceAll(text, sourceValue, targetValue) {
  if (!sourceValue || sourceValue === targetValue) {
    return text;
  }
  return text.split(sourceValue).join(targetValue);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeRemoteTargetPathSeparators(text, targetValues) {
  const remotePrefixes = Array.from(new Set(
    targetValues
      .filter((value) => typeof value === "string" && value.startsWith("/"))
      .sort((left, right) => right.length - left.length),
  ));
  let normalized = text;
  for (const prefix of remotePrefixes) {
    normalized = normalized.replace(
      new RegExp(`${escapeRegExp(prefix)}[^"\\r\\n]*`, "gu"),
      (match) => match.replace(/\\/gu, "/"),
    );
  }
  return normalized;
}

export function resolveHostStateRoot(host, remoteHomePath) {
  if (host.state_root) {
    return host.state_root;
  }

  const runtimeRoot = host.worker_runtime_root || null;
  const runtimeMarkers = [
    "/apps/teledex",
  ];
  for (const runtimeMarker of runtimeMarkers) {
    if (runtimeRoot?.endsWith(runtimeMarker)) {
      return runtimeRoot.slice(0, -runtimeMarker.length);
    }
  }

  return remoteHomePath
    ? path.posix.join(remoteHomePath, ".local", "state")
    : "~/.local/state";
}

export function normalizeCodexConfigText(
  configText,
  {
    sourceCodexRoot,
    sourceWorkspaceRoot,
    targetHomePath,
    targetWorkspaceRoot,
  },
) {
  const sourceHomePath = sourceCodexRoot
    ? path.dirname(sourceCodexRoot)
    : null;
  const replacements = [
    [sourceWorkspaceRoot, targetWorkspaceRoot],
    [sourceHomePath, targetHomePath],
  ].filter(([sourceValue, targetValue]) =>
    typeof sourceValue === "string"
    && sourceValue.length > 0
    && typeof targetValue === "string"
    && targetValue.length > 0,
  ).sort((left, right) => right[0].length - left[0].length);

  let normalized = String(configText);
  for (const [sourceValue, targetValue] of replacements) {
    normalized = replaceAll(normalized, sourceValue, targetValue);
  }
  return normalizeRemoteTargetPathSeparators(
    normalized,
    replacements.map(([, targetValue]) => targetValue),
  );
}

export function normalizeCodexAgentsText(
  agentsText,
  {
    sourceCodexRoot,
    sourceWorkspaceRoot,
    targetCodexRoot,
    targetHomePath,
    targetWorkspaceRoot,
  },
) {
  const sourceHomePath = sourceCodexRoot
    ? path.dirname(sourceCodexRoot)
    : null;
  const replacements = [
    [sourceCodexRoot, targetCodexRoot],
    [sourceWorkspaceRoot, targetWorkspaceRoot],
    [sourceHomePath, targetHomePath],
  ].filter(([sourceValue, targetValue]) =>
    typeof sourceValue === "string"
    && sourceValue.length > 0
    && typeof targetValue === "string"
    && targetValue.length > 0,
  ).sort((left, right) => right[0].length - left[0].length);

  let normalized = String(agentsText);
  for (const [sourceValue, targetValue] of replacements) {
    normalized = replaceAll(normalized, sourceValue, targetValue);
  }
  return normalizeRemoteTargetPathSeparators(
    normalized,
    replacements.map(([, targetValue]) => targetValue),
  );
}

export function resolveRemoteCustomCodexPath({
  host,
  sourceBinPath,
  sourceStateRoot,
  sourceWorkspaceRoot,
}) {
  if (!sourceBinPath || !path.isAbsolute(sourceBinPath)) {
    return null;
  }

  if (sourceWorkspaceRoot && path.isAbsolute(sourceWorkspaceRoot)) {
    const relativePath = path.relative(sourceWorkspaceRoot, sourceBinPath);
    if (
      relativePath === ""
      || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    ) {
      return path.posix.join(
        host.workspace_root || "~/workspace",
        relativePath.replace(/\\/gu, "/"),
      );
    }
  }

  if (sourceStateRoot && path.isAbsolute(sourceStateRoot)) {
    const stateRelativePath = path.relative(sourceStateRoot, sourceBinPath);
    if (
      stateRelativePath === ""
      || (!stateRelativePath.startsWith("..") && !path.isAbsolute(stateRelativePath))
    ) {
      return path.posix.join(
        resolveHostStateRoot(host, null),
        stateRelativePath.replace(/\\/gu, "/"),
      );
    }
  }

  return path.posix.join(
    host.worker_runtime_root || "~/.local/state/teledex",
    "bin",
    path.basename(sourceBinPath),
  );
}

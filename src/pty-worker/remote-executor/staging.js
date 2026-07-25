import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { TELEDEX_APP_NAME } from "../../config/app-identity.js";
import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "../../hosts/host-command-runner.js";
import { resolveExecutionCwd } from "../../hosts/host-paths.js";

const LOCAL_GATEWAY_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function sanitizePathSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || fallback;
}

export function buildRemoteExecutorCommand(repoRoot) {
  return [
    "set -euo pipefail",
    `repo_root=${shellQuote(repoRoot)}`,
    'if [[ "$repo_root" == "~" ]]; then repo_root="$HOME"; elif [[ "$repo_root" == "~/"* ]]; then repo_root="$HOME/${repo_root:2}"; fi',
    'provider_env="$HOME/.codex/provider-env"',
    'if [[ -r "$provider_env" ]]; then set -a; source "$provider_env"; set +a; fi',
    'export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"',
    'cd "$repo_root"',
    "exec node src/cli/host-executor.js --stdio-jsonrpc",
  ].join("; ");
}

export function assertSafeRemoteGatewayRepoRoot(repoRoot, hostId = "unknown") {
  const normalizedRepoRoot = normalizeOptionalText(repoRoot);
  if (!normalizedRepoRoot) {
    throw new Error(`Remote execution host ${hostId} is missing repo_root`);
  }
  const hasSafeRootPrefix =
    normalizedRepoRoot.startsWith("/")
    || normalizedRepoRoot.startsWith("~/");
  const hasParentSegment = normalizedRepoRoot
    .replace(/^~\//u, "")
    .split("/")
    .some((segment) => segment === "..");

  const expandedRepoRoot = normalizedRepoRoot.startsWith("~/")
    ? `/${normalizedRepoRoot.slice(2)}`
    : normalizedRepoRoot;
  const normalizedExpandedRepoRoot = path.posix
    .normalize(expandedRepoRoot)
    .replace(/\/+$/u, "");
  const rootName = path.posix.basename(normalizedExpandedRepoRoot);
  const acceptedRepoRootNames = new Set([
    TELEDEX_APP_NAME,
  ]);
  const acceptedRepoRootSuffixes = [
    `apps/${TELEDEX_APP_NAME}`,
  ];
  if (
    !hasSafeRootPrefix
    || !acceptedRepoRootNames.has(rootName)
    || !acceptedRepoRootSuffixes.some((suffix) =>
      normalizedExpandedRepoRoot.endsWith(suffix))
    || normalizedRepoRoot === "/"
    || normalizedRepoRoot === "~"
    || normalizedExpandedRepoRoot === "/"
    || hasParentSegment
    || normalizedRepoRoot.includes("\0")
  ) {
    throw new Error(
      `Remote execution host ${hostId} repo_root must point at a Teledex checkout before sync`,
    );
  }
}

export async function syncGatewayRepoToRemote({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  platform = process.platform,
}) {
  assertSafeRemoteGatewayRepoRoot(host.repo_root, host.host_id);
  const remoteRepoRoot = await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    directory: host.repo_root,
    create: true,
  });
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      "--exclude=.git/",
      "--exclude=node_modules/",
      "--exclude=.env",
      normalizeRsyncLocalPath(
        `${LOCAL_GATEWAY_REPO_ROOT}${path.sep}`,
        { platform },
      ),
      buildRsyncRemotePath(host.ssh_target, `${remoteRepoRoot}/`),
    ],
    {
      execFileImpl,
      timeoutMs: 60_000,
    },
  );
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      normalizeRsyncLocalPath(
        path.join(LOCAL_GATEWAY_REPO_ROOT, ".git", path.sep),
        { platform },
      ),
      buildRsyncRemotePath(host.ssh_target, `${remoteRepoRoot}/.git/`),
    ],
    {
      execFileImpl,
      timeoutMs: 60_000,
    },
  );
}

export async function ensureRemoteDirectory({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  directory,
  create = false,
}) {
  const normalizedDirectory = normalizeOptionalText(directory);
  if (!normalizedDirectory) {
    throw new Error(`Remote directory is missing for host ${host?.host_id || "unknown"}`);
  }

  const commands = [
    `target=${shellQuote(normalizedDirectory)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
  ];
  if (create) {
    commands.push('mkdir -p "$target"');
  }
  commands.push('[[ -d "$target" ]]');
  commands.push('printf "%s\\n" "$target"');

  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: commands.join("; "),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  });
  return stdout.trim().split("\n").at(-1) || normalizedDirectory;
}

export function resolveRemoteExecutionCwd({
  currentHostId,
  host,
  session,
}) {
  return resolveExecutionCwd({
    workspaceBinding: session?.workspace_binding,
    host,
    currentHostId,
  });
}

export async function stageImageToRemote({
  connectTimeoutSecs,
  execFileImpl,
  host,
  imagePath,
  platform = process.platform,
  remoteInputRoot,
  cache,
}) {
  const resolvedLocalPath = await fs.realpath(imagePath);
  const cachedPath = cache.get(resolvedLocalPath);
  if (cachedPath) {
    return cachedPath;
  }

  const remoteFileName = [
    String(cache.size + 1).padStart(4, "0"),
    sanitizePathSegment(path.basename(resolvedLocalPath), "image"),
  ].join("-");
  const remotePath = path.posix.join(remoteInputRoot, remoteFileName);
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--chmod=F600,D700",
      normalizeRsyncLocalPath(resolvedLocalPath, { platform }),
      buildRsyncRemotePath(host.ssh_target, remotePath),
    ],
    {
      execFileImpl,
      timeoutMs: 30_000,
    },
  );
  cache.set(resolvedLocalPath, remotePath);
  return remotePath;
}

export async function localizeRemoteInputItems({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  input = [],
  platform = process.platform,
  remoteInputRoot,
  cache,
}) {
  const localized = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type !== "localImage" || !item.path) {
      localized.push(item);
      continue;
    }

    const remotePath = await stageImageToRemote({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      imagePath: item.path,
      platform,
      remoteInputRoot,
      cache,
    });
    localized.push({
      ...item,
      path: remotePath,
    });
  }

  return localized;
}

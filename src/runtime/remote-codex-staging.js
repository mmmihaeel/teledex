import fs from "node:fs/promises";
import path from "node:path";

import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  buildSshBaseArgs,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "../hosts/host-command-runner.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function parseKeyValueLines(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }

  return values;
}

export function sanitizePathSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || fallback;
}

async function stageExecImageToRemote({
  connectTimeoutSecs,
  execFileImpl,
  host,
  imagePath,
  platform = process.platform,
  remoteInputRoot,
  cache,
}) {
  const normalizedImagePath = normalizeOptionalText(imagePath);
  if (!normalizedImagePath) {
    return null;
  }

  const stagedCache = cache || new Map();
  const resolvedLocalPath = await fs.realpath(normalizedImagePath);
  const cached = stagedCache.get(resolvedLocalPath);
  if (cached) {
    return cached;
  }

  const remoteFileName = [
    String(stagedCache.size + 1).padStart(4, "0"),
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
  stagedCache.set(resolvedLocalPath, remotePath);
  return remotePath;
}

export async function stageExecImagesToRemote({
  connectTimeoutSecs,
  execFileImpl,
  host,
  imagePaths = [],
  platform = process.platform,
  remoteInputRoot,
  cache,
}) {
  const staged = [];
  const stagedCache = cache || new Map();
  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    const remotePath = await stageExecImageToRemote({
      connectTimeoutSecs,
      execFileImpl,
      host,
      imagePath,
      platform,
      remoteInputRoot,
      cache: stagedCache,
    });
    if (!remotePath) {
      continue;
    }

    staged.push(remotePath);
  }

  return staged;
}

export async function localizeRemoteInputItems({
  connectTimeoutSecs,
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

    const remotePath = await stageExecImageToRemote({
      connectTimeoutSecs,
      execFileImpl,
      host,
      imagePath: item.path,
      platform,
      remoteInputRoot,
      cache,
    });
    if (!remotePath) {
      continue;
    }
    localized.push({
      ...item,
      path: remotePath,
    });
  }

  return localized;
}

function buildRemoteExecShellCommand({ codexBinPath, args }) {
  const command = [codexBinPath, ...args].map((part) => shellQuote(part)).join(" ");
  const script = [
    "set -euo pipefail",
    "exec 3<&0",
    'provider_env="$HOME/.codex/provider-env"',
    'if [[ -r "$provider_env" ]]; then set -a; source "$provider_env"; set +a; fi',
    "child_pid=",
    "terminate_child() {",
    '  if [[ -n "${child_pid:-}" ]]; then',
    '    kill -TERM -- "-${child_pid}" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null || true',
    "    sleep 1",
    '    kill -KILL -- "-${child_pid}" 2>/dev/null || kill -KILL "$child_pid" 2>/dev/null || true',
    "  fi",
    "}",
    'trap "terminate_child; exit 130" INT',
    'trap "terminate_child; exit 143" HUP TERM',
    `if command -v setsid >/dev/null 2>&1; then setsid ${command} <&3 & else ${command} <&3 & fi`,
    "child_pid=$!",
    "set +e",
    'wait "$child_pid"',
    "exit_code=$?",
    "child_pid=",
    "exit $exit_code",
  ].join("\n");
  return `bash -lc ${shellQuote(script)}`;
}

function buildPrepareRemoteExecPathsScript({
  codexBinPath,
  remoteCwd,
  remoteInputRoot,
}) {
  return [
    "set -euo pipefail",
    "expand_path() {",
    '  local value="$1"',
    '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
    '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
    '  printf "%s\\n" "$value"',
    "}",
    `remote_cwd="$(expand_path ${shellQuote(remoteCwd)})"`,
    `remote_input_root="$(expand_path ${shellQuote(remoteInputRoot)})"`,
    `remote_codex_bin="$(expand_path ${shellQuote(codexBinPath)})"`,
    '[[ -d "$remote_cwd" ]]',
    'mkdir -p "$remote_input_root"',
    '[[ -d "$remote_input_root" ]]',
    'printf "cwd=%s\\n" "$remote_cwd"',
    'printf "input_root=%s\\n" "$remote_input_root"',
    'printf "codex_bin=%s\\n" "$remote_codex_bin"',
  ].join("\n");
}

export function buildRemoteInputRunSegment() {
  return [
    "run",
    Date.now(),
    Math.random().toString(16).slice(2),
  ].join("-");
}

export async function cleanupRemoteInputRoot({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  remoteInputRoot,
}) {
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      "set -euo pipefail",
      `target=${shellQuote(remoteInputRoot)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'rm -rf -- "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });
}

export async function prepareRemoteExecPaths({
  codexBinPath,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  hostId,
  remoteCwd,
  remoteInputRoot,
}) {
  const result = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: buildPrepareRemoteExecPathsScript({
      codexBinPath,
      remoteCwd,
      remoteInputRoot,
    }),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  }).catch((error) => {
    throw new Error(`Remote exec paths are unavailable on ${hostId}: ${error.message}`);
  });
  const parsed = parseKeyValueLines(result.stdout);
  if (!parsed.cwd || !parsed.input_root || !parsed.codex_bin) {
    throw new Error(`Remote exec path expansion failed on ${hostId}`);
  }

  return {
    remoteCwd: parsed.cwd,
    remoteInputRoot: parsed.input_root,
    remoteCodexBinPath: parsed.codex_bin,
  };
}

export function buildRemoteCodexStdioSshArgs({
  host,
  connectTimeoutSecs,
  codexBinPath,
  args,
} = {}) {
  if (!host?.ssh_target) {
    throw new Error("Remote exec host is missing ssh_target metadata");
  }

  return [
    "-T",
    ...buildSshBaseArgs(host.ssh_target, connectTimeoutSecs),
    buildRemoteExecShellCommand({ codexBinPath, args }),
  ];
}

export function buildRemoteCodexExecSshArgs(args = {}) {
  return buildRemoteCodexStdioSshArgs(args);
}

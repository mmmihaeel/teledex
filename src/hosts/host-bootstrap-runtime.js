import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import { writeTextAtomic } from "../state/file-utils.js";
import {
  RTK_CODEX_PLUGIN_CONFIG_KEY,
  ensureWorkspaceRtkCodexPluginConfigText,
  removeWorkspaceRtkCodexPluginConfigText,
  resolveWorkspaceRtkCodexPluginCachePath,
  resolveWorkspaceRtkCodexPluginSource,
} from "../runtime/rtk-codex-plugin.js";
import {
  PITLANE_CODEX_PLUGIN_CONFIG_KEY,
  ensurePitlaneCodexPluginConfigText,
  removePitlaneCodexPluginConfigText,
  resolvePitlaneCodexPluginCachePath,
  resolvePitlaneCodexPluginSource,
} from "../runtime/pitlane-codex-plugin.js";
import {
  discoverCodexPluginHookTrustEntries,
  ensureCodexPluginHookTrustConfigText,
  summarizeCodexPluginHookTrustEntries,
} from "../runtime/codex-plugin-hook-trust.js";
import { runCommand, runHostBash, shellQuote } from "./host-command-runner.js";
import {
  buildHybridCodexMcpConfigText,
  resolveRenderedLocalMcpContainers,
} from "./codex-mcp-config.js";
import { captureHostModelsCacheSnapshot } from "./codex-model-catalog.js";
import {
  OPERATOR_TOOLBELT_COMMANDS,
  parseMissingOperatorTools,
} from "./operator-toolbelt.js";
import {
  assertReadableDirectory,
  assertReadableFile,
  copyLocalFileToHost,
  removeRemoteFile,
  syncLocalDirectoryToHost,
} from "./host-bootstrap-file-sync.js";
import {
  buildBootstrapScript,
  buildRuntimeProbeScript,
} from "./host-bootstrap-scripts.js";
import {
  detectHostLocalMcpContainers,
  ensureHostLocalWorkerMcps,
} from "./host-bootstrap-worker-mcps.js";
import {
  expandHomePath,
  normalizeCodexAgentsText,
  normalizeCodexConfigText,
  resolveRemoteCustomCodexPath,
} from "./host-bootstrap-paths.js";

const REMOTE_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;
const LARGE_OUTPUT_BUFFER_BYTES = 16 * 1024 * 1024;
const PITLANE_CLI_VERSION = "0.10.2";
const CODEX_PROFILE_SYNC_EXCLUDES = [
  "config.toml",
  "auth.json",
  "sessions/",
  "archived_sessions/",
  ".tmp/",
  "tmp/",
  "cache/",
  "log/",
  "shell_snapshots/",
  "vendor_imports/",
  "history.jsonl",
  "session_index.jsonl",
  "models_cache.json",
  "cloud-requirements-cache.json",
  "logs_2.sqlite*",
  "state_5.sqlite*",
];
const TELEDEX_SOURCE_RELATIVE_PATH =
  "apps/teledex";
const TELEDEX_SOURCE_SYNC_EXCLUDES = [
  ".git/",
  ".env",
  ".env.*",
  "node_modules/",
];
const CODEX_PLUGIN_SYNC_EXCLUDES = [
  ".git/",
  "WORKSPACE_GUIDE.md",
  "WORKSPACE_GUIDE.local.md",
  "__pycache__/",
  "*.py[cod]",
  "node_modules/",
];

function parseKeyValueLines(text) {
  const pairs = {};
  for (const rawLine of String(text || "").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    pairs[key] = value;
  }

  return pairs;
}

async function detectInstalledCodexNpmSpec(execFileImpl = execFile) {
  try {
    const { stdout } = await runCommand(
      "npm",
      ["ls", "-g", "--json", "--depth=0"],
      {
        execFileImpl,
        timeoutMs: 10_000,
      },
    );
    const parsed = JSON.parse(stdout);
    const version = parsed?.dependencies?.["@openai/codex"]?.version;
    return version
      ? `@openai/codex@${version}`
      : null;
  } catch {
    return null;
  }
}

function isPinnedCodexNpmSpec(value) {
  const normalized = String(value || "").trim();
  return /^@openai\/codex@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
    .test(normalized);
}

async function syncSourceModelsCacheToHost({
  connectTimeoutSecs,
  copySourceCache,
  currentHostId,
  execFileImpl,
  host,
  remoteCodexRoot,
  sourceCodexRoot,
}) {
  const localModelsCachePath = path.join(sourceCodexRoot, "models_cache.json");
  const remoteModelsCachePath = path.posix.join(remoteCodexRoot, "models_cache.json");
  if (!copySourceCache) {
    await removeRemoteFile({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      remotePath: remoteModelsCachePath,
    });
    return {
      path: remoteModelsCachePath,
      status: "removed-unpinned-source-cache",
    };
  }

  try {
    await fs.access(localModelsCachePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await removeRemoteFile({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      remotePath: remoteModelsCachePath,
    });
    return {
      path: remoteModelsCachePath,
      status: "removed-missing-source",
    };
  }

  await copyLocalFileToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: localModelsCachePath,
    remotePath: remoteModelsCachePath,
    chmod: "600",
  });
  return {
    path: remoteModelsCachePath,
    status: "copied",
  };
}

async function installConfiguredCodexOnPath({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  remoteBinPath,
}) {
  if (!remoteBinPath) {
    return {
      path: null,
      status: "skipped",
    };
  }

  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      "set -euo pipefail",
      "expand_path() {",
      '  local value="$1"',
      '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
      '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
      '  printf "%s\\n" "$value"',
      "}",
      `configured_codex=$(expand_path ${shellQuote(remoteBinPath)})`,
      'if [[ ! -x "$configured_codex" ]]; then printf "status=missing\\npath=%s\\n" "$configured_codex"; exit 0; fi',
      'if sudo -n install -m 0755 "$configured_codex" /usr/local/bin/codex >/dev/null 2>&1; then',
      '  printf "status=installed\\npath=/usr/local/bin/codex\\n"',
      "else",
      '  printf "status=sudo-unavailable\\npath=%s\\n" "$configured_codex"',
      "fi",
    ].join("\n"),
    timeoutMs: 30_000,
  });
  const fields = parseKeyValueLines(stdout);
  return {
    path: fields.path || remoteBinPath,
    status: fields.status || "unknown",
  };
}

async function installHostLocalPitlaneCli({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
}) {
  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      "set -euo pipefail",
      `target_version=${shellQuote(PITLANE_CLI_VERSION)}`,
      'current_version="$(pitlane --version 2>/dev/null || true)"',
      'current_path="$(command -v pitlane 2>/dev/null || true)"',
      'if [[ "$current_version" == "pitlane $target_version" && -n "$current_path" ]]; then',
      '  printf "status=present\\npath=%s\\nversion=%s\\n" "$current_path" "$current_version"',
      "  exit 0",
      "fi",
      'arch="$(uname -m)"',
      'case "$arch" in',
      '  x86_64|amd64) asset_arch="x86_64" ;;',
      '  aarch64|arm64) asset_arch="aarch64" ;;',
      '  *) printf "unsupported architecture for pitlane CLI: %s\\n" "$arch" >&2; exit 1 ;;',
      "esac",
      'tmp_dir="$(mktemp -d)"',
      'cleanup() { rm -rf "$tmp_dir"; }',
      "trap cleanup EXIT",
      'archive="$tmp_dir/pitlane-mcp.tar.gz"',
      'url="https://github.com/eresende/pitlane-mcp/releases/download/v${target_version}/pitlane-mcp-linux-${asset_arch}.tar.gz"',
      'if command -v curl >/dev/null 2>&1; then',
      '  curl -fsSL "$url" -o "$archive"',
      'elif command -v wget >/dev/null 2>&1; then',
      '  wget -qO "$archive" "$url"',
      "else",
      '  printf "curl or wget is required to install pitlane CLI\\n" >&2',
      "  exit 1",
      "fi",
      'tar -xzf "$archive" -C "$tmp_dir" pitlane',
      'chmod +x "$tmp_dir/pitlane"',
      'sudo -n install -m 0755 "$tmp_dir/pitlane" /usr/local/bin/pitlane',
      'installed_version="$(/usr/local/bin/pitlane --version 2>/dev/null || true)"',
      'if [[ "$installed_version" != "pitlane $target_version" ]]; then',
      '  printf "installed pitlane version mismatch: %s\\n" "$installed_version" >&2',
      "  exit 1",
      "fi",
      'printf "status=installed\\npath=/usr/local/bin/pitlane\\nversion=%s\\n" "$installed_version"',
    ].join("\n"),
    timeoutMs: 120_000,
  });
  const fields = parseKeyValueLines(stdout);
  return {
    path: fields.path || null,
    status: fields.status || "unknown",
    version: fields.version || null,
  };
}

async function ensureWorkerTeledexCheckout({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  sourceWorkspaceRoot,
}) {
  if (!sourceWorkspaceRoot) {
    throw new Error("Worker Teledex checkout bootstrap requires sourceWorkspaceRoot");
  }

  const sourceTeledexPath = path.join(sourceWorkspaceRoot, TELEDEX_SOURCE_RELATIVE_PATH);
  await assertReadableDirectory(sourceTeledexPath, "Teledex source");

  const remoteTeledexPath =
    host.repo_root
    || path.posix.join(host.workspace_root || "~/workspace", "teledex");
  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: sourceTeledexPath,
    remotePath: remoteTeledexPath,
    exclude: TELEDEX_SOURCE_SYNC_EXCLUDES,
  });
}

async function syncWorkspaceRtkCodexPluginToHost({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  remoteCodexRoot,
  rtkPluginMode,
  rtkPluginPath,
  sourceCodexRoot,
}) {
  const pluginSource = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot: sourceCodexRoot,
    pluginMode: rtkPluginMode,
    pluginPath: rtkPluginPath,
  });
  if (!pluginSource.sourcePath) {
    return {
      status: "disabled",
      config_key: RTK_CODEX_PLUGIN_CONFIG_KEY,
      mode: pluginSource.mode,
      reason: pluginSource.reason,
      source_path: null,
      remote_path: null,
      warning: pluginSource.warning,
    };
  }
  const sourcePluginPath = pluginSource.sourcePath;
  await assertReadableDirectory(sourcePluginPath, "workspace RTK Codex plugin source");

  const remotePluginPath = resolveWorkspaceRtkCodexPluginCachePath(remoteCodexRoot);
  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    deleteExtra: true,
    deleteExcluded: true,
    execFileImpl,
    exclude: CODEX_PLUGIN_SYNC_EXCLUDES,
    host,
    localPath: sourcePluginPath,
    remotePath: remotePluginPath,
  });
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      "set -euo pipefail",
      `plugin_root=${shellQuote(remotePluginPath)}`,
      'if [[ "$plugin_root" == "~" ]]; then plugin_root="$HOME"; elif [[ "$plugin_root" == "~/"* ]]; then plugin_root="$HOME/${plugin_root:2}"; fi',
      'test -f "$plugin_root/.codex-plugin/plugin.json"',
      'test -f "$plugin_root/hooks/hooks.json"',
      'test -f "$plugin_root/hooks/rtk-codex-hook"',
      'test -f "$plugin_root/hooks/rtk-output-guard"',
      'test -f "$plugin_root/hooks/rtk-output-post-hook"',
      'chmod 700 "$plugin_root/hooks/rtk-codex-hook"',
      'chmod 700 "$plugin_root/hooks/rtk-output-guard"',
      'chmod 700 "$plugin_root/hooks/rtk-output-post-hook"',
    ].join("\n"),
    timeoutMs: 20_000,
  });

  return {
    status: "synced",
    config_key: RTK_CODEX_PLUGIN_CONFIG_KEY,
    mode: pluginSource.mode,
    source_path: sourcePluginPath,
    remote_path: remotePluginPath,
    warning: null,
  };
}

async function syncPitlaneCodexPluginToHost({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  remoteCodexRoot,
  pitlanePluginMode,
  pitlanePluginPath,
  sourceCodexRoot,
}) {
  const pluginSource = await resolvePitlaneCodexPluginSource({
    codexRoot: sourceCodexRoot,
    pluginMode: pitlanePluginMode,
    pluginPath: pitlanePluginPath,
  });
  if (!pluginSource.sourcePath) {
    return {
      status: "disabled",
      config_key: PITLANE_CODEX_PLUGIN_CONFIG_KEY,
      mode: pluginSource.mode,
      reason: pluginSource.reason,
      source_path: null,
      remote_path: null,
      warning: pluginSource.warning,
    };
  }
  const sourcePluginPath = pluginSource.sourcePath;
  await assertReadableDirectory(sourcePluginPath, "Pitlane Codex plugin source");

  const remotePluginPath = resolvePitlaneCodexPluginCachePath(remoteCodexRoot);
  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    deleteExtra: true,
    deleteExcluded: true,
    execFileImpl,
    exclude: CODEX_PLUGIN_SYNC_EXCLUDES,
    host,
    localPath: sourcePluginPath,
    remotePath: remotePluginPath,
  });
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      "set -euo pipefail",
      `plugin_root=${shellQuote(remotePluginPath)}`,
      'if [[ "$plugin_root" == "~" ]]; then plugin_root="$HOME"; elif [[ "$plugin_root" == "~/"* ]]; then plugin_root="$HOME/${plugin_root:2}"; fi',
      'test -f "$plugin_root/.codex-plugin/plugin.json"',
      'test -f "$plugin_root/hooks/hooks.json"',
      'test -f "$plugin_root/hooks/pitlane-codex-hook"',
      'chmod 700 "$plugin_root/hooks/pitlane-codex-hook"',
    ].join("\n"),
    timeoutMs: 20_000,
  });

  return {
    status: "synced",
    config_key: PITLANE_CODEX_PLUGIN_CONFIG_KEY,
    mode: pluginSource.mode,
    source_path: sourcePluginPath,
    remote_path: remotePluginPath,
    warning: null,
  };
}

async function syncNormalizedCodexAgentsToHost({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  hostsRoot,
  remoteCodexRoot,
  remoteHomePath,
  sourceCodexRoot,
  sourceWorkspaceRoot,
}) {
  const sourceAgentsPath = path.join(sourceCodexRoot, "WORKSPACE_GUIDE.md");
  let sourceAgentsText;
  try {
    sourceAgentsText = await fs.readFile(sourceAgentsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: path.posix.join(remoteCodexRoot, "WORKSPACE_GUIDE.md"),
        status: "skipped-missing-source",
      };
    }
    throw error;
  }

  const targetCodexRoot = remoteHomePath
    ? expandHomePath(remoteCodexRoot, remoteHomePath)
    : remoteCodexRoot;
  const normalizedAgentsText = normalizeCodexAgentsText(sourceAgentsText, {
    sourceCodexRoot,
    sourceWorkspaceRoot,
    targetCodexRoot,
    targetHomePath: remoteHomePath,
    targetWorkspaceRoot: remoteHomePath
      ? expandHomePath(host.workspace_root || null, remoteHomePath)
      : host.workspace_root || null,
  });
  const normalizedAgentsPath = path.join(
    hostsRoot,
    `${host.host_id}-bootstrap-WORKSPACE_GUIDE.md`,
  );
  await writeTextAtomic(normalizedAgentsPath, normalizedAgentsText);
  await fs.chmod(normalizedAgentsPath, 0o600).catch(() => null);
  try {
    await copyLocalFileToHost({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      localPath: normalizedAgentsPath,
      remotePath: path.posix.join(remoteCodexRoot, "WORKSPACE_GUIDE.md"),
      chmod: "600",
    });
  } finally {
    await fs.rm(normalizedAgentsPath, { force: true });
  }

  return {
    path: path.posix.join(targetCodexRoot, "WORKSPACE_GUIDE.md"),
    status: "copied-normalized",
  };
}

export async function runHostBootstrapRuntime({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  registryService,
  pitlanePluginMode = "off",
  pitlanePluginPath = null,
  rtkPluginMode = "off",
  rtkPluginPath = null,
  sourceBinPath = null,
  sourceCodexRoot = null,
  sourceAuthPath = null,
  sourceConfigPath = null,
  sourceStateRoot = null,
  sourceWorkspaceRoot = null,
  targetHostId,
  codexNpmSpec = null,
  mcpPreset = "none",
}) {
  const normalizedMcpPreset = String(mcpPreset || "none").trim().toLowerCase();
  if (normalizedMcpPreset !== "workspace" && normalizedMcpPreset !== "none") {
    throw new Error(`Unsupported TELEDEX_MCP_PRESET: ${mcpPreset}`);
  }

  if (currentHostId !== "local") {
    throw new Error("Host runtime bootstrap is only supported from local");
  }
  if (!targetHostId) {
    throw new Error("Host runtime bootstrap requires --host");
  }

  const host = await registryService.getHost(targetHostId);
  if (!host) {
    throw new Error(`Unknown host for runtime bootstrap: ${targetHostId}`);
  }
  if (host.host_id === currentHostId) {
    throw new Error("Host runtime bootstrap target must be a non-local host");
  }
  if (!host.ssh_target) {
    throw new Error(`Host ${targetHostId} is missing ssh_target`);
  }

  const currentHost = await registryService.getHost(currentHostId);
  const resolvedSourceConfigPath = expandHomePath(
    sourceConfigPath || currentHost?.codex_config_path || "~/.codex/config.toml",
  );
  const resolvedSourceAuthPath = expandHomePath(
    sourceAuthPath || currentHost?.codex_auth_path || "~/.codex/auth.json",
  );
  const resolvedSourceCodexRoot = expandHomePath(
    sourceCodexRoot || path.dirname(resolvedSourceConfigPath),
  );
  const resolvedSourceWorkspaceRoot = expandHomePath(
    sourceWorkspaceRoot,
  );
  const resolvedSourceBinPath = expandHomePath(sourceBinPath);
  const resolvedSourceStateRoot = expandHomePath(sourceStateRoot);
  await assertReadableFile(resolvedSourceConfigPath, "Codex config");
  await assertReadableFile(resolvedSourceAuthPath, "Codex auth");
  await assertReadableDirectory(resolvedSourceCodexRoot, "Codex profile root");
  if (resolvedSourceBinPath) {
    await assertReadableFile(resolvedSourceBinPath, "Codex binary");
  }

  const resolvedCodexNpmSpec =
    codexNpmSpec || await detectInstalledCodexNpmSpec(execFileImpl);
  const resolvedRemoteBinPath = resolveRemoteCustomCodexPath({
    host,
    sourceBinPath: resolvedSourceBinPath,
    sourceStateRoot: resolvedSourceStateRoot,
    sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
  });
  if (!resolvedRemoteBinPath && !isPinnedCodexNpmSpec(resolvedCodexNpmSpec)) {
    throw new Error(
      "Host runtime bootstrap requires a copied Codex binary or a pinned codexNpmSpec such as @openai/codex@0.124.0",
    );
  }

  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    maxBufferBytes: LARGE_OUTPUT_BUFFER_BYTES,
    script: buildBootstrapScript({
      workspaceRoot: host.workspace_root || "~/workspace",
      repoRoot: host.repo_root || "~/teledex",
      runtimeRoot: host.worker_runtime_root || "~/.local/state/teledex",
      codexPackageSpec: resolvedCodexNpmSpec,
      skipCodexInstall: Boolean(resolvedRemoteBinPath),
    }),
    timeoutMs: REMOTE_BOOTSTRAP_TIMEOUT_MS,
  });

  const bootstrapProbe = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedRemoteBinPath
      ? { ...host, codex_bin_path: resolvedRemoteBinPath }
      : host,
    script: buildRuntimeProbeScript(
      resolvedRemoteBinPath
        ? { ...host, codex_bin_path: resolvedRemoteBinPath }
        : host,
    ),
    timeoutMs: 20_000,
  });
  const bootstrapProbeFields = parseKeyValueLines(bootstrapProbe.stdout);
  const remoteHomePath = bootstrapProbeFields.home_path || null;
  const remoteCodexRoot = path.posix.dirname(
    host.codex_config_path || "~/.codex/config.toml",
  );
  await ensureWorkerTeledexCheckout({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
  });
  let localMcpContainers = new Set();
  let renderedLocalMcpContainers = new Set();
  if (normalizedMcpPreset === "workspace") {
    await ensureHostLocalWorkerMcps({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      maxBufferBytes: LARGE_OUTPUT_BUFFER_BYTES,
      remoteHomePath,
      remoteBootstrapTimeoutMs: REMOTE_BOOTSTRAP_TIMEOUT_MS,
      sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
    });
    localMcpContainers = await detectHostLocalMcpContainers({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
    });
    renderedLocalMcpContainers = resolveRenderedLocalMcpContainers({
      host,
      localMcpContainers,
    });
  }

  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: resolvedSourceCodexRoot,
    remotePath: remoteCodexRoot,
    exclude: CODEX_PROFILE_SYNC_EXCLUDES,
  });

  const rtkCodexPluginSync = await syncWorkspaceRtkCodexPluginToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    remoteCodexRoot,
    rtkPluginMode,
    rtkPluginPath,
    sourceCodexRoot: resolvedSourceCodexRoot,
  });
  const pitlaneCodexPluginSync = await syncPitlaneCodexPluginToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    remoteCodexRoot,
    pitlanePluginMode,
    pitlanePluginPath,
    sourceCodexRoot: resolvedSourceCodexRoot,
  });
  const rtkHookTrustEntries = rtkCodexPluginSync.status === "synced"
    ? await discoverCodexPluginHookTrustEntries({
      pluginId: RTK_CODEX_PLUGIN_CONFIG_KEY,
      pluginRoot: rtkCodexPluginSync.source_path,
    })
    : [];
  const pitlaneHookTrustEntries = pitlaneCodexPluginSync.status === "synced"
    ? await discoverCodexPluginHookTrustEntries({
      pluginId: PITLANE_CODEX_PLUGIN_CONFIG_KEY,
      pluginRoot: pitlaneCodexPluginSync.source_path,
    })
    : [];
  const baseConfigText = buildHybridCodexMcpConfigText(
    normalizeCodexConfigText(
      await fs.readFile(resolvedSourceConfigPath, "utf8"),
      {
        sourceCodexRoot: resolvedSourceCodexRoot,
        sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
        targetHomePath: remoteHomePath,
        targetWorkspaceRoot: remoteHomePath
          ? expandHomePath(host.workspace_root || null, remoteHomePath)
          : host.workspace_root || null,
      },
    ),
    {
      connectTimeoutSecs,
      host,
      localMcpContainers,
      mcpPreset: normalizedMcpPreset,
      sharedHostSshTarget: currentHost?.ssh_target || currentHostId,
    },
  );
  const normalizedConfigText = rtkCodexPluginSync.status === "synced"
    ? ensureWorkspaceRtkCodexPluginConfigText(baseConfigText)
    : removeWorkspaceRtkCodexPluginConfigText(baseConfigText);
  const normalizedPluginConfigText = pitlaneCodexPluginSync.status === "synced"
    ? ensurePitlaneCodexPluginConfigText(normalizedConfigText)
    : removePitlaneCodexPluginConfigText(normalizedConfigText);
  const trustedPluginConfigText = ensureCodexPluginHookTrustConfigText(
    normalizedPluginConfigText,
    [
      ...rtkHookTrustEntries,
      ...pitlaneHookTrustEntries,
    ],
  );
  const normalizedConfigPath = path.join(
    hostsRoot,
    `${host.host_id}-bootstrap-config.toml`,
  );
  await writeTextAtomic(normalizedConfigPath, trustedPluginConfigText);
  await fs.chmod(normalizedConfigPath, 0o600).catch(() => null);
  try {
    await copyLocalFileToHost({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      localPath: normalizedConfigPath,
      remotePath: host.codex_config_path || "~/.codex/config.toml",
      chmod: "600",
    });
  } finally {
    await fs.rm(normalizedConfigPath, { force: true });
  }
  const agentsSync = await syncNormalizedCodexAgentsToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    hostsRoot,
    remoteCodexRoot,
    remoteHomePath,
    sourceCodexRoot: resolvedSourceCodexRoot,
    sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
  });
  await copyLocalFileToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: resolvedSourceAuthPath,
    remotePath: host.codex_auth_path || "~/.codex/auth.json",
    chmod: "600",
  });

  if (resolvedRemoteBinPath) {
    await copyLocalFileToHost({
      connectTimeoutSecs,
      copyLinks: true,
      currentHostId,
      execFileImpl,
      host,
      localPath: resolvedSourceBinPath,
      remotePath: resolvedRemoteBinPath,
      chmod: "755",
    });
  }
  const pathCodexInstall = await installConfiguredCodexOnPath({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    remoteBinPath: resolvedRemoteBinPath,
  });
  const pitlaneCliInstall = await installHostLocalPitlaneCli({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
  });

  const modelsCacheSync = await syncSourceModelsCacheToHost({
    connectTimeoutSecs,
    copySourceCache: Boolean(resolvedRemoteBinPath),
    currentHostId,
    execFileImpl,
    host,
    remoteCodexRoot,
    sourceCodexRoot: resolvedSourceCodexRoot,
  });

  const probe = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedRemoteBinPath
      ? { ...host, codex_bin_path: resolvedRemoteBinPath }
      : host,
    script: buildRuntimeProbeScript(
      resolvedRemoteBinPath
        ? { ...host, codex_bin_path: resolvedRemoteBinPath }
        : host,
    ),
    timeoutMs: 20_000,
  });
  const probeFields = parseKeyValueLines(probe.stdout);
  await registryService.patchHost(host.host_id, {
    codex_bin_path:
      probeFields.configured_codex_path
      || probeFields.codex_path
      || host.codex_bin_path,
  });
  const modelsCacheSnapshot = await captureHostModelsCacheSnapshot({
    codexSpaceRoot: path.join(hostsRoot, "..", "teledex-context"),
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
  });
  const summary = {
    ran_at: new Date().toISOString(),
    current_host_id: currentHostId,
    host_id: host.host_id,
    status: "bootstrapped",
    codex_npm_spec: resolvedCodexNpmSpec,
    source_codex_root: resolvedSourceCodexRoot,
    source_config_path: resolvedSourceConfigPath,
    source_auth_path: resolvedSourceAuthPath,
    source_bin_path: resolvedSourceBinPath,
    remote_codex_root: remoteCodexRoot,
    remote_bin_path: resolvedRemoteBinPath,
    path_codex_install: pathCodexInstall,
    pitlane_cli: pitlaneCliInstall,
    models_cache_sync: modelsCacheSync,
    agents_sync: agentsSync,
    models_cache_snapshot: modelsCacheSnapshot,
    profile_sync_excludes: CODEX_PROFILE_SYNC_EXCLUDES,
    operator_toolbelt: {
      commands: OPERATOR_TOOLBELT_COMMANDS,
      missing: parseMissingOperatorTools(probeFields.operator_toolbelt_missing),
    },
    rtk_codex_plugin: {
      ...rtkCodexPluginSync,
      rtk_path: probeFields.rtk_path || null,
      rtk_version: probeFields.rtk_version || null,
    },
    pitlane_codex_plugin: pitlaneCodexPluginSync,
    hook_trust: {
      rtk: summarizeCodexPluginHookTrustEntries(rtkHookTrustEntries),
      pitlane: summarizeCodexPluginHookTrustEntries(pitlaneHookTrustEntries),
    },
    mcp_profile: {
      shared_host: currentHost?.ssh_target || currentHostId,
      shared_transport: "ssh+local-docker-stdio",
      detected_local_containers: Array.from(localMcpContainers).sort(),
      rendered_local_containers: [...renderedLocalMcpContainers].sort(),
      preset: normalizedMcpPreset,
    },
    probe: {
      home_path: probeFields.home_path || null,
      node_path: probeFields.node_path || null,
      node_version: probeFields.node_version || null,
      npm_path: probeFields.npm_path || null,
      npm_version: probeFields.npm_version || null,
      codex_path:
        probeFields.configured_codex_path
        || probeFields.codex_path
        || null,
      docker_path: probeFields.docker_path || null,
      pitlane_path: probeFields.pitlane_path || null,
      pitlane_version: probeFields.pitlane_version || null,
      workspace_root_exists: probeFields.workspace_root_exists === "1",
      repo_root_exists: probeFields.repo_root_exists === "1",
      runtime_root_exists: probeFields.runtime_root_exists === "1",
      config_present: probeFields.config_present === "1",
      auth_present: probeFields.auth_present === "1",
    },
  };

  await writeTextAtomic(
    path.join(hostsRoot, "bootstrap-last-run.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  return summary;
}

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadRuntimeConfig } from "../config/runtime-config.js";
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
  removePitlaneMcpServerConfigText,
  resolvePitlaneCodexPluginCachePath,
  resolvePitlaneCodexPluginSource,
} from "../runtime/pitlane-codex-plugin.js";
import {
  discoverCodexPluginHookTrustEntries,
  ensureCodexPluginHookTrustConfigText,
  summarizeCodexPluginHookTrustEntries,
} from "../runtime/codex-plugin-hook-trust.js";
import { writeTextAtomic } from "../state/file-utils.js";

const COPY_EXCLUDES = new Set([
  ".git",
  "WORKSPACE_GUIDE.md",
  "WORKSPACE_GUIDE.local.md",
  "__pycache__",
  "node_modules",
]);
const COPY_EXCLUDED_SUFFIXES = [".pyc", ".pyo", ".pyd"];

async function copyDirectoryFiltered(sourcePath, targetPath) {
  await fs.rm(targetPath, { force: true, recursive: true });
  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
  await copyDirectoryEntries(sourcePath, targetPath);
}

async function copyDirectoryEntries(sourcePath, targetPath) {
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      COPY_EXCLUDES.has(entry.name)
      || COPY_EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      continue;
    }
    const sourceEntry = path.join(sourcePath, entry.name);
    const targetEntry = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(targetEntry, { recursive: true, mode: 0o700 });
      await copyDirectoryEntries(sourceEntry, targetEntry);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(sourceEntry, targetEntry);
      const stats = await fs.stat(sourceEntry);
      await fs.chmod(targetEntry, stats.mode & 0o777).catch(() => null);
    }
  }
}

async function syncPlugin({
  cachePath,
  executableRelativePath,
  label,
  source,
}) {
  if (!source.sourcePath) {
    return {
      status: "disabled",
      mode: source.mode,
      reason: source.reason,
      source_path: null,
      cache_path: cachePath,
      warning: source.warning,
    };
  }

  const sourcePath = path.resolve(source.sourcePath);
  const targetPath = path.resolve(cachePath);
  if (sourcePath !== targetPath) {
    await copyDirectoryFiltered(sourcePath, targetPath);
  }

  await fs.access(path.join(targetPath, ".codex-plugin", "plugin.json"));
  await fs.access(path.join(targetPath, "hooks", "hooks.json"));
  const executablePath = path.join(targetPath, executableRelativePath);
  await fs.access(executablePath);
  await fs.chmod(executablePath, 0o700).catch(() => null);

  return {
    status: "synced",
    mode: source.mode,
    source_path: sourcePath,
    cache_path: targetPath,
    warning: null,
    label,
  };
}

export function renderCodexPluginSyncConfigText(configText, {
  rtkSynced = false,
  rtkHookTrustEntries = [],
  pitlaneSynced = false,
  pitlaneHookTrustEntries = [],
} = {}) {
  const withoutPitlaneMcp = removePitlaneMcpServerConfigText(configText);
  const withRtk = rtkSynced
    ? ensureWorkspaceRtkCodexPluginConfigText(withoutPitlaneMcp)
    : removeWorkspaceRtkCodexPluginConfigText(withoutPitlaneMcp);
  const withPitlane = pitlaneSynced
    ? ensurePitlaneCodexPluginConfigText(withRtk)
    : removePitlaneCodexPluginConfigText(withRtk);
  return ensureCodexPluginHookTrustConfigText(withPitlane, [
    ...rtkHookTrustEntries,
    ...pitlaneHookTrustEntries,
  ]);
}

async function main() {
  const config = await loadRuntimeConfig();
  const codexRoot = path.dirname(config.codexConfigPath);
  const configText = await fs.readFile(config.codexConfigPath, "utf8");

  const rtkSource = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot,
    pluginMode: config.rtkPluginMode,
    pluginPath: config.rtkPluginPath,
  });
  const pitlaneSource = await resolvePitlaneCodexPluginSource({
    codexRoot,
    pluginMode: config.pitlanePluginMode,
    pluginPath: config.pitlanePluginPath,
  });

  const rtk = await syncPlugin({
    cachePath: resolveWorkspaceRtkCodexPluginCachePath(codexRoot),
    executableRelativePath: path.join("hooks", "rtk-codex-hook"),
    label: "rtk",
    source: rtkSource,
  });
  const pitlane = await syncPlugin({
    cachePath: resolvePitlaneCodexPluginCachePath(codexRoot),
    executableRelativePath: path.join("hooks", "pitlane-codex-hook"),
    label: "pitlane",
    source: pitlaneSource,
  });
  const rtkHookTrustEntries = rtk.status === "synced"
    ? await discoverCodexPluginHookTrustEntries({
      pluginId: RTK_CODEX_PLUGIN_CONFIG_KEY,
      pluginRoot: rtk.cache_path,
    })
    : [];
  const pitlaneHookTrustEntries = pitlane.status === "synced"
    ? await discoverCodexPluginHookTrustEntries({
      pluginId: PITLANE_CODEX_PLUGIN_CONFIG_KEY,
      pluginRoot: pitlane.cache_path,
    })
    : [];

  const renderedConfigText = renderCodexPluginSyncConfigText(configText, {
    rtkHookTrustEntries,
    pitlaneSynced: pitlane.status === "synced",
    pitlaneHookTrustEntries,
    rtkSynced: rtk.status === "synced",
  });
  await writeTextAtomic(config.codexConfigPath, renderedConfigText);
  await fs.chmod(config.codexConfigPath, 0o600).catch(() => null);

  const summary = {
    codex_root: codexRoot,
    config_path: config.codexConfigPath,
    rtk_codex_plugin: rtk,
    pitlane_codex_plugin: pitlane,
    hook_trust: {
      rtk: summarizeCodexPluginHookTrustEntries(rtkHookTrustEntries),
      pitlane: summarizeCodexPluginHookTrustEntries(pitlaneHookTrustEntries),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`codex plugin sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

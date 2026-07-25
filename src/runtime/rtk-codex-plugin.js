import fs from "node:fs/promises";
import path from "node:path";

const RTK_CODEX_PLUGIN_NAME = "rtk-codex-plugin";
const RTK_CODEX_PLUGIN_MARKETPLACE = "community-local";
export const RTK_CODEX_PLUGIN_CONFIG_KEY =
  `${RTK_CODEX_PLUGIN_NAME}@${RTK_CODEX_PLUGIN_MARKETPLACE}`;
export const RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH =
  `plugins/cache/${RTK_CODEX_PLUGIN_MARKETPLACE}/${RTK_CODEX_PLUGIN_NAME}/local`;

function normalizeConfigText(text) {
  const normalized = String(text ?? "").replace(/\r\n/gu, "\n").trimEnd();
  return normalized ? normalized.split("\n") : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ensureTomlTableKeys(lines, tableHeader, entries) {
  let headerIndex = lines.findIndex((line) => line.trim() === tableHeader);
  if (headerIndex < 0) {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    headerIndex = lines.length;
    lines.push(tableHeader);
  }

  let tableEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/u.test(lines[index])) {
      tableEnd = index;
      break;
    }
  }

  const missing = [];
  for (const [key, value] of entries) {
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
    let foundIndex = -1;
    for (let index = headerIndex + 1; index < tableEnd; index += 1) {
      if (keyPattern.test(lines[index])) {
        foundIndex = index;
        break;
      }
    }

    const assignment = `${key} = ${value}`;
    if (foundIndex >= 0) {
      lines[foundIndex] = assignment;
    } else {
      missing.push(assignment);
    }
  }

  if (missing.length > 0) {
    lines.splice(headerIndex + 1, 0, ...missing);
  }
}

export function ensureWorkspaceRtkCodexPluginConfigText(configText) {
  const lines = normalizeConfigText(configText);
  ensureTomlTableKeys(lines, "[features]", [
    ["plugins", "true"],
    ["plugin_hooks", "true"],
  ]);
  ensureTomlTableKeys(lines, `[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`, [
    ["enabled", "true"],
  ]);
  return `${lines.join("\n")}\n`;
}

export function removeWorkspaceRtkCodexPluginConfigText(configText) {
  const pluginHeader = `[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`;
  const lines = normalizeConfigText(configText);
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== pluginHeader) {
      output.push(line);
      continue;
    }

    index += 1;
    while (index < lines.length && !/^\s*\[/u.test(lines[index])) {
      index += 1;
    }
    index -= 1;
  }

  return `${output.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

export function resolveWorkspaceRtkCodexPluginCachePath(codexRoot) {
  if (!codexRoot) {
    return null;
  }
  return path.posix.join(codexRoot, RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
}

async function directoryExists(directoryPath) {
  if (!directoryPath) {
    return false;
  }
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function resolveWorkspaceRtkCodexPluginSource({
  codexRoot,
  pluginMode = "off",
  pluginPath = null,
} = {}) {
  const mode = String(pluginMode || "off").trim().toLowerCase();
  if (mode === "off") {
    return {
      mode,
      reason: "disabled-by-config",
      sourcePath: null,
      status: "disabled",
      warning: "workspace RTK Codex plugin disabled by TELEDEX_RTK_PLUGIN_MODE=off.",
    };
  }

  const configuredPath = String(pluginPath || "").trim();
  if (configuredPath) {
    if (await directoryExists(configuredPath)) {
      return {
        mode: "path",
        reason: null,
        sourcePath: path.resolve(configuredPath),
        status: "enabled",
        warning: null,
      };
    }
    return {
      mode: "path",
      reason: "configured-path-missing",
      sourcePath: null,
      status: "disabled",
      warning: `workspace RTK Codex plugin disabled: TELEDEX_RTK_PLUGIN_PATH is not a readable directory: ${configuredPath}`,
    };
  }

  if (mode === "path") {
    return {
      mode,
      reason: "configured-path-missing",
      sourcePath: null,
      status: "disabled",
      warning: "workspace RTK Codex plugin disabled: TELEDEX_RTK_PLUGIN_MODE=path requires TELEDEX_RTK_PLUGIN_PATH.",
    };
  }

  const cachePath = resolveWorkspaceRtkCodexPluginCachePath(codexRoot);
  if (await directoryExists(cachePath)) {
    return {
      mode: "github",
      reason: null,
      sourcePath: cachePath,
      status: "enabled",
      warning: null,
    };
  }

  return {
    mode,
    reason: "cache-missing",
    sourcePath: null,
    status: "disabled",
    warning: "workspace RTK Codex plugin disabled: set TELEDEX_RTK_PLUGIN_PATH or install the plugin in the Codex cache.",
  };
}

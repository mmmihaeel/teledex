import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const HOOK_EVENT_KEY_LABELS = new Map([
  ["PreToolUse", "pre_tool_use"],
  ["PermissionRequest", "permission_request"],
  ["PostToolUse", "post_tool_use"],
  ["PreCompact", "pre_compact"],
  ["PostCompact", "post_compact"],
  ["SessionStart", "session_start"],
  ["UserPromptSubmit", "user_prompt_submit"],
  ["Stop", "stop"],
]);

function normalizeConfigText(text) {
  const normalized = String(text ?? "").replace(/\r\n/gu, "\n").trimEnd();
  return normalized ? normalized.split("\n") : [];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function tomlBasicString(value) {
  return JSON.stringify(String(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalJson(value[key]);
    }
    return output;
  }
  return value;
}

export function versionForHookIdentity(value) {
  const serialized = JSON.stringify(canonicalJson(value));
  return `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
}

function hookKey(keySource, eventName, groupIndex, handlerIndex) {
  const eventKey = HOOK_EVENT_KEY_LABELS.get(eventName);
  if (!eventKey) {
    throw new Error(`Unsupported Codex hook event: ${eventName}`);
  }
  return `${keySource}:${eventKey}:${groupIndex}:${handlerIndex}`;
}

function commandHookHash(eventName, group, handler) {
  const eventKey = HOOK_EVENT_KEY_LABELS.get(eventName);
  if (!eventKey) {
    throw new Error(`Unsupported Codex hook event: ${eventName}`);
  }
  const timeout = Math.max(1, Number(handler.timeout ?? 600) || 600);
  const normalizedGroup = {
    hooks: [{
      type: "command",
      command: String(handler.command ?? ""),
      timeout,
      async: Boolean(handler.async),
      statusMessage: handler.statusMessage ?? null,
    }],
  };
  if (group.matcher != null) {
    normalizedGroup.matcher = String(group.matcher);
  }
  return versionForHookIdentity({
    event_name: eventKey,
    ...normalizedGroup,
  });
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function resolveManifestHookPaths(pluginRoot, manifest) {
  const hooks = manifest?.hooks;
  if (!hooks) {
    return [path.join(pluginRoot, "hooks", "hooks.json")];
  }
  if (typeof hooks === "string") {
    return [path.resolve(pluginRoot, hooks)];
  }
  if (Array.isArray(hooks) && hooks.every((entry) => typeof entry === "string")) {
    return hooks.map((entry) => path.resolve(pluginRoot, entry));
  }
  return [];
}

function sourceRelativePath(pluginRoot, hookFilePath) {
  return path.relative(pluginRoot, hookFilePath).replace(/\\/gu, "/");
}

export async function discoverCodexPluginHookTrustEntries({
  pluginId,
  pluginRoot,
} = {}) {
  if (!pluginId) {
    throw new Error("pluginId is required");
  }
  if (!pluginRoot) {
    return [];
  }

  const resolvedPluginRoot = path.resolve(pluginRoot);
  const manifest = await readJsonFile(
    path.join(resolvedPluginRoot, ".codex-plugin", "plugin.json"),
  );
  const hookFilePaths = resolveManifestHookPaths(resolvedPluginRoot, manifest);
  const entries = [];

  for (const hookFilePath of hookFilePaths) {
    const hooksFile = await readJsonFile(hookFilePath);
    const hooks = hooksFile?.hooks && typeof hooksFile.hooks === "object"
      ? hooksFile.hooks
      : {};
    const keySource = `${pluginId}:${sourceRelativePath(resolvedPluginRoot, hookFilePath)}`;
    for (const [eventName, groups] of Object.entries(hooks)) {
      if (!HOOK_EVENT_KEY_LABELS.has(eventName) || !Array.isArray(groups)) {
        continue;
      }
      for (const [groupIndex, group] of groups.entries()) {
        const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
        for (const [handlerIndex, handler] of handlers.entries()) {
          if (handler?.type !== "command") {
            continue;
          }
          entries.push({
            key: hookKey(keySource, eventName, groupIndex, handlerIndex),
            trustedHash: commandHookHash(eventName, group, handler),
            eventName,
            matcher: group.matcher ?? null,
            command: String(handler.command ?? ""),
          });
        }
      }
    }
  }

  return entries;
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

export function ensureCodexPluginHookTrustConfigText(configText, trustEntries = []) {
  const lines = normalizeConfigText(configText);
  for (const entry of trustEntries) {
    ensureTomlTableKeys(lines, `[hooks.state.${tomlBasicString(entry.key)}]`, [
      ["trusted_hash", tomlBasicString(entry.trustedHash)],
    ]);
  }
  return `${lines.join("\n")}\n`;
}

export function summarizeCodexPluginHookTrustEntries(trustEntries = []) {
  return trustEntries.map((entry) => ({
    key: entry.key,
    trusted_hash: entry.trustedHash,
    event_name: entry.eventName,
    matcher: entry.matcher,
    command: entry.command,
  }));
}

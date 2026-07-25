import path from "node:path";

import {
  RTK_CODEX_PLUGIN_CONFIG_KEY,
  resolveWorkspaceRtkCodexPluginCachePath,
} from "../../runtime/rtk-codex-plugin.js";
import {
  PITLANE_CODEX_PLUGIN_CONFIG_KEY,
  resolvePitlaneCodexPluginCachePath,
} from "../../runtime/pitlane-codex-plugin.js";
import { shellQuote } from "../host-command-runner.js";
import { REQUIRED_HOST_NODE_MAJOR } from "../host-runtime-constants.js";
import { buildOperatorToolbeltProbeScript } from "../operator-toolbelt.js";

const DEFAULT_CODEX_SPACE_FRESHNESS_MULTIPLIER = 3;
const MIN_CODEX_SPACE_MAX_AGE_SECS = 60;

const CODEX_SPACE_FRESHNESS_SCRIPT = `
const fs = require("node:fs");
const [filePath, maxAgeRaw, field] = process.argv.slice(1);
const maxAgeSecs = Number(maxAgeRaw);
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
} catch (error) {
  console.error(\`invalid json: \${error.message}\`);
  process.exit(1);
}
const value = parsed?.[field];
const timestampMs = Date.parse(value);
if (!Number.isFinite(timestampMs)) {
  console.error(\`missing or invalid \${field}\`);
  process.exit(1);
}
const ageSecs = Math.floor((Date.now() - timestampMs) / 1000);
if (ageSecs < -300) {
  console.error(\`\${field} is too far in the future: \${value}\`);
  process.exit(1);
}
if (ageSecs > maxAgeSecs) {
  console.error(\`stale \${field}: \${value} age_secs=\${ageSecs} max_age_secs=\${maxAgeSecs}\`);
  process.exit(1);
}
`;

const WORKER_MCP_CONFIG_SCRIPT = String.raw`
import fs from "node:fs";

const [
  configPath,
  hostId,
  hostCapabilitiesJson = "[]",
  sharedHostSshTarget = "local",
  mcpPreset = "none",
] = process.argv.slice(1);
const text = fs.readFileSync(configPath, "utf8");
const blocks = new Map();
let currentName = null;
let currentLines = null;
let hostCapabilities = [];
try {
  const parsedCapabilities = JSON.parse(hostCapabilitiesJson);
  if (Array.isArray(parsedCapabilities)) {
    hostCapabilities = parsedCapabilities.map((value) => String(value));
  }
} catch {
  hostCapabilities = [];
}
const declaredCapabilities = new Set(hostCapabilities);

function parseTomlTableKey(rawKey) {
  const raw = String(rawKey || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

function flushCurrent() {
  if (currentName != null && currentLines != null) {
    blocks.set(currentName, currentLines);
  }
  currentName = null;
  currentLines = null;
}

for (const line of text.split(/\r?\n/u)) {
  const header = line.match(
    /^\s*\[mcp_servers\.((?:"(?:\\.|[^"\\])*")|(?:'[^']*')|(?:[A-Za-z0-9_-]+))\]\s*$/u
  );
  if (header) {
    flushCurrent();
    currentName = parseTomlTableKey(header[1]);
    currentLines = [line];
    continue;
  }
  if (/^\s*\[/u.test(line)) {
    flushCurrent();
    continue;
  }
  if (currentLines != null) {
    currentLines.push(line);
  }
}
flushCurrent();

if (mcpPreset === "none") {
  if (blocks.size > 0) {
    console.error(
      "unexpected MCP entries for TELEDEX_MCP_PRESET=none: "
        + Array.from(blocks.keys()).join(", ")
    );
    process.exit(1);
  }
  process.exit(0);
}

const required = [
  "scout",
  "requests",
  "playwright",
  "context7",
  "tavily",
  "agent_secret_broker",
];
const legacyPitlaneMcpBlockMarkers = [
  ["mcp", "pitlane"].join("-"),
  ["pitlane", "compact", "mcp"].join("-"),
  ["pitlane", "sse", "gateway"].join("-"),
];
const expectedCommandArgs = new Map([
  ["scout", ["docker", "exec", "-i", "mcp-project-scout", "node", "src/index.js", "--stdio"]],
  ["requests", ["docker", "exec", "-i", "mcp-requests", "mcp-server-requests"]],
  ["playwright", ["docker", "exec", "-i", "mcp-playwright", "start-playwright-mcp"]],
  ["context7", ["docker", "exec", "-i", "mcp-context7", "context7-mcp"]],
  ["tavily", ["docker", "exec", "-i", "mcp-tavily", "tavily-mcp"]],
  ["agent_secret_broker", ["docker", "exec", "-i", "agent-secret-broker", "node", "src/index.js"]],
]);
const requiredLocal = new Map([
  ["docker", ["exec", "-i", "mcp-docker", "mcp-server-docker"]],
]);
const optionalLocal = new Map([
  [
    "requests",
    {
      capability: "mcp-requests",
      args: ["exec", "-i", "mcp-requests", "mcp-server-requests"],
    },
  ],
  [
    "playwright",
    {
      capability: "mcp-playwright",
      args: [
        "exec",
        "-i",
        "-e",
        "PLAYWRIGHT_USER_DATA_DIR=/data/playwright-profile/profile-codex",
        "mcp-playwright",
        "start-playwright-mcp",
      ],
    },
  ],
]);
const reservedMcpBlock = Array.from(blocks.entries()).find(([name, lines]) =>
  name === "pitlane"
  || legacyPitlaneMcpBlockMarkers.some((marker) => lines.join("\n").includes(marker))
);
if (reservedMcpBlock) {
  console.error("worker profile must not include reserved or legacy pitlane server: " + reservedMcpBlock[0]);
  process.exit(1);
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^\x24{}()|[\]\\]/gu, "\\$&");
}
function tomlString(value) {
  return JSON.stringify(String(value));
}
function quotedTomlSequence(values) {
  return values.map((value) => escapeRegExp(tomlString(value))).join("\\s*,\\s*");
}
const missing = required.filter((name) => !blocks.has(name));
if (missing.length > 0) {
  console.error("missing shared MCP entries: " + missing.join(", "));
  process.exit(1);
}

const nonSsh = required.find((name) => {
  const block = (blocks.get(name) || []).join("\n");
  return (
    !/^\s*command\s*=\s*"ssh"\s*$/mu.test(block) ||
    !(new RegExp(quotedTomlSequence(["-T", sharedHostSshTarget]), "u")).test(block) ||
    !(new RegExp(quotedTomlSequence(expectedCommandArgs.get(name)), "u")).test(block)
  );
});
if (nonSsh) {
  console.error("shared MCP entry does not use direct " + sharedHostSshTarget + " stdio command: " + nonSsh);
  process.exit(1);
}

const missingLocal = Array.from(requiredLocal.keys()).filter((name) => !blocks.has(name));
if (missingLocal.length > 0) {
  console.error("missing host-local MCP entries: " + missingLocal.join(", "));
  process.exit(1);
}

const nonLocal = Array.from(requiredLocal.entries()).find(([name, args]) => {
  const block = (blocks.get(name) || []).join("\n");
  return (
    !/^\s*command\s*=\s*"docker"\s*$/mu.test(block) ||
    !(new RegExp(quotedTomlSequence(args), "u")).test(block)
  );
});
if (nonLocal) {
  console.error("host-local MCP entry does not use local docker command: " + nonLocal[0]);
  process.exit(1);
}

const stalePrefixedDocker = Array.from(blocks.keys()).find((name) => /-docker$/u.test(name));
if (stalePrefixedDocker) {
  console.error("worker docker MCP must be the unqualified host-local entry: " + stalePrefixedDocker);
  process.exit(1);
}

const wrongLocal = Array.from(blocks.keys()).find((name) =>
  /-(?:playwright|requests)$/u.test(name) && !name.startsWith(hostId + "-")
);
if (wrongLocal) {
  console.error("host-local MCP entry is not prefixed with " + hostId + ": " + wrongLocal);
  process.exit(1);
}

const missingDeclaredOptionalLocal = Array.from(optionalLocal.entries()).find(([suffix, spec]) => {
  const name = hostId + "-" + suffix;
  return declaredCapabilities.has(spec.capability) && !blocks.has(name);
});
if (missingDeclaredOptionalLocal) {
  console.error("missing optional host-local MCP entry for declared host capability: " + hostId + "-" + missingDeclaredOptionalLocal[0]);
  process.exit(1);
}

const undeclaredOptionalLocal = Array.from(optionalLocal.entries()).find(([suffix, spec]) => {
  const name = hostId + "-" + suffix;
  return blocks.has(name) && !declaredCapabilities.has(spec.capability);
});
if (undeclaredOptionalLocal) {
  console.error("optional host-local MCP entry is not declared by host capability: " + hostId + "-" + undeclaredOptionalLocal[0]);
  process.exit(1);
}

const wrongOptionalLocal = Array.from(optionalLocal.entries()).find(([suffix, spec]) => {
  const name = hostId + "-" + suffix;
  if (!blocks.has(name)) {
    return false;
  }
  const block = (blocks.get(name) || []).join("\n");
  return (
    !/^\s*command\s*=\s*"docker"\s*$/mu.test(block) ||
    !(new RegExp(quotedTomlSequence(spec.args), "u")).test(block)
  );
});
if (wrongOptionalLocal) {
  console.error("optional host-local MCP entry does not use local docker command: " + hostId + "-" + wrongOptionalLocal[0]);
  process.exit(1);
}
`;

export function buildExistsScript(kind, targetPath) {
  if (!targetPath) {
    return "exit 1";
  }

  return [
    `target=${shellQuote(targetPath)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
    `test -${kind} "$target"`,
  ].join("; ");
}

export function resolveCodexSpaceFreshnessMaxAgeSecs(hostSyncIntervalMinutes) {
  const intervalMinutes = Number(hostSyncIntervalMinutes);
  const safeIntervalMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0
    ? intervalMinutes
    : 15;
  return Math.max(
    MIN_CODEX_SPACE_MAX_AGE_SECS,
    Math.ceil(
      safeIntervalMinutes * 60 * DEFAULT_CODEX_SPACE_FRESHNESS_MULTIPLIER,
    ),
  );
}

export function buildJsonTimestampFreshnessScript(targetPath, {
  field = "generated_at",
  maxAgeSecs,
} = {}) {
  if (!targetPath || !maxAgeSecs) {
    return "exit 1";
  }

  return [
    `target=${shellQuote(targetPath)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
    `test -f "$target"`,
    `node -e ${shellQuote(CODEX_SPACE_FRESHNESS_SCRIPT)} "$target" ${shellQuote(String(maxAgeSecs))} ${shellQuote(field)}`,
  ].join("; ");
}

export function buildSupportedNodeRuntimeScript() {
  return [
    'command -v node >/dev/null 2>&1',
    `node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(Number.isFinite(major) && major >= ${REQUIRED_HOST_NODE_MAJOR} ? 0 : 1)'`,
  ].join("; ");
}

export function buildOperatorToolbeltScript() {
  return buildOperatorToolbeltProbeScript({ failOnMissing: true });
}

export function buildCodexRtkPluginReadinessScript(configPath) {
  if (!configPath) {
    return "exit 1";
  }

  const codexRoot = path.posix.dirname(configPath);
  const pluginPath = resolveWorkspaceRtkCodexPluginCachePath(codexRoot);
  return [
    `config_path=${shellQuote(configPath)}`,
    `plugin_root=${shellQuote(pluginPath)}`,
    'if [[ "$config_path" == "~" ]]; then config_path="$HOME"; elif [[ "$config_path" == "~/"* ]]; then config_path="$HOME/${config_path:2}"; fi',
    'if [[ "$plugin_root" == "~" ]]; then plugin_root="$HOME"; elif [[ "$plugin_root" == "~/"* ]]; then plugin_root="$HOME/${plugin_root:2}"; fi',
    'test -f "$config_path"',
    'test -f "$plugin_root/.codex-plugin/plugin.json"',
    'test -f "$plugin_root/hooks/hooks.json"',
    'test -x "$plugin_root/hooks/rtk-codex-hook"',
    'grep -Eq "^[[:space:]]*plugins[[:space:]]*=[[:space:]]*true" "$config_path"',
    'grep -Eq "^[[:space:]]*plugin_hooks[[:space:]]*=[[:space:]]*true" "$config_path"',
    `grep -Fq ${shellQuote(`[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`)} "$config_path"`,
  ].join("; ");
}

export function buildCodexPitlaneCleanupScript(configPath) {
  if (!configPath) {
    return "exit 1";
  }

  const codexRoot = path.posix.dirname(configPath);
  const pitlanePluginPath = resolvePitlaneCodexPluginCachePath(codexRoot);
  return [
    `config_path=${shellQuote(configPath)}`,
    `pitlane_plugin_root=${shellQuote(pitlanePluginPath)}`,
    'if [[ "$config_path" == "~" ]]; then config_path="$HOME"; elif [[ "$config_path" == "~/"* ]]; then config_path="$HOME/${config_path:2}"; fi',
    'if [[ "$pitlane_plugin_root" == "~" ]]; then pitlane_plugin_root="$HOME"; elif [[ "$pitlane_plugin_root" == "~/"* ]]; then pitlane_plugin_root="$HOME/${pitlane_plugin_root:2}"; fi',
    'if [[ ! -f "$config_path" || ! -f "$pitlane_plugin_root/.codex-plugin/plugin.json" || ! -f "$pitlane_plugin_root/hooks/hooks.json" || ! -x "$pitlane_plugin_root/hooks/pitlane-codex-hook" ]]; then echo "Pitlane plugin cache is missing hooks/pitlane-codex-hook" >&2; exit 1; fi',
    'legacy_container="$(printf "%s-%s" mcp pitlane)"',
    'legacy_entrypoint="$(printf "%s-%s-%s" pitlane compact mcp)"',
    'legacy_sse="$(printf "%s-%s-%s" pitlane sse gateway)"',
    `reserved_table_re=${shellQuote("^[[:space:]]*\\[mcp_servers\\.(\"pitlane\"|'pitlane'|pitlane)\\][[:space:]]*$")}`,
    'if grep -Eq "$reserved_table_re" "$config_path" || grep -Fq "$legacy_container" "$config_path" || grep -Fq "$legacy_entrypoint" "$config_path" || grep -Fq "$legacy_sse" "$config_path"; then echo "reserved or legacy pitlane MCP config remains" >&2; exit 1; fi',
    `rtk_header=${shellQuote(`[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`)}`,
    `pitlane_header=${shellQuote(`[plugins."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"]`)}`,
    'if ! grep -Fq "$pitlane_header" "$config_path"; then echo "Pitlane plugin config is missing" >&2; exit 1; fi',
    'rtk_line="$(grep -nF "$rtk_header" "$config_path" | head -n 1 | cut -d: -f1)"',
    'pitlane_line="$(grep -nF "$pitlane_header" "$config_path" | head -n 1 | cut -d: -f1)"',
    'if [[ -n "$rtk_line" && -n "$pitlane_line" && "$rtk_line" -ge "$pitlane_line" ]]; then echo "RTK plugin must be configured before Pitlane plugin" >&2; exit 1; fi',
    'if [[ -d "$pitlane_plugin_root" ]] && grep -R -F -q "$legacy_container" "$pitlane_plugin_root"; then echo "legacy pitlane MCP marker remains in Pitlane plugin cache" >&2; exit 1; fi',
  ].join("; ");
}

export function buildCodexPluginHooksTrustedScript(configPath) {
  if (!configPath) {
    return "exit 1";
  }

  const codexRoot = path.posix.dirname(configPath);
  const rtkPluginPath = resolveWorkspaceRtkCodexPluginCachePath(codexRoot);
  const pitlanePluginPath = resolvePitlaneCodexPluginCachePath(codexRoot);
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [configPath, rtkPluginRoot, pitlanePluginRoot] = process.argv.slice(2);
const plugins = [
  {
    id: "rtk-codex-plugin@community-local",
    root: rtkPluginRoot,
  },
  {
    id: "pitlane-codex-plugin@community-local",
    root: pitlanePluginRoot,
  },
];
const eventLabels = new Map([
  ["PreToolUse", "pre_tool_use"],
  ["PermissionRequest", "permission_request"],
  ["PostToolUse", "post_tool_use"],
  ["PreCompact", "pre_compact"],
  ["PostCompact", "post_compact"],
  ["SessionStart", "session_start"],
  ["UserPromptSubmit", "user_prompt_submit"],
  ["Stop", "stop"],
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
}

function stripTomlInlineComment(line) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let result = "";
  for (const char of String(line)) {
    if (doubleQuoted && escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (doubleQuoted && char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (!doubleQuoted && char === "'") {
      singleQuoted = !singleQuoted;
      result += char;
      continue;
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      result += char;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === "#") {
      break;
    }
    result += char;
  }
  return result.trim();
}

function normalizeTomlDottedKey(rawName) {
  const raw = String(rawName || "");
  const parts = [];
  let index = 0;
  while (index < raw.length) {
    while (/\s/u.test(raw[index] || "")) {
      index += 1;
    }
    if (raw[index] === ".") {
      index += 1;
      continue;
    }
    if (index >= raw.length) {
      break;
    }
    if (raw[index] === '"') {
      let value = '"';
      index += 1;
      let escaped = false;
      for (; index < raw.length; index += 1) {
        const char = raw[index];
        value += char;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          index += 1;
          break;
        }
      }
      try {
        parts.push(JSON.stringify(JSON.parse(value)));
      } catch {
        return raw.trim();
      }
      continue;
    }
    if (raw[index] === "'") {
      index += 1;
      let value = "";
      for (; index < raw.length && raw[index] !== "'"; index += 1) {
        value += raw[index];
      }
      if (raw[index] !== "'") {
        return raw.trim();
      }
      index += 1;
      parts.push(JSON.stringify(value));
      continue;
    }
    let value = "";
    for (; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === "." || /\s/u.test(char)) {
        break;
      }
      value += char;
    }
    if (!value) {
      return raw.trim();
    }
    parts.push(value);
  }
  return parts.length > 0 ? parts.join(".") : raw.trim();
}

function tomlTables(configText) {
  const tables = new Map();
  let currentName = null;
  let currentLines = [];
  const flush = () => {
    if (currentName != null) {
      tables.set(currentName, currentLines);
    }
    currentName = null;
    currentLines = [];
  };
  for (const line of configText.split(/\r?\n/u)) {
    const uncommented = stripTomlInlineComment(line);
    const header = uncommented.match(/^\[([^\]]+)\]$/u);
    if (header) {
      flush();
      currentName = normalizeTomlDottedKey(header[1]);
      currentLines = [];
      continue;
    }
    if (/^\s*\[/u.test(uncommented)) {
      flush();
      continue;
    }
    if (currentName != null) {
      currentLines.push(line);
    }
  }
  flush();
  return tables;
}

function tomlAssignmentValue(blockLines, keyName) {
  for (const line of blockLines || []) {
    const uncommented = stripTomlInlineComment(line);
    if (!uncommented) {
      continue;
    }
    const equals = uncommented.indexOf("=");
    if (equals < 0) {
      continue;
    }
    if (uncommented.slice(0, equals).trim() === keyName) {
      return uncommented.slice(equals + 1).trim();
    }
  }
  return null;
}

function tomlBoolean(blockLines, keyName) {
  const value = tomlAssignmentValue(blockLines, keyName);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function tomlString(blockLines, keyName) {
  const value = tomlAssignmentValue(blockLines, keyName);
  if (value == null) {
    return null;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonical(value[key]);
    }
    return output;
  }
  return value;
}

function versionForHookIdentity(value) {
  return "sha256:" + crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function hookHash(eventName, group, handler) {
  const eventKey = eventLabels.get(eventName);
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
  return versionForHookIdentity({ event_name: eventKey, ...normalizedGroup });
}

function pluginTableStatus(tables, pluginId) {
  const block = tables.get("plugins." + JSON.stringify(pluginId));
  if (!block) {
    return { present: false, enabled: false };
  }
  const enabled = tomlBoolean(block, "enabled");
  return {
    present: true,
    enabled: enabled !== false,
  };
}

function featureEnabled(tables, name) {
  return tomlBoolean(tables.get("features"), name) === true;
}

function hookStateBlock(tables, key) {
  return tables.get("hooks.state." + JSON.stringify(key)) || null;
}

function resolveManifestHookPaths(pluginRoot, manifest) {
  if (!manifest.hooks) {
    return [path.join(pluginRoot, "hooks", "hooks.json")];
  }
  if (typeof manifest.hooks === "string") {
    return [path.resolve(pluginRoot, manifest.hooks)];
  }
  if (Array.isArray(manifest.hooks) && manifest.hooks.every((entry) => typeof entry === "string")) {
    return manifest.hooks.map((entry) => path.resolve(pluginRoot, entry));
  }
  return [];
}

function discover(plugin) {
  const manifestPath = path.join(plugin.root, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = [];
  for (const hookFilePath of resolveManifestHookPaths(plugin.root, manifest)) {
    const hooksFile = JSON.parse(fs.readFileSync(hookFilePath, "utf8"));
    const hooks = hooksFile.hooks && typeof hooksFile.hooks === "object" ? hooksFile.hooks : {};
    const relativePath = path.relative(plugin.root, hookFilePath).replace(/\\/g, "/");
    const keySource = plugin.id + ":" + relativePath;
    for (const [eventName, groups] of Object.entries(hooks)) {
      if (!eventLabels.has(eventName) || !Array.isArray(groups)) {
        continue;
      }
      for (const [groupIndex, group] of groups.entries()) {
        const handlers = Array.isArray(group.hooks) ? group.hooks : [];
        for (const [handlerIndex, handler] of handlers.entries()) {
          if (handler && handler.type === "command") {
            const eventKey = eventLabels.get(eventName);
            entries.push({
              key: keySource + ":" + eventKey + ":" + groupIndex + ":" + handlerIndex,
              hash: hookHash(eventName, group, handler),
              command: String(handler.command ?? ""),
            });
          }
        }
      }
    }
  }
  return entries;
}

const configText = fs.readFileSync(configPath, "utf8");
const tables = tomlTables(configText);
const pluginStatuses = plugins.map((plugin) => ({
  plugin,
  status: pluginTableStatus(tables, plugin.id),
}));
const disabledConfiguredPlugin = pluginStatuses.find(({ status }) =>
  status.present && !status.enabled
);
if (disabledConfiguredPlugin) {
  fail("Codex plugin hook is inactive: " + disabledConfiguredPlugin.plugin.id);
}
const enabledPlugins = pluginStatuses
  .filter(({ status }) => status.enabled)
  .map(({ plugin }) => plugin);
if (enabledPlugins.length === 0) {
  process.exit(0);
}
if (!featureEnabled(tables, "plugins") || !featureEnabled(tables, "plugin_hooks")) {
  fail("Codex plugin hooks are configured but [features].plugins/plugin_hooks are not both true");
}

for (const plugin of enabledPlugins) {
  if (!fs.existsSync(path.join(plugin.root, ".codex-plugin", "plugin.json"))
    || !fs.existsSync(path.join(plugin.root, "hooks", "hooks.json"))) {
    fail("Codex plugin hook cache is missing for " + plugin.id);
  }
  const entries = discover(plugin);
  if (entries.length === 0) {
    fail("Codex plugin has no command hook declarations: " + plugin.id);
  }
  for (const entry of entries) {
    const executablePath = entry.command.replaceAll("\${PLUGIN_ROOT}", plugin.root);
    if (!fs.existsSync(executablePath) || !(fs.statSync(executablePath).mode & 0o111)) {
      fail("Codex plugin hook command is not executable: " + entry.key);
    }
    const block = hookStateBlock(tables, entry.key);
    if (!block) {
      fail("Codex plugin hook is untrusted: " + entry.key);
    }
    if (tomlBoolean(block, "enabled") === false) {
      fail("Codex plugin hook is disabled: " + entry.key);
    }
    const trustedHash = tomlString(block, "trusted_hash");
    if (trustedHash !== entry.hash) {
      fail("Codex plugin hook trusted_hash mismatch: " + entry.key);
    }
  }
}
`;

  return [
    `config_path=${shellQuote(configPath)}`,
    `rtk_plugin_root=${shellQuote(rtkPluginPath)}`,
    `pitlane_plugin_root=${shellQuote(pitlanePluginPath)}`,
    'if [[ "$config_path" == "~" ]]; then config_path="$HOME"; elif [[ "$config_path" == "~/"* ]]; then config_path="$HOME/${config_path:2}"; fi',
    'if [[ "$rtk_plugin_root" == "~" ]]; then rtk_plugin_root="$HOME"; elif [[ "$rtk_plugin_root" == "~/"* ]]; then rtk_plugin_root="$HOME/${rtk_plugin_root:2}"; fi',
    'if [[ "$pitlane_plugin_root" == "~" ]]; then pitlane_plugin_root="$HOME"; elif [[ "$pitlane_plugin_root" == "~/"* ]]; then pitlane_plugin_root="$HOME/${pitlane_plugin_root:2}"; fi',
    `node - "$config_path" "$rtk_plugin_root" "$pitlane_plugin_root" <<'NODE'\n${script}\nNODE`,
  ].join("\n");
}

export function buildCodexExecHelpScript(executablePath) {
  if (!executablePath) {
    return "exit 1";
  }

  if (/[\\/]/u.test(executablePath) || executablePath.startsWith("~")) {
    return [
      `target=${shellQuote(executablePath)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'test -x "$target"',
      '"$target" exec --help >/dev/null 2>&1',
    ].join("; ");
  }

  return [
    `name=${shellQuote(executablePath)}`,
    'command -v -- "$name" >/dev/null',
    '"$name" exec --help >/dev/null 2>&1',
  ].join("; ");
}

export function buildWorkerMcpConfigScript(
  configPath,
  hostId,
  hostCapabilities = [],
  sharedHostSshTarget = "local",
  { mcpPreset = "none" } = {},
) {
  if (!configPath || !hostId || hostId === "local") {
    return "true";
  }

  const capabilities = Array.isArray(hostCapabilities)
    ? hostCapabilities.map((value) => String(value))
    : [];

  return [
    `target=${shellQuote(configPath)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
    'test -f "$target"',
    `node --input-type=module -e ${shellQuote(WORKER_MCP_CONFIG_SCRIPT)} "$target" ${shellQuote(hostId)} ${shellQuote(JSON.stringify(capabilities))} ${shellQuote(sharedHostSshTarget)} ${shellQuote(mcpPreset)}`,
  ].join("; ");
}

export function buildDockerRuntimeScript() {
  return [
    'command -v docker >/dev/null 2>&1',
    'docker info >/dev/null 2>&1',
    'docker compose version >/dev/null 2>&1',
  ].join("; ");
}

export function buildHostLocalPitlaneScript() {
  return [
    "command -v pitlane >/dev/null 2>&1",
    "pitlane --version >/dev/null 2>&1",
  ].join("; ");
}

export function buildHostLocalDockerMcpScript() {
  return [
    'command -v docker >/dev/null 2>&1',
    'docker info >/dev/null 2>&1',
    "proxy_status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' docker-socket-proxy 2>/dev/null || true)",
    '[[ "$proxy_status" == "healthy" || "$proxy_status" == "true" ]]',
    'docker exec docker-socket-proxy wget -qO- http://localhost:2375/_ping >/dev/null',
    "mcp_status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' mcp-docker 2>/dev/null || true)",
    '[[ "$mcp_status" == "healthy" || "$mcp_status" == "true" ]]',
  ].join("; ");
}

export function buildHostLocalMcpContainerScript(containerName) {
  return [
    'command -v docker >/dev/null 2>&1',
    'docker info >/dev/null 2>&1',
    `status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' ${shellQuote(containerName)} 2>/dev/null || true)`,
    '[[ "$status" == "healthy" || "$status" == "true" ]]',
  ].join("; ");
}

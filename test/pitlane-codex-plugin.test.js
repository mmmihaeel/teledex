import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { renderCodexPluginSyncConfigText } from "../src/cli/codex-plugin-sync.js";
import {
  PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH,
  PITLANE_CODEX_PLUGIN_CONFIG_KEY,
  ensurePitlaneCodexPluginConfigText,
  removePitlaneCodexPluginConfigText,
  removePitlaneMcpServerConfigText,
  resolvePitlaneCodexPluginCachePath,
  resolvePitlaneCodexPluginSource,
} from "../src/runtime/pitlane-codex-plugin.js";
import { mkdtempForTest } from "../test-support/tmp.js";

test("ensurePitlaneCodexPluginConfigText enables plugins, hook execution, and Pitlane plugin", () => {
  const rendered = ensurePitlaneCodexPluginConfigText([
    'model = "gpt-5.4"',
    "",
    "[features]",
    "plugins = false",
    "",
    '[plugins."other@local"]',
    "enabled = true",
    "",
  ].join("\n"));

  assert.match(rendered, /^\[features\]\nplugin_hooks = true\nplugins = true$/mu);
  assert.match(
    rendered,
    new RegExp(`^\\[plugins\\."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"\\]\nenabled = true$`, "mu"),
  );
  assert.match(rendered, /^\[plugins\."other@local"\]\nenabled = true$/mu);
});

test("removePitlaneCodexPluginConfigText removes only the Pitlane plugin table", () => {
  const rendered = removePitlaneCodexPluginConfigText([
    'model = "gpt-5.4"',
    "",
    `[plugins."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"]`,
    "enabled = true",
    "",
    '[plugins."other@local"]',
    "enabled = true",
    "",
  ].join("\n"));

  assert.doesNotMatch(rendered, new RegExp(PITLANE_CODEX_PLUGIN_CONFIG_KEY, "u"));
  assert.match(rendered, /^\[plugins\."other@local"\]\nenabled = true$/mu);
});

test("removePitlaneMcpServerConfigText removes only the reserved pitlane MCP table", () => {
  const reservedName = ["pit", "lane"].join("");
  const rendered = removePitlaneMcpServerConfigText([
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.requests]",
    'command = "docker"',
    "",
    `[mcp_servers.${reservedName}]`,
    'command = "docker"',
    'args = ["exec", "-i", "legacy-code-intel"]',
    "",
    "[mcp_servers.scout]",
    'command = "docker"',
    "",
  ].join("\n"));

  assert.doesNotMatch(rendered, /^\[mcp_servers\.pitlane\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.requests\]\ncommand = "docker"$/mu);
  assert.match(rendered, /^\[mcp_servers\.scout\]\ncommand = "docker"$/mu);
});

test("removePitlaneMcpServerConfigText removes quoted reserved pitlane MCP table", () => {
  const reservedName = ["pit", "lane"].join("");
  const quotedReservedTable = `[mcp_servers.'${reservedName}']`;
  const rendered = removePitlaneMcpServerConfigText([
    'model = "gpt-5.4"',
    "",
    quotedReservedTable,
    'command = "docker"',
    "",
  ].join("\n"));

  assert.doesNotMatch(rendered, new RegExp(`^\\[mcp_servers\\.'${reservedName}'\\]$`, "mu"));
  assert.match(rendered, /^model = "gpt-5\.4"$/mu);
});

test("renderCodexPluginSyncConfigText removes old pitlane MCP and keeps hook plugins", () => {
  const reservedName = ["pit", "lane"].join("");
  const rendered = renderCodexPluginSyncConfigText([
    'model = "gpt-5.4"',
    "",
    "[features]",
    "plugins = false",
    "",
    "[mcp_servers.requests]",
    'command = "docker"',
    "",
    `[mcp_servers.${reservedName}]`,
    'command = "docker"',
    "",
  ].join("\n"), {
    pitlaneSynced: true,
    rtkSynced: true,
  });

  assert.doesNotMatch(rendered, /^\[mcp_servers\.pitlane\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.requests\]\ncommand = "docker"$/mu);
  assert.match(rendered, /^plugin_hooks = true$/mu);
  assert.match(rendered, new RegExp(`^\\[plugins\\."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"\\]$`, "mu"));
});

test("renderCodexPluginSyncConfigText writes trusted plugin hook state", () => {
  const rendered = renderCodexPluginSyncConfigText('model = "gpt-5.5"\n', {
    pitlaneSynced: true,
    rtkSynced: true,
    rtkHookTrustEntries: [{
      key: "rtk-codex-plugin@community-local:hooks/hooks.json:pre_tool_use:0:0",
      trustedHash: "sha256:rtk",
    }],
    pitlaneHookTrustEntries: [{
      key: "pitlane-codex-plugin@community-local:hooks/hooks.json:pre_tool_use:0:0",
      trustedHash: "sha256:pitlane",
    }],
  });

  assert.match(
    rendered,
    /^\[hooks\.state\."rtk-codex-plugin@community-local:hooks\/hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:rtk"$/mu,
  );
  assert.match(
    rendered,
    /^\[hooks\.state\."pitlane-codex-plugin@community-local:hooks\/hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:pitlane"$/mu,
  );
});

test("Pitlane Codex plugin cache path resolves from the Codex root", () => {
  assert.equal(
    resolvePitlaneCodexPluginCachePath("~/.codex"),
    `~/.codex/${PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH}`,
  );
});

test("resolvePitlaneCodexPluginSource prefers an explicit configured path", async (t) => {
  const root = await mkdtempForTest(t, "pitlane-plugin-source-");
  const configuredPath = path.join(root, "custom-pitlane");
  const cachePath = path.join(root, ".codex", PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(configuredPath, { recursive: true });
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolvePitlaneCodexPluginSource({
    codexRoot: path.join(root, ".codex"),
    pluginMode: "github",
    pluginPath: configuredPath,
  });

  assert.equal(resolved.status, "enabled");
  assert.equal(resolved.mode, "path");
  assert.equal(resolved.sourcePath, configuredPath);
});

test("resolvePitlaneCodexPluginSource falls back to the Codex cache", async (t) => {
  const root = await mkdtempForTest(t, "pitlane-plugin-cache-");
  const codexRoot = path.join(root, ".codex");
  const cachePath = path.join(codexRoot, PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolvePitlaneCodexPluginSource({
    codexRoot,
    pluginMode: "github",
  });

  assert.equal(resolved.status, "enabled");
  assert.equal(resolved.mode, "github");
  assert.equal(resolved.sourcePath, cachePath);
});

test("resolvePitlaneCodexPluginSource requires a configured path in path mode", async (t) => {
  const root = await mkdtempForTest(t, "pitlane-plugin-path-mode-");
  const codexRoot = path.join(root, ".codex");
  const cachePath = path.join(codexRoot, PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolvePitlaneCodexPluginSource({
    codexRoot,
    pluginMode: "path",
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.mode, "path");
  assert.equal(resolved.reason, "configured-path-missing");
  assert.match(resolved.warning, /TELEDEX_PITLANE_PLUGIN_PATH/u);
});

test("resolvePitlaneCodexPluginSource disables Pitlane with a warning when no source exists", async (t) => {
  const root = await mkdtempForTest(t, "pitlane-plugin-missing-");

  const resolved = await resolvePitlaneCodexPluginSource({
    codexRoot: path.join(root, ".codex"),
    pluginMode: "github",
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.reason, "cache-missing");
  assert.match(resolved.warning, /TELEDEX_PITLANE_PLUGIN_PATH/u);
});

test("resolvePitlaneCodexPluginSource honors TELEDEX_PITLANE_PLUGIN_MODE=off", async (t) => {
  const root = await mkdtempForTest(t, "pitlane-plugin-off-");
  const configuredPath = path.join(root, "custom-pitlane");
  await fs.mkdir(configuredPath, { recursive: true });

  const resolved = await resolvePitlaneCodexPluginSource({
    codexRoot: path.join(root, ".codex"),
    pluginMode: "off",
    pluginPath: configuredPath,
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.reason, "disabled-by-config");
});

test("resolvePitlaneCodexPluginSource defaults to Pitlane disabled", async (t) => {
  const root = await mkdtempForTest(t, "pitlane-plugin-default-off-");
  const codexRoot = path.join(root, ".codex");
  const cachePath = path.join(codexRoot, PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolvePitlaneCodexPluginSource({
    codexRoot,
    pluginMode: null,
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.mode, "off");
  assert.equal(resolved.reason, "disabled-by-config");
});

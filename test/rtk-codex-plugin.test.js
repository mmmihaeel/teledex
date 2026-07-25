import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH,
  RTK_CODEX_PLUGIN_CONFIG_KEY,
  ensureWorkspaceRtkCodexPluginConfigText,
  removeWorkspaceRtkCodexPluginConfigText,
  resolveWorkspaceRtkCodexPluginCachePath,
  resolveWorkspaceRtkCodexPluginSource,
} from "../src/runtime/rtk-codex-plugin.js";
import { mkdtempForTest } from "../test-support/tmp.js";

test("ensureWorkspaceRtkCodexPluginConfigText enables plugins, hook execution, and workspace RTK plugin", () => {
  const rendered = ensureWorkspaceRtkCodexPluginConfigText([
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
    new RegExp(`^\\[plugins\\."${RTK_CODEX_PLUGIN_CONFIG_KEY}"\\]\\nenabled = true$`, "mu"),
  );
  assert.match(rendered, /^\[plugins\."other@local"\]\nenabled = true$/mu);
});

test("removeWorkspaceRtkCodexPluginConfigText removes only the workspace RTK plugin table", () => {
  const rendered = removeWorkspaceRtkCodexPluginConfigText([
    'model = "gpt-5.4"',
    "",
    `[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`,
    "enabled = true",
    "",
    '[plugins."other@local"]',
    "enabled = true",
    "",
  ].join("\n"));

  assert.doesNotMatch(rendered, new RegExp(RTK_CODEX_PLUGIN_CONFIG_KEY, "u"));
  assert.match(rendered, /^\[plugins\."other@local"\]\nenabled = true$/mu);
});

test("workspace RTK Codex plugin cache path resolves from the Codex root", () => {
  assert.equal(
    resolveWorkspaceRtkCodexPluginCachePath("~/.codex"),
    `~/.codex/${RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH}`,
  );
});

test("resolveWorkspaceRtkCodexPluginSource prefers an explicit configured path", async (t) => {
  const root = await mkdtempForTest(t, "rtk-plugin-source-");
  const configuredPath = path.join(root, "custom-rtk");
  const cachePath = path.join(root, ".codex", RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(configuredPath, { recursive: true });
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot: path.join(root, ".codex"),
    pluginMode: "github",
    pluginPath: configuredPath,
  });

  assert.equal(resolved.status, "enabled");
  assert.equal(resolved.mode, "path");
  assert.equal(resolved.sourcePath, configuredPath);
});

test("resolveWorkspaceRtkCodexPluginSource falls back to the Codex cache", async (t) => {
  const root = await mkdtempForTest(t, "rtk-plugin-cache-");
  const codexRoot = path.join(root, ".codex");
  const cachePath = path.join(codexRoot, RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot,
    pluginMode: "github",
  });

  assert.equal(resolved.status, "enabled");
  assert.equal(resolved.mode, "github");
  assert.equal(resolved.sourcePath, cachePath);
});

test("resolveWorkspaceRtkCodexPluginSource requires a configured path in path mode", async (t) => {
  const root = await mkdtempForTest(t, "rtk-plugin-path-mode-");
  const codexRoot = path.join(root, ".codex");
  const cachePath = path.join(codexRoot, RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot,
    pluginMode: "path",
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.mode, "path");
  assert.equal(resolved.reason, "configured-path-missing");
  assert.match(resolved.warning, /TELEDEX_RTK_PLUGIN_PATH/u);
});

test("resolveWorkspaceRtkCodexPluginSource disables RTK with a warning when no source exists", async (t) => {
  const root = await mkdtempForTest(t, "rtk-plugin-missing-");

  const resolved = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot: path.join(root, ".codex"),
    pluginMode: "github",
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.reason, "cache-missing");
  assert.match(resolved.warning, /TELEDEX_RTK_PLUGIN_PATH/u);
});

test("resolveWorkspaceRtkCodexPluginSource honors TELEDEX_RTK_PLUGIN_MODE=off", async (t) => {
  const root = await mkdtempForTest(t, "rtk-plugin-off-");
  const configuredPath = path.join(root, "custom-rtk");
  await fs.mkdir(configuredPath, { recursive: true });

  const resolved = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot: path.join(root, ".codex"),
    pluginMode: "off",
    pluginPath: configuredPath,
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.reason, "disabled-by-config");
});

test("resolveWorkspaceRtkCodexPluginSource defaults to RTK disabled", async (t) => {
  const root = await mkdtempForTest(t, "rtk-plugin-default-off-");
  const codexRoot = path.join(root, ".codex");
  const cachePath = path.join(codexRoot, RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH);
  await fs.mkdir(cachePath, { recursive: true });

  const resolved = await resolveWorkspaceRtkCodexPluginSource({
    codexRoot,
    pluginMode: null,
  });

  assert.equal(resolved.status, "disabled");
  assert.equal(resolved.mode, "off");
  assert.equal(resolved.reason, "disabled-by-config");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCodexChildEnv } from "../src/runtime/codex-child-env.js";

test("buildCodexChildEnv keeps runtime basics and strips Teledex secrets", () => {
  const env = buildCodexChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/example",
    OPENAI_API_KEY: "openai-secret",
    DEEPSEEK_API_KEY: "deepseek-secret",
    OPENROUTER_API_KEY: "openrouter-secret",
    CODEX_HOME: "/home/example/.codex",
    CODEX_CONFIG_PATH: "/home/example/.codex/config.toml",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    TELEGRAM_FORUM_CHAT_ID: "-100",
    ENV_FILE: "/state/runtime.env",
    STATE_ROOT: "/state",
    HOST_REGISTRY_PATH: "/state/hosts/registry-state.toml",
    TELEDEX_BACKEND: "exec-json",
    CODEX_GATEWAY_BACKEND: "exec-json",
    CODEX_MODEL: "gpt-5.5",
    AGENT_DEBUG_TOKEN: "hidden",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/example");
  assert.equal(env.OPENAI_API_KEY, "openai-secret");
  assert.equal(env.DEEPSEEK_API_KEY, "deepseek-secret");
  assert.equal(env.OPENROUTER_API_KEY, "openrouter-secret");
  assert.equal(env.CODEX_HOME, "/home/example/.codex");
  assert.equal(env.CODEX_CONFIG_PATH, "/home/example/.codex/config.toml");
  assert.equal("TELEGRAM_BOT_TOKEN" in env, false);
  assert.equal("TELEGRAM_FORUM_CHAT_ID" in env, false);
  assert.equal("ENV_FILE" in env, false);
  assert.equal("STATE_ROOT" in env, false);
  assert.equal("HOST_REGISTRY_PATH" in env, false);
  assert.equal("TELEDEX_BACKEND" in env, false);
  assert.equal("CODEX_GATEWAY_BACKEND" in env, false);
  assert.equal("CODEX_MODEL" in env, false);
  assert.equal("AGENT_DEBUG_TOKEN" in env, false);
});

test("buildCodexChildEnv blocks removed gateway env aliases even when injected", () => {
  const env = buildCodexChildEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/example",
    },
    {
      extraEnv: {
        CODEX_GATEWAY_BACKEND: "app-server-v2",
      },
      extraAllowedEnvNames: ["CODEX_GATEWAY_BACKEND"],
    },
  );

  assert.equal("CODEX_GATEWAY_BACKEND" in env, false);
});

test("buildCodexChildEnv passes Codex hook bypass env without PATH wrappers", () => {
  const disabled = buildCodexChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/example",
    PITLANE_CODEX_BYPASS: "1",
    PITLANE_CODEX_HOOK_DISABLE: "1",
    PITLANE_DISABLE: "1",
    PITLANE_DISABLED: "1",
    RTK_CODEX_BYPASS: "1",
    RTK_CODEX_HOOK_DISABLE: "1",
    RTK_DISABLE: "1",
    RTK_DISABLED: "1",
    RTK_DISABLE_WRAPPERS: "1",
    RTK_WRAPPERS_DISABLE: "1",
  });
  const legacyWrapperEnv = buildCodexChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/example",
    RTK_WRAPPER_DIR: "/tmp/rtk-wrap",
  });

  assert.equal(disabled.PATH, "/usr/bin");
  assert.equal(disabled.PITLANE_CODEX_BYPASS, "1");
  assert.equal(disabled.PITLANE_CODEX_HOOK_DISABLE, "1");
  assert.equal(disabled.PITLANE_DISABLE, "1");
  assert.equal(disabled.PITLANE_DISABLED, "1");
  assert.equal(disabled.RTK_CODEX_BYPASS, "1");
  assert.equal(disabled.RTK_CODEX_HOOK_DISABLE, "1");
  assert.equal(disabled.RTK_DISABLE, "1");
  assert.equal(disabled.RTK_DISABLED, "1");
  assert.equal("RTK_DISABLE_WRAPPERS" in disabled, false);
  assert.equal("RTK_WRAPPERS_DISABLE" in disabled, false);
  assert.equal(legacyWrapperEnv.PATH, "/usr/bin");
  assert.equal("RTK_WRAPPER_DIR" in legacyWrapperEnv, false);
});

test("buildCodexChildEnv canonicalizes Windows Path", () => {
  const env = buildCodexChildEnv(
    {
      PATH: "/usr/local/bin:/usr/bin",
      Path: "C:\\Windows\\System32;C:\\Tools",
      HOME: "C:\\Users\\alice",
      USERPROFILE: "C:\\Users\\alice",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    },
    { platform: "win32" },
  );

  assert.equal(env.Path, "C:\\Windows\\System32;C:\\Tools");
  assert.equal(Object.hasOwn(env, "PATH"), false);
  assert.equal(env.HOME, "C:\\Users\\alice");
});

test("buildCodexChildEnv can load host-local provider env for local Codex runs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provider-env-"));
  const providerEnvPath = path.join(tempDir, "provider-env");
  fs.writeFileSync(
    providerEnvPath,
    [
      "OPENROUTER_API_KEY=from-provider-env",
      "export DEEPSEEK_API_KEY=from-provider-env",
      "CUSTOM_DEEPSEEK_API_KEY=custom-provider-env",
      "TELEGRAM_BOT_TOKEN=must-not-leak",
      "IGNORED_PROVIDER_SECRET=must-not-load",
      "",
    ].join("\n"),
  );

  const env = buildCodexChildEnv(
    {
      PATH: "/usr/bin",
      HOME: tempDir,
      OPENROUTER_API_KEY: "from-process-env",
    },
    {
      extraAllowedEnvNames: ["CUSTOM_DEEPSEEK_API_KEY"],
      loadProviderEnv: true,
      providerEnvPath,
    },
  );

  assert.equal(env.OPENROUTER_API_KEY, "from-provider-env");
  assert.equal(env.DEEPSEEK_API_KEY, "from-provider-env");
  assert.equal(env.CUSTOM_DEEPSEEK_API_KEY, "custom-provider-env");
  assert.equal("TELEGRAM_BOT_TOKEN" in env, false);
  assert.equal("IGNORED_PROVIDER_SECRET" in env, false);
});

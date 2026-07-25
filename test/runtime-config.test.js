import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseEnvText } from "../src/config/env-file.js";
import {
  getDefaultEnvFilePath,
  getDefaultStateRoot,
  getDefaultWorkspaceRoot,
  resolveRuntimeEnvFilePath,
} from "../src/config/default-paths.js";
import {
  buildRuntimeConfig,
  getDefaultCodexBinPath,
  loadRuntimeConfig,
  parseCodexConfigProfile,
} from "../src/config/runtime-config.js";
import { mkdtempForTest } from "../test-support/tmp.js";

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

test("parseEnvText reads comments, exports, and quoted values", () => {
  const env = parseEnvText(`
# comment
export TELEGRAM_ALLOWED_USER_ID=1001001001
TELEGRAM_BOT_TOKEN="secret-token"
TELEGRAM_FORUM_CHAT_ID='-1000000'
TELEGRAM_EXPECTED_TOPICS=General, Test topic 1 , Test topic 2
`);

  assert.equal(env.TELEGRAM_ALLOWED_USER_ID, "1001001001");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "secret-token");
  assert.equal(env.TELEGRAM_FORUM_CHAT_ID, "-1000000");
  assert.equal(
    env.TELEGRAM_EXPECTED_TOPICS,
    "General, Test topic 1 , Test topic 2",
  );
});

test("parseEnvText strips a leading UTF-8 BOM so Windows-edited env files still load", () => {
  const env = parseEnvText("\uFEFFTELEGRAM_BOT_TOKEN=secret-token\r\nTELEGRAM_ALLOWED_USER_ID=1001001001");

  assert.equal(env.TELEGRAM_BOT_TOKEN, "secret-token");
  assert.equal(env.TELEGRAM_ALLOWED_USER_ID, "1001001001");
});

test("getDefaultCodexBinPath prefers codex.cmd on Windows", () => {
  assert.equal(getDefaultCodexBinPath("linux"), "codex");
  assert.equal(getDefaultCodexBinPath("win32"), "codex.cmd");
});

test("default state root is Teledex", () => {
  assert.equal(
    getDefaultStateRoot({
      platform: "linux",
      homeDirectory: "/home/example",
      xdgStateHome: "",
    }),
    "/home/example/.local/state/teledex",
  );
});

test("buildRuntimeConfig validates ids and splits expected topics", () => {
  const config = buildRuntimeConfig({
    ENV_FILE: "/tmp/runtime.env",
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_ALLOWED_BOT_IDS: "1002002002,1003003003",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    TELEGRAM_EXPECTED_TOPICS: "General, Test topic 1, Test topic 2",
    TELEGRAM_POLL_TIMEOUT_SECS: "5",
    TELEDEX_WORKSPACE_ROOT: "/workspace/workspace",
    TELEDEX_STATE_ROOT: "/state/teledex",
    TELEDEX_CODEZ_REPO: "/workspace/codez",
    TELEDEX_RTK_PLUGIN_PATH: "/plugins/rtk",
    TELEDEX_RTK_PLUGIN_MODE: "path",
    TELEDEX_PITLANE_PLUGIN_PATH: "/plugins/pitlane",
    TELEDEX_PITLANE_PLUGIN_MODE: "path",
    TELEDEX_MCP_PRESET: "workspace",
    DEFAULT_SESSION_BINDING_PATH: "/workspace/workspace",
    CODEX_SESSIONS_ROOT: "/tmp/codex-sessions",
    CODEX_LIMITS_SESSIONS_ROOT: "/tmp/codex-limits",
    CODEX_LIMITS_COMMAND: "python3 /tmp/read-limits.py",
    CODEX_LIMITS_CACHE_TTL_SECS: "45",
    CODEX_LIMITS_COMMAND_TIMEOUT_SECS: "9",
    TELEDEX_BACKEND: "app-server",
    TELEDEX_ENABLE_LEGACY_APP_SERVER: "1",
    TELEDEX_ALLOW_SYSTEM_TEMP_DELIVERY: "1",
    CODEX_MODEL: "gpt-5.4",
    CODEX_REASONING_EFFORT: "xhigh",
    CODEX_CONTEXT_WINDOW: "320000",
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: "300000",
    DEEPSEEK_RUNTIME_API_URL: "http://127.0.0.1:7891",
    DEEPSEEK_CODEX_PROVIDER_BASE_URL: "https://example.deepseek.invalid/v1",
    DEEPSEEK_CODEX_PROVIDER_ENV_KEY: "CUSTOM_DEEPSEEK_API_KEY",
    DEEPSEEK_REASONING_EFFORT: "xhigh",
    DEEPSEEK_CONTEXT_WINDOW: "1000000",
    DEEPSEEK_AUTO_COMPACT_TOKEN_LIMIT: "750000",
    DEEPSEEK_RUNTIME_HOST_IDS: "workera, workerb",
    OPENROUTER_CODEX_PROVIDER_BASE_URL: "https://example.openrouter.invalid/api/v1",
    OPENROUTER_CODEX_PROVIDER_ENV_KEY: "CUSTOM_OPENROUTER_API_KEY",
    OPENROUTER_CODEX_PROVIDER_ID: "openrouter-lab",
    OPENROUTER_REASONING_EFFORT: "high",
    OPENROUTER_CONTEXT_WINDOW: "262144",
    OPENROUTER_RUNTIME_HOST_IDS: "workera, workerc",
    CURRENT_HOST_ID: "local",
    HOST_REGISTRY_PATH: "/tmp/hosts/registry-state.toml",
    HOST_REGISTRY_CANONICAL_PATH: "/tmp/fleet/hosts.toml",
    TELEDEX_REGISTRY_MIRROR_ROOT: "/tmp/project-scout/mounts",
    HOST_SYNC_INTERVAL_MINUTES: "20",
    HOST_SSH_CONNECT_TIMEOUT_SECS: "11",
  });

  assert.equal(config.envFilePath, "/tmp/runtime.env");
  assert.equal(config.stateRoot, "/state/teledex");
  assert.equal(config.workspaceRootPath, "/workspace/workspace");
  assert.equal(config.codezRepoPath, "/workspace/codez");
  assert.equal(config.rtkPluginPath, "/plugins/rtk");
  assert.equal(config.rtkPluginMode, "path");
  assert.equal(config.pitlanePluginPath, "/plugins/pitlane");
  assert.equal(config.pitlanePluginMode, "path");
  assert.equal(config.mcpPreset, "workspace");
  assert.equal(config.defaultSessionBindingPath, "/workspace/workspace");
  assert.equal(config.currentHostId, "local");
  assert.equal(config.hostRegistryPath, "/tmp/hosts/registry-state.toml");
  assert.equal(config.hostRegistryCanonicalPath, "/tmp/fleet/hosts.toml");
  assert.equal(config.registryMirrorRoot, "/tmp/project-scout/mounts");
  assert.equal(config.hostSyncIntervalMinutes, 20);
  assert.equal(config.hostSshConnectTimeoutSecs, 11);
  assert.equal(config.codexBinPath, getDefaultCodexBinPath());
  assert.equal(config.codexSessionsRoot, "/tmp/codex-sessions");
  assert.equal(config.codexLimitsSessionsRoot, "/tmp/codex-limits");
  assert.equal(config.codexLimitsCommand, "python3 /tmp/read-limits.py");
  assert.equal(config.codexLimitsCacheTtlSecs, 45);
  assert.equal(config.codexLimitsCommandTimeoutSecs, 9);
  assert.equal(config.codexGatewayBackend, "app-server");
  assert.equal(config.codexEnableLegacyAppServer, true);
  assert.equal(config.codexEnableAppServerV2, false);
  assert.equal(config.allowSystemTempDelivery, true);
  assert.equal(config.codexModel, "gpt-5.4");
  assert.equal(config.codexReasoningEffort, "xhigh");
  assert.equal(config.codexContextWindow, 320000);
  assert.equal(config.codexAutoCompactTokenLimit, 300000);
  assert.equal(config.deepSeekRuntimeApiUrl, "http://127.0.0.1:7891");
  assert.equal(
    config.deepSeekCodexProviderBaseUrl,
    "https://example.deepseek.invalid/v1",
  );
  assert.equal(config.deepSeekCodexProviderEnvKey, "CUSTOM_DEEPSEEK_API_KEY");
  assert.equal(config.deepSeekReasoningEffort, "xhigh");
  assert.equal(config.deepSeekContextWindow, 1000000);
  assert.equal(config.deepSeekAutoCompactTokenLimit, null);
  assert.deepEqual(config.deepSeekRuntimeHostIds, ["workera", "workerb"]);
  assert.equal(
    config.openRouterCodexProviderBaseUrl,
    "https://example.openrouter.invalid/api/v1",
  );
  assert.equal(config.openRouterCodexProviderEnvKey, "CUSTOM_OPENROUTER_API_KEY");
  assert.equal(config.openRouterCodexProviderId, "openrouter-lab");
  assert.equal(config.openRouterReasoningEffort, "high");
  assert.equal(config.openRouterContextWindow, 262144);
  assert.equal(config.openRouterAutoCompactTokenLimit, null);
  assert.deepEqual(config.openRouterRuntimeHostIds, ["workera", "workerc"]);
  assert.equal(config.telegramAllowedUserId, "1001001001");
  assert.deepEqual(config.telegramAllowedUserIds, ["1001001001"]);
  assert.deepEqual(config.telegramAllowedBotIds, [
    "1002002002",
    "1003003003",
  ]);
  assert.equal(config.telegramForumChatId, "-1000000");
  assert.equal(config.telegramPollTimeoutSecs, 5);
  assert.equal(config.maxParallelSessions, 10);
  assert.equal(config.parkedSessionRetentionHours, 168);
  assert.equal(config.retentionSweepIntervalSecs, 60);
  assert.deepEqual(config.telegramExpectedTopics, [
    "General",
    "Test topic 1",
    "Test topic 2",
  ]);
});

test("buildRuntimeConfig defaults host registry canonical path to project registry host config", () => {
  const config = buildRuntimeConfig({
    REPO_ROOT: "/path/to/workspace/apps/teledex",
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
  });

  assert.equal(
    config.hostRegistryCanonicalPath,
    "/path/to/workspace/apps/project-scout/config/hosts.toml",
  );
  assert.equal(
    config.registryMirrorRoot,
    path.join(path.dirname(getDefaultStateRoot()), "project-scout", "mounts"),
  );
  assert.deepEqual(config.deepSeekRuntimeHostIds, []);
  assert.equal(config.deepSeekCodexProviderBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(config.deepSeekCodexProviderEnvKey, "DEEPSEEK_API_KEY");
  assert.deepEqual(config.openRouterRuntimeHostIds, []);
  assert.equal(config.openRouterCodexProviderBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.openRouterCodexProviderEnvKey, "OPENROUTER_API_KEY");
  assert.equal(config.openRouterCodexProviderId, "openrouter");
  assert.equal(config.openRouterReasoningEffort, "high");
  assert.equal(config.openRouterContextWindow, null);
});

test("parseCodexConfigProfile extracts MCP server names from the Codex config", () => {
  const profile = parseCodexConfigProfile(`
model = "gpt-5.4"

[mcp_servers.requests]
command = "docker"

[mcp_servers.scout]
command = "node"

[mcp_servers.requests]
command = "docker"
`);

  assert.deepEqual(profile.mcpServerNames, ["requests", "scout"]);
});

test("buildRuntimeConfig keeps the parsed Codex config path and MCP server list", () => {
  const config = buildRuntimeConfig(
    {
      TELEGRAM_BOT_TOKEN: "secret-token",
      TELEGRAM_ALLOWED_USER_ID: "1001001001",
      TELEGRAM_FORUM_CHAT_ID: "-1000000",
    },
    {
      configPath: "/home/example/.codex/config.toml",
      mcpServerNames: ["scout", "requests", "tavily"],
    },
  );

  assert.equal(config.codexConfigPath, "/home/example/.codex/config.toml");
  assert.deepEqual(config.codexMcpServerNames, [
    "scout",
    "requests",
    "tavily",
  ]);
});

test("buildRuntimeConfig keeps standalone RTK and MCP defaults neutral", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
  });

  assert.equal(config.rtkPluginMode, "off");
  assert.equal(config.pitlanePluginMode, "off");
  assert.equal(config.mcpPreset, "none");
});

test("buildRuntimeConfig accepts TELEDEX_WORKSPACE_ROOT as the preferred workspace key", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    TELEDEX_WORKSPACE_ROOT: "/srv/teledex-workspace",
    WORKSPACE_ROOT: "O:/workspace",
    DEFAULT_SESSION_BINDING_PATH: "O:/workspace/main-repo",
  });

  assert.equal(config.workspaceRootPath, "/srv/teledex-workspace");
  assert.equal(config.defaultSessionBindingPath, "O:/workspace/main-repo");
});

test("buildRuntimeConfig derives the default env file from TELEDEX_STATE_ROOT", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    TELEDEX_STATE_ROOT: "/srv/teledex-state",
  });

  assert.equal(config.stateRoot, "/srv/teledex-state");
  assert.equal(config.envFilePath, "/srv/teledex-state/runtime.env");
});

test("buildRuntimeConfig keeps WORKSPACE_ROOT as a compatibility alias", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    WORKSPACE_ROOT: "O:/workspace",
  });

  assert.equal(config.workspaceRootPath, "O:/workspace");
});

test("buildRuntimeConfig rejects invalid Teledex configurability presets", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_RTK_PLUGIN_MODE: "workspace",
      }),
    /TELEDEX_RTK_PLUGIN_MODE/u,
  );
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_PITLANE_PLUGIN_MODE: "workspace",
      }),
    /TELEDEX_PITLANE_PLUGIN_MODE/u,
  );
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_MCP_PRESET: "full",
      }),
    /TELEDEX_MCP_PRESET/u,
  );
});

test("buildRuntimeConfig rejects malformed ids", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "not-a-number",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
      }),
    /TELEGRAM_ALLOWED_USER_ID/u,
  );
});

test("buildRuntimeConfig supports multi-user allowlists without the legacy single user key", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_IDS: "1001001001,123456789",
    TELEGRAM_ALLOWED_BOT_IDS: "1002002002",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
  });

  assert.deepEqual(config.telegramAllowedUserIds, [
    "1001001001",
    "123456789",
  ]);
  assert.equal(config.telegramAllowedUserId, "1001001001");
  assert.deepEqual(config.telegramAllowedBotIds, ["1002002002"]);
});

test("buildRuntimeConfig trusts Telegram bots only through TELEGRAM_ALLOWED_BOT_IDS", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_ALLOWED_BOT_IDS: "1002002002",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    AGENT_BOT_ID: "1003003003",
  });

  assert.deepEqual(config.telegramAllowedBotIds, ["1002002002"]);
  assert.equal(Object.hasOwn(config, "agentBotId"), false);
});

test("buildRuntimeConfig defaults public Teledex backend to app-server-v2", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
  });

  assert.equal(config.codexGatewayBackend, "app-server-v2");
});

test("buildRuntimeConfig gates legacy exec-json compatibility", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_BACKEND: "exec-json",
      }),
    /TELEDEX_ENABLE_LEGACY_EXEC_JSON/u,
  );

  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    TELEDEX_BACKEND: "exec-json",
    TELEDEX_ENABLE_LEGACY_EXEC_JSON: "1",
  });

  assert.equal(config.codexGatewayBackend, "exec-json");
});

test("buildRuntimeConfig rejects unknown Teledex backends", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_BACKEND: "websocket-zoo",
      }),
    /TELEDEX_BACKEND/u,
  );
});

test("buildRuntimeConfig rejects legacy app-server backend unless explicitly enabled", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_BACKEND: "app-server",
      }),
    /TELEDEX_ENABLE_LEGACY_APP_SERVER/u,
  );
});

test("buildRuntimeConfig accepts app-server-v2 only behind explicit app-server-v2 gate", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_BACKEND: "app-server-v2",
      }),
    /TELEDEX_ENABLE_APP_SERVER_V2/u,
  );

  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    TELEDEX_BACKEND: "app-server-v2",
    TELEDEX_ENABLE_APP_SERVER_V2: "1",
  });

  assert.equal(config.codexGatewayBackend, "app-server-v2");
  assert.equal(config.codexEnableAppServerV2, true);
});

test("buildRuntimeConfig ignores removed legacy gateway env aliases", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "1001001001",
    TELEGRAM_FORUM_CHAT_ID: "-1000000",
    CODEX_GATEWAY_BACKEND: "app-server-v2",
    CODEX_ENABLE_APP_SERVER_V2: "1",
    CODEX_ALLOW_SYSTEM_TEMP_DELIVERY: "1",
  });
  assert.equal(config.codexGatewayBackend, "app-server-v2");
  assert.equal(config.codexEnableAppServerV2, true);
  assert.equal(config.allowSystemTempDelivery, false);
});

test("buildRuntimeConfig requires Teledex env gates for Teledex backends", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_BACKEND: "app-server-v2",
        CODEX_ENABLE_APP_SERVER_V2: "1",
      }),
    /TELEDEX_ENABLE_APP_SERVER_V2/u,
  );
});

test("buildRuntimeConfig rejects removed lab app-server-v2 gate alias", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        TELEDEX_BACKEND: "app-server-v2",
        CODEX_ENABLE_LAB_APP_SERVER_V2: "1",
      }),
    /TELEDEX_ENABLE_APP_SERVER_V2/u,
  );
});

test("parseCodexConfigProfile reads model and context numbers from codex toml", () => {
  const profile = parseCodexConfigProfile(`
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
model_context_window = 320000
model_auto_compact_token_limit = 300000
`, "/home/example/.codex/config.toml");

  assert.equal(profile.configPath, "/home/example/.codex/config.toml");
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.reasoningEffort, "xhigh");
  assert.equal(profile.contextWindow, 320000);
  assert.equal(profile.autoCompactTokenLimit, 300000);
});

test("parseCodexConfigProfile tolerates leading indentation around top-level keys", () => {
  const profile = parseCodexConfigProfile(`
  model = "gpt-5.4"
  model_reasoning_effort = "high"
  model_context_window = 320000
  model_auto_compact_token_limit = 300000
`);

  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.contextWindow, 320000);
  assert.equal(profile.autoCompactTokenLimit, 300000);
});

test("parseCodexConfigProfile ignores profile table values and unquotes MCP server names", () => {
  const profile = parseCodexConfigProfile(`
model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[profiles.stale]
model = "gpt-5.4"
model_reasoning_effort = "low"

[mcp_servers."agent-secret-broker"]
command = "broker"

[mcp_servers.scout]
command = "node"
`);

  assert.equal(profile.model, "gpt-5.5");
  assert.equal(profile.reasoningEffort, "xhigh");
  assert.deepEqual(profile.mcpServerNames, ["agent-secret-broker", "scout"]);
});

test("default path helpers switch to Windows-friendly state and workspace roots", () => {
  const stateRoot = getDefaultStateRoot({
    platform: "win32",
    homeDirectory: "C:/Users/example",
    localAppData: "C:/Users/example/AppData/Local",
  });
  const workspaceRoot = getDefaultWorkspaceRoot({
    platform: "win32",
    repoRoot: "O:/workspace/teledex",
  });
  const envFilePath = getDefaultEnvFilePath({
    platform: "win32",
    localAppData: "C:/Users/example/AppData/Local",
  });

  assert.equal(
    path.win32.normalize(stateRoot),
    path.win32.join(
      "C:/Users/example/AppData/Local",
      "teledex",
    ),
  );
  assert.equal(
    path.win32.normalize(workspaceRoot),
    path.win32.normalize(
      path.win32.dirname("O:/workspace/teledex"),
    ),
  );
  assert.equal(
    path.win32.normalize(envFilePath),
    path.win32.join(
      "C:/Users/example/AppData/Local",
      "teledex",
      "runtime.env",
    ),
  );
});

test("buildRuntimeConfig applies injected platform defaults consistently", () => {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = "C:/Users/example/AppData/Local";

  let config;
  try {
    config = buildRuntimeConfig(
      {
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_ID: "1001001001",
        TELEGRAM_FORUM_CHAT_ID: "-1000000",
        REPO_ROOT: "O:/workspace/teledex",
      },
      {},
      { platform: "win32" },
    );
  } finally {
    restoreEnvVar("LOCALAPPDATA", previousLocalAppData);
  }

  assert.equal(config.codexBinPath, "codex.cmd");
  assert.equal(
    path.win32.normalize(config.workspaceRootPath),
    path.win32.normalize("O:/workspace"),
  );
  assert.equal(
    path.win32.normalize(config.stateRoot),
    path.win32.join(
      "C:/Users/example/AppData/Local",
      "teledex",
    ),
  );
  assert.equal(
    path.win32.normalize(config.envFilePath),
    path.win32.join(
      "C:/Users/example/AppData/Local",
      "teledex",
      "runtime.env",
    ),
  );
});

test("resolveRuntimeEnvFilePath uses repo-local .env only when fallback is allowed", async (t) => {
  const repoRoot = await mkdtempForTest(t, "teledex-repo-");
  const stateRoot = await mkdtempForTest(t, "teledex-state-");
  const repoEnvPath = path.join(repoRoot, ".env");
  await fs.writeFile(repoEnvPath, "TELEGRAM_BOT_TOKEN=secret\n", "utf8");

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  const resolved = await resolveRuntimeEnvFilePath({
    allowRepoEnvFallback: true,
    repoRoot,
    stateRoot,
  });

  assert.equal(resolved, repoEnvPath);

  const lockedDown = await resolveRuntimeEnvFilePath({
    allowRepoEnvFallback: false,
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);
  assert.equal(lockedDown, path.join(stateRoot, "runtime.env"));
});

test("resolveRuntimeEnvFilePath ignores obsolete legacy state runtime.env", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-env-repo-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-env-state-"));
  const legacyStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsolete-state-"));
  const legacyEnvPath = path.join(legacyStateRoot, "runtime.env");
  await fs.writeFile(legacyEnvPath, "TELEGRAM_BOT_TOKEN=legacy\n", "utf8");

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  try {
    assert.equal(
      await resolveRuntimeEnvFilePath({
        platform: "linux",
        repoRoot,
        stateRoot,
      }),
      path.join(stateRoot, "runtime.env"),
    );
  } finally {
    restoreEnvVar("ENV_FILE", previousEnvFile);
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(legacyStateRoot, { recursive: true, force: true });
  }
});

test("resolveRuntimeEnvFilePath prefers repo-local .env on Windows and state runtime.env on Linux", async (t) => {
  const repoRoot = await mkdtempForTest(t, "teledex-env-repo-");
  const stateRoot = await mkdtempForTest(t, "teledex-env-state-");
  const repoEnvPath = path.join(repoRoot, ".env");
  const stateEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(repoEnvPath, "TELEGRAM_BOT_TOKEN=repo\n", "utf8");
  await fs.writeFile(stateEnvPath, "TELEGRAM_BOT_TOKEN=state\n", "utf8");

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  try {
    assert.equal(
      await resolveRuntimeEnvFilePath({
        platform: "win32",
        repoRoot,
        stateRoot,
      }),
      repoEnvPath,
    );
    assert.equal(
      await resolveRuntimeEnvFilePath({
        platform: "linux",
        repoRoot,
        stateRoot,
        allowRepoEnvFallback: true,
      }),
      stateEnvPath,
    );
  } finally {
    restoreEnvVar("ENV_FILE", previousEnvFile);
  }
});

test("loadRuntimeConfig reads a repo-local .env when explicitly allowed", async (t) => {
  const repoRoot = await mkdtempForTest(t, "teledex-load-config-");
  const stateRoot = await mkdtempForTest(t, "teledex-load-state-");
  await fs.writeFile(
    path.join(repoRoot, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=1001001001",
      "TELEGRAM_FORUM_CHAT_ID=-1000000",
      "TELEDEX_WORKSPACE_ROOT=O:/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  const config = await loadRuntimeConfig({
    allowRepoEnvFallback: true,
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);

  assert.equal(config.envFilePath, path.join(repoRoot, ".env"));
  assert.equal(config.workspaceRootPath, "O:/workspace");
});

test("loadRuntimeConfig repairs runtime env file mode on POSIX", {
  skip: process.platform === "win32",
}, async (t) => {
  const repoRoot = await mkdtempForTest(t, "teledex-load-config-");
  const stateRoot = await mkdtempForTest(t, "teledex-state-root-");
  const runtimeEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(
    runtimeEnvPath,
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=1001001001",
      "TELEGRAM_FORUM_CHAT_ID=-1000000",
      "TELEDEX_WORKSPACE_ROOT=/srv/workspace",
      "",
    ].join("\n"),
    {
      encoding: "utf8",
      mode: 0o644,
    },
  );
  await fs.chmod(runtimeEnvPath, 0o644);

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  const config = await loadRuntimeConfig({
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);

  const stats = await fs.stat(runtimeEnvPath);
  assert.equal(config.envFilePath, runtimeEnvPath);
  assert.equal(stats.mode & 0o777, 0o600);
});

test("loadRuntimeConfig uses shell STATE_ROOT to discover the canonical runtime env", async (t) => {
  const repoRoot = await mkdtempForTest(t, "teledex-load-config-");
  const stateRoot = await mkdtempForTest(t, "teledex-state-root-");
  const runtimeEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(
    runtimeEnvPath,
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=1001001001",
      "TELEGRAM_FORUM_CHAT_ID=-1000000",
      "TELEDEX_WORKSPACE_ROOT=/srv/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  const previousStateRoot = process.env.STATE_ROOT;
  delete process.env.ENV_FILE;
  process.env.STATE_ROOT = stateRoot;

  const config = await loadRuntimeConfig({
    repoRoot,
  });

  restoreEnvVar("ENV_FILE", previousEnvFile);
  restoreEnvVar("STATE_ROOT", previousStateRoot);

  assert.equal(config.envFilePath, runtimeEnvPath);
  assert.equal(config.stateRoot, stateRoot);
  assert.equal(config.workspaceRootPath, "/srv/workspace");
});

test("loadRuntimeConfig lets shell STATE_ROOT override the env file value", async (t) => {
  const repoRoot = await mkdtempForTest(t, "teledex-load-config-");
  const stateRoot = await mkdtempForTest(t, "teledex-shell-state-root-");
  const runtimeEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(
    runtimeEnvPath,
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=1001001001",
      "TELEGRAM_FORUM_CHAT_ID=-1000000",
      "TELEDEX_STATE_ROOT=/tmp/file-state-root",
      "TELEDEX_WORKSPACE_ROOT=/srv/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  const previousStateRoot = process.env.STATE_ROOT;
  process.env.ENV_FILE = runtimeEnvPath;
  process.env.STATE_ROOT = "/tmp/shell-state-root";

  const config = await loadRuntimeConfig({
    repoRoot,
  });

  restoreEnvVar("ENV_FILE", previousEnvFile);
  restoreEnvVar("STATE_ROOT", previousStateRoot);

  assert.equal(config.envFilePath, runtimeEnvPath);
  assert.equal(config.stateRoot, "/tmp/shell-state-root");
});

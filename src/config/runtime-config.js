import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { loadEnvFile } from "./env-file.js";
import {
  getDefaultCodexConfigPath,
  getDefaultCodexSessionsRoot,
  getDefaultEnvFilePath,
  getDefaultRepoRoot,
  getDefaultStateRoot,
  getDefaultWorkspaceRoot,
  resolveRuntimeEnvFilePath,
} from "./default-paths.js";

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECS = 30;
const DEFAULT_MAX_PARALLEL_SESSIONS = 10;
const DEFAULT_PARKED_SESSION_RETENTION_HOURS = 168;
const DEFAULT_RETENTION_SWEEP_INTERVAL_SECS = 60;
const DEFAULT_HOST_SYNC_INTERVAL_MINUTES = 15;
const DEFAULT_HOST_SSH_CONNECT_TIMEOUT_SECS = 8;
const DEFAULT_TELEDEX_BACKEND = "app-server-v2";
const DEFAULT_CODEX_CONFIG_PATH = getDefaultCodexConfigPath();
const DEFAULT_DEEPSEEK_RUNTIME_API_URL = "http://127.0.0.1:7891";
const DEFAULT_DEEPSEEK_CODEX_PROVIDER_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_DEEPSEEK_CODEX_PROVIDER_ENV_KEY = "DEEPSEEK_API_KEY";
const DEFAULT_DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_DEEPSEEK_REASONING_EFFORT = "xhigh";
const DEFAULT_DEEPSEEK_RUNTIME_HOST_IDS = [];
const DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_CODEX_PROVIDER_ENV_KEY = "OPENROUTER_API_KEY";
const DEFAULT_OPENROUTER_CODEX_PROVIDER_ID = "openrouter";
const DEFAULT_OPENROUTER_REASONING_EFFORT = "high";
const DEFAULT_OPENROUTER_RUNTIME_HOST_IDS = [];
const DEFAULT_TELEDEX_RTK_PLUGIN_MODE = "off";
const DEFAULT_TELEDEX_PITLANE_PLUGIN_MODE = "off";
const DEFAULT_TELEDEX_MCP_PRESET = "none";

function readOptionalEnv(rawEnv, key) {
  const value = rawEnv[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function readRequired(rawEnv, key) {
  const value = rawEnv[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required runtime setting: ${key}`);
  }

  return value.trim();
}

function normalizeIntegerString(value, key) {
  if (!/^-?\d+$/u.test(value)) {
    throw new Error(`Expected ${key} to be an integer string, got: ${value}`);
  }

  return value;
}

function parseIntegerList(value, key) {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => normalizeIntegerString(entry, key)),
    ),
  ];
}

function parseTopicList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseHostIdList(value) {
  return parseTopicList(value).map((entry) => entry.toLowerCase());
}

function parsePositiveInteger(value, key, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error(`Expected ${key} to be a positive integer, got: ${value}`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${key} to be > 0, got: ${value}`);
  }

  return parsed;
}

function parseBooleanFlag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseEnumSetting(value, key, fallback, allowedValues) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (allowedValues.includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Invalid ${key}: ${value}. Use one of: ${allowedValues.join(", ")}.`,
  );
}

function parseCodexGatewayBackend(
  value,
  {
    legacyAppServerEnabled = false,
    legacyExecJsonEnabled = false,
    appServerV2Enabled = false,
  } = {},
) {
  const normalized = String(value || DEFAULT_TELEDEX_BACKEND)
    .trim()
    .toLowerCase();
  if (normalized === "app-server") {
    if (legacyAppServerEnabled) {
      return normalized;
    }
    throw new Error(
      "TELEDEX_BACKEND=app-server requires TELEDEX_ENABLE_LEGACY_APP_SERVER=1.",
    );
  }
  if (normalized === "app-server-v2") {
    if (appServerV2Enabled) {
      return "app-server-v2";
    }
    throw new Error(
      "TELEDEX_BACKEND=app-server-v2 requires TELEDEX_ENABLE_APP_SERVER_V2=1.",
    );
  }
  if (normalized === "exec-json") {
    if (legacyExecJsonEnabled) {
      return normalized;
    }
    throw new Error(
      "TELEDEX_BACKEND=exec-json is legacy compatibility only; public Teledex requires Codez App Server v2. Set TELEDEX_ENABLE_LEGACY_EXEC_JSON=1 only for explicit compatibility tests.",
    );
  }

  throw new Error(
    `Invalid TELEDEX_BACKEND: ${value}. Use app-server-v2 with TELEDEX_ENABLE_APP_SERVER_V2=1. Legacy exec-json compatibility requires TELEDEX_ENABLE_LEGACY_EXEC_JSON=1.`,
  );
}

function getDefaultHostRoot(repoRoot) {
  return path.resolve(repoRoot, "../..");
}

function parseTomlScalar(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (/^-?\d+$/u.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function getTopLevelTomlText(text) {
  const lines = [];
  for (const line of String(text || "").split("\n")) {
    if (/^\s*\[/u.test(line)) {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function parseTomlKeyName(rawKey) {
  const parsed = parseTomlScalar(rawKey);
  return typeof parsed === "string" ? parsed.trim() : null;
}

function parseMcpServerNames(text) {
  return [
    ...new Set(
      Array.from(
        String(text || "").matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gmu),
        (match) => parseTomlKeyName(match[1]),
      ).filter(Boolean),
    ),
  ];
}

export function parseCodexConfigProfile(text, configPath = DEFAULT_CODEX_CONFIG_PATH) {
  const topLevelText = getTopLevelTomlText(text);
  const readKey = (key) => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = topLevelText.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.+)$`, "mu"));
    if (!match) {
      return null;
    }

    return parseTomlScalar(match[1]);
  };

  return {
    configPath,
    model: readKey("model"),
    reasoningEffort: readKey("model_reasoning_effort"),
    contextWindow: readKey("model_context_window"),
    autoCompactTokenLimit: readKey("model_auto_compact_token_limit"),
    mcpServerNames: parseMcpServerNames(text),
  };
}

export function getDefaultCodexBinPath(platform = process.platform) {
  return platform === "win32" ? "codex.cmd" : "codex";
}

async function loadCodexConfigProfile(configPath) {
  try {
    const text = await fs.readFile(configPath, "utf8");
    return parseCodexConfigProfile(text, configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        configPath,
        model: null,
        reasoningEffort: null,
        contextWindow: null,
        autoCompactTokenLimit: null,
        mcpServerNames: [],
      };
    }

    throw error;
  }
}

export function buildRuntimeConfig(rawEnv, codexProfile = {}, options = {}) {
  const platform = options.platform || process.platform;
  const repoRoot = rawEnv.REPO_ROOT?.trim() || getDefaultRepoRoot();
  const stateRoot =
    rawEnv.TELEDEX_STATE_ROOT?.trim()
    || rawEnv.STATE_ROOT?.trim()
    || getDefaultStateRoot({ platform });
  const currentHostId =
    rawEnv.CURRENT_HOST_ID?.trim().toLowerCase() || os.hostname().trim().toLowerCase();
  const hostRegistryPath =
    rawEnv.HOST_REGISTRY_PATH?.trim() || path.join(stateRoot, "hosts", "registry-state.toml");
  const hostRegistryCanonicalPath =
    rawEnv.HOST_REGISTRY_CANONICAL_PATH?.trim()
    || path.join(
      getDefaultHostRoot(repoRoot),
      "apps",
      "project-scout",
      "config",
      "hosts.toml",
    );
  const registryMirrorRoot =
    rawEnv.TELEDEX_REGISTRY_MIRROR_ROOT?.trim()
    || path.join(path.dirname(stateRoot), "project-scout", "mounts");
  const envFilePath =
    rawEnv.ENV_FILE?.trim() || getDefaultEnvFilePath({ platform, stateRoot });
  const workspaceRootPath =
    rawEnv.TELEDEX_WORKSPACE_ROOT?.trim()
    || rawEnv.WORKSPACE_ROOT?.trim()
    || rawEnv.TELEDEX_WORKSPACE_ROOT?.trim()
    || getDefaultWorkspaceRoot({ platform, repoRoot });
  const codezRepoPath = rawEnv.TELEDEX_CODEZ_REPO?.trim() || null;
  const rtkPluginPath = rawEnv.TELEDEX_RTK_PLUGIN_PATH?.trim() || null;
  const rtkPluginMode = parseEnumSetting(
    rawEnv.TELEDEX_RTK_PLUGIN_MODE,
    "TELEDEX_RTK_PLUGIN_MODE",
    DEFAULT_TELEDEX_RTK_PLUGIN_MODE,
    ["off", "path", "github"],
  );
  const pitlanePluginPath = rawEnv.TELEDEX_PITLANE_PLUGIN_PATH?.trim() || null;
  const pitlanePluginMode = parseEnumSetting(
    rawEnv.TELEDEX_PITLANE_PLUGIN_MODE,
    "TELEDEX_PITLANE_PLUGIN_MODE",
    DEFAULT_TELEDEX_PITLANE_PLUGIN_MODE,
    ["off", "path", "github"],
  );
  const mcpPreset = parseEnumSetting(
    rawEnv.TELEDEX_MCP_PRESET,
    "TELEDEX_MCP_PRESET",
    DEFAULT_TELEDEX_MCP_PRESET,
    ["none", "workspace"],
  );
  const telegramApiBaseUrl =
    rawEnv.TELEGRAM_API_BASE_URL?.trim() || DEFAULT_TELEGRAM_API_BASE_URL;
  const defaultSessionBindingPath =
    rawEnv.DEFAULT_SESSION_BINDING_PATH?.trim() || workspaceRootPath;
  const codexBinPath =
    rawEnv.CODEX_BIN_PATH?.trim() || getDefaultCodexBinPath(platform);
  const codexConfigPath =
    rawEnv.CODEX_CONFIG_PATH?.trim() ||
    codexProfile.configPath ||
    DEFAULT_CODEX_CONFIG_PATH;
  const codexMcpServerNames = Array.isArray(codexProfile.mcpServerNames)
    ? [...codexProfile.mcpServerNames]
    : [];
  const codexSessionsRoot =
    rawEnv.CODEX_SESSIONS_ROOT?.trim() || getDefaultCodexSessionsRoot();
  const codexLimitsSessionsRoot =
    rawEnv.CODEX_LIMITS_SESSIONS_ROOT?.trim() || codexSessionsRoot;
  const codexLimitsCommand =
    rawEnv.CODEX_LIMITS_COMMAND?.trim() || null;
  const codexLimitsCacheTtlSecs = parsePositiveInteger(
    rawEnv.CODEX_LIMITS_CACHE_TTL_SECS,
    "CODEX_LIMITS_CACHE_TTL_SECS",
    30,
  );
  const codexLimitsCommandTimeoutSecs = parsePositiveInteger(
    rawEnv.CODEX_LIMITS_COMMAND_TIMEOUT_SECS,
    "CODEX_LIMITS_COMMAND_TIMEOUT_SECS",
    15,
  );
  const codexEnableLegacyAppServer = parseBooleanFlag(
    readOptionalEnv(rawEnv, "TELEDEX_ENABLE_LEGACY_APP_SERVER"),
  );
  const codexEnableLegacyExecJson = parseBooleanFlag(
    readOptionalEnv(rawEnv, "TELEDEX_ENABLE_LEGACY_EXEC_JSON"),
  );
  const requestedTeledexBackend = readOptionalEnv(rawEnv, "TELEDEX_BACKEND");
  const codexEnableAppServerV2 =
    parseBooleanFlag(readOptionalEnv(rawEnv, "TELEDEX_ENABLE_APP_SERVER_V2"))
    || !requestedTeledexBackend;
  const allowSystemTempDelivery = parseBooleanFlag(
    readOptionalEnv(rawEnv, "TELEDEX_ALLOW_SYSTEM_TEMP_DELIVERY"),
  );
  const hostSyncIntervalMinutes = parsePositiveInteger(
    rawEnv.HOST_SYNC_INTERVAL_MINUTES,
    "HOST_SYNC_INTERVAL_MINUTES",
    DEFAULT_HOST_SYNC_INTERVAL_MINUTES,
  );
  const hostSshConnectTimeoutSecs = parsePositiveInteger(
    rawEnv.HOST_SSH_CONNECT_TIMEOUT_SECS,
    "HOST_SSH_CONNECT_TIMEOUT_SECS",
    DEFAULT_HOST_SSH_CONNECT_TIMEOUT_SECS,
  );

  const telegramBotToken = readRequired(rawEnv, "TELEGRAM_BOT_TOKEN");
  const legacyAllowedUserId = rawEnv.TELEGRAM_ALLOWED_USER_ID?.trim()
    ? normalizeIntegerString(
        readRequired(rawEnv, "TELEGRAM_ALLOWED_USER_ID"),
        "TELEGRAM_ALLOWED_USER_ID",
      )
    : null;
  const telegramAllowedUserIds = [
    ...new Set([
      ...parseIntegerList(
        rawEnv.TELEGRAM_ALLOWED_USER_IDS,
        "TELEGRAM_ALLOWED_USER_IDS",
      ),
      ...(legacyAllowedUserId ? [legacyAllowedUserId] : []),
    ]),
  ];
  if (telegramAllowedUserIds.length === 0) {
    throw new Error(
      "Missing required runtime setting: TELEGRAM_ALLOWED_USER_ID or TELEGRAM_ALLOWED_USER_IDS",
    );
  }
  const telegramAllowedBotIds = parseIntegerList(
    rawEnv.TELEGRAM_ALLOWED_BOT_IDS,
    "TELEGRAM_ALLOWED_BOT_IDS",
  );
  const telegramForumChatId = normalizeIntegerString(
    readRequired(rawEnv, "TELEGRAM_FORUM_CHAT_ID"),
    "TELEGRAM_FORUM_CHAT_ID",
  );
  return {
    envFilePath,
    repoRoot,
    stateRoot,
    currentHostId,
    hostRegistryPath,
    hostRegistryCanonicalPath,
    registryMirrorRoot,
    workspaceRootPath,
    codezRepoPath,
    rtkPluginPath,
    rtkPluginMode,
    pitlanePluginPath,
    pitlanePluginMode,
    mcpPreset,
    defaultSessionBindingPath,
    codexBinPath,
    codexConfigPath,
    codexMcpServerNames,
    codexSessionsRoot,
    codexGatewayBackend: parseCodexGatewayBackend(
      requestedTeledexBackend,
      {
        legacyAppServerEnabled: codexEnableLegacyAppServer,
        legacyExecJsonEnabled: codexEnableLegacyExecJson,
        appServerV2Enabled: codexEnableAppServerV2,
      },
    ),
    codexEnableLegacyAppServer,
    codexEnableAppServerV2,
    allowSystemTempDelivery,
    codexLimitsSessionsRoot,
    codexLimitsCommand,
    codexLimitsCacheTtlSecs,
    codexLimitsCommandTimeoutSecs,
    hostSyncIntervalMinutes,
    hostSshConnectTimeoutSecs,
    codexModel:
      rawEnv.CODEX_MODEL?.trim() ||
      codexProfile.model ||
      null,
    codexReasoningEffort:
      rawEnv.CODEX_REASONING_EFFORT?.trim() ||
      codexProfile.reasoningEffort ||
      null,
    codexContextWindow: parsePositiveInteger(
      rawEnv.CODEX_CONTEXT_WINDOW,
      "CODEX_CONTEXT_WINDOW",
      codexProfile.contextWindow ?? null,
    ),
    codexAutoCompactTokenLimit: parsePositiveInteger(
      rawEnv.CODEX_AUTO_COMPACT_TOKEN_LIMIT,
      "CODEX_AUTO_COMPACT_TOKEN_LIMIT",
      codexProfile.autoCompactTokenLimit ?? null,
    ),
    deepSeekRuntimeApiUrl:
      rawEnv.DEEPSEEK_RUNTIME_API_URL?.trim()
      || DEFAULT_DEEPSEEK_RUNTIME_API_URL,
    deepSeekCodexProviderBaseUrl:
      rawEnv.DEEPSEEK_CODEX_PROVIDER_BASE_URL?.trim()
      || DEFAULT_DEEPSEEK_CODEX_PROVIDER_BASE_URL,
    deepSeekCodexProviderEnvKey:
      rawEnv.DEEPSEEK_CODEX_PROVIDER_ENV_KEY?.trim()
      || DEFAULT_DEEPSEEK_CODEX_PROVIDER_ENV_KEY,
    deepSeekReasoningEffort:
      rawEnv.DEEPSEEK_REASONING_EFFORT?.trim()
      || DEFAULT_DEEPSEEK_REASONING_EFFORT,
    deepSeekContextWindow: parsePositiveInteger(
      rawEnv.DEEPSEEK_CONTEXT_WINDOW,
      "DEEPSEEK_CONTEXT_WINDOW",
      DEFAULT_DEEPSEEK_CONTEXT_WINDOW,
    ),
    deepSeekAutoCompactTokenLimit: null,
    deepSeekRuntimeHostIds: parseHostIdList(
      rawEnv.DEEPSEEK_RUNTIME_HOST_IDS
      ?? DEFAULT_DEEPSEEK_RUNTIME_HOST_IDS.join(","),
    ),
    openRouterCodexProviderBaseUrl:
      rawEnv.OPENROUTER_CODEX_PROVIDER_BASE_URL?.trim()
      || DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL,
    openRouterCodexProviderEnvKey:
      rawEnv.OPENROUTER_CODEX_PROVIDER_ENV_KEY?.trim()
      || DEFAULT_OPENROUTER_CODEX_PROVIDER_ENV_KEY,
    openRouterCodexProviderId:
      rawEnv.OPENROUTER_CODEX_PROVIDER_ID?.trim()
      || DEFAULT_OPENROUTER_CODEX_PROVIDER_ID,
    openRouterReasoningEffort:
      rawEnv.OPENROUTER_REASONING_EFFORT?.trim()
      || DEFAULT_OPENROUTER_REASONING_EFFORT,
    openRouterContextWindow: parsePositiveInteger(
      rawEnv.OPENROUTER_CONTEXT_WINDOW,
      "OPENROUTER_CONTEXT_WINDOW",
      null,
    ),
    openRouterAutoCompactTokenLimit: null,
    openRouterRuntimeHostIds: parseHostIdList(
      rawEnv.OPENROUTER_RUNTIME_HOST_IDS
      ?? DEFAULT_OPENROUTER_RUNTIME_HOST_IDS.join(","),
    ),
    telegramApiBaseUrl,
    telegramPollTimeoutSecs: parsePositiveInteger(
      rawEnv.TELEGRAM_POLL_TIMEOUT_SECS,
      "TELEGRAM_POLL_TIMEOUT_SECS",
      DEFAULT_TELEGRAM_POLL_TIMEOUT_SECS,
    ),
    maxParallelSessions: parsePositiveInteger(
      rawEnv.MAX_PARALLEL_SESSIONS,
      "MAX_PARALLEL_SESSIONS",
      DEFAULT_MAX_PARALLEL_SESSIONS,
    ),
    parkedSessionRetentionHours: parsePositiveInteger(
      rawEnv.PARKED_SESSION_RETENTION_HOURS,
      "PARKED_SESSION_RETENTION_HOURS",
      DEFAULT_PARKED_SESSION_RETENTION_HOURS,
    ),
    retentionSweepIntervalSecs: parsePositiveInteger(
      rawEnv.RETENTION_SWEEP_INTERVAL_SECS,
      "RETENTION_SWEEP_INTERVAL_SECS",
      DEFAULT_RETENTION_SWEEP_INTERVAL_SECS,
    ),
    telegramBotToken,
    telegramAllowedUserId: telegramAllowedUserIds[0],
    telegramAllowedUserIds,
    telegramAllowedBotIds,
    telegramForumChatId,
    telegramExpectedTopics: parseTopicList(rawEnv.TELEGRAM_EXPECTED_TOPICS),
  };
}

export async function loadRuntimeConfig(options = {}) {
  const platform = options.platform || process.platform;
  const repoRoot = options.repoRoot || process.env.REPO_ROOT || getDefaultRepoRoot();
  const stateRoot =
    options.stateRoot
    || process.env.TELEDEX_STATE_ROOT
    || process.env.STATE_ROOT
    || getDefaultStateRoot({ platform });
  const envFilePath = await resolveRuntimeEnvFilePath({
    allowRepoEnvFallback: options.allowRepoEnvFallback,
    explicitEnvFilePath: options.envFilePath || process.env.ENV_FILE || null,
    platform,
    repoRoot,
    stateRoot,
  });
  const fileEnv = await loadEnvFile(envFilePath, { platform });
  const mergedEnv = {
    ...fileEnv,
    ...process.env,
    ENV_FILE: envFilePath,
    REPO_ROOT: process.env.REPO_ROOT || fileEnv.REPO_ROOT || repoRoot,
    TELEDEX_STATE_ROOT:
      process.env.TELEDEX_STATE_ROOT
      || process.env.STATE_ROOT
      || fileEnv.TELEDEX_STATE_ROOT
      || fileEnv.STATE_ROOT
      || stateRoot,
    STATE_ROOT:
      process.env.STATE_ROOT
      || process.env.TELEDEX_STATE_ROOT
      || fileEnv.STATE_ROOT
      || fileEnv.TELEDEX_STATE_ROOT
      || stateRoot,
  };
  const codexConfigPath =
    mergedEnv.CODEX_CONFIG_PATH?.trim() || DEFAULT_CODEX_CONFIG_PATH;
  const codexProfile = await loadCodexConfigProfile(codexConfigPath);

  return buildRuntimeConfig(mergedEnv, codexProfile, { platform });
}

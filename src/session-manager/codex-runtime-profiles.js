import fs from "node:fs/promises";
import path from "node:path";

import { normalizeReasoningEffort } from "./codex-runtime-settings.js";
import { DEEPSEEK_HTTP_BACKEND } from "../deepseek-runtime/deepseek-http-runner.js";

const CODEX_PROFILE_BACKEND = "codex";
export const SESSION_PROVIDER_CODEX = "codex";
export const SESSION_PROVIDER_DEEPSEEK = "deepseek";
export const SESSION_PROVIDER_OPENROUTER = "openrouter";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_V4_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_DEEPSEEK_CODEX_PROVIDER_ID = "deepseek";
export const DEFAULT_DEEPSEEK_CODEX_PROVIDER_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_DEEPSEEK_CODEX_PROVIDER_ENV_KEY = "DEEPSEEK_API_KEY";
const DEFAULT_DEEPSEEK_CODEX_REQUEST_MAX_RETRIES = 6;
const DEFAULT_DEEPSEEK_CODEX_STREAM_MAX_RETRIES = 8;
const DEFAULT_DEEPSEEK_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_DEEPSEEK_REASONING_EFFORT = "xhigh";
export const DEFAULT_OPENROUTER_MODEL = "moonshotai/kimi-k2.6";
const DEFAULT_OPENROUTER_CODEX_PROVIDER_ID = "openrouter";
const CUSTOM_OPENROUTER_CODEX_PROVIDER_ID = "openrouter_custom";
export const DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_CODEX_PROVIDER_ENV_KEY = "OPENROUTER_API_KEY";
const DEFAULT_OPENROUTER_CODEX_REQUEST_MAX_RETRIES = 8;
const DEFAULT_OPENROUTER_CODEX_STREAM_MAX_RETRIES = 10;
const DEFAULT_OPENROUTER_CODEX_STREAM_IDLE_TIMEOUT_MS = 900_000;
export const DEFAULT_OPENROUTER_REASONING_EFFORT = "high";
export const DEEPSEEK_REASONING_EFFORTS = [
  {
    value: "high",
    label: "High",
    description: "Maps to DeepSeek high thinking effort.",
  },
  {
    value: "xhigh",
    label: "Max",
    description: "Default; maps to DeepSeek max thinking effort.",
  },
];
export const OPENROUTER_REASONING_EFFORTS = [
  {
    value: "minimal",
    label: "Minimal",
    description: "Lowest OpenRouter reasoning effort.",
  },
  {
    value: "low",
    label: "Low",
    description: "Low OpenRouter reasoning effort.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Medium OpenRouter reasoning effort.",
  },
  {
    value: "high",
    label: "Max",
    description: "Default; highest OpenRouter reasoning effort.",
  },
];
export const DEEPSEEK_MODELS = [
  {
    slug: "deepseek-v4-flash",
    displayName: "DeepSeek-V4-Flash",
    aliases: ["flash", "v4-flash", "deepseek-flash", "ds-flash"],
  },
  {
    slug: "deepseek-v4-pro",
    displayName: "DeepSeek-V4-Pro",
    aliases: ["pro", "v4-pro", "deepseek-pro", "ds-pro"],
  },
];
export const OPENROUTER_MODELS = [
  {
    slug: "moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6",
    buttonLabel: "OR Kimi",
    aliases: ["kimi", "kimi-k2.6", "k2.6", "moonshot-kimi"],
    contextWindow: 262_144,
  },
  {
    slug: "minimax/minimax-m2.7",
    displayName: "MiniMax M2.7",
    buttonLabel: "OR MiniMax",
    aliases: ["minimax", "m2.7", "minimax-m2.7"],
    contextWindow: 196_608,
  },
  {
    slug: "z-ai/glm-5.1",
    displayName: "GLM 5.1",
    buttonLabel: "OR GLM",
    aliases: ["glm", "glm-5.1", "glm5.1", "zai-glm"],
    contextWindow: 202_752,
  },
  {
    slug: "qwen/qwen3.6-plus",
    displayName: "Qwen 3.6 Plus",
    buttonLabel: "OR Qwen",
    aliases: ["qwen", "qwen3.6", "qwen-plus", "qwen3.6-plus"],
    contextWindow: 1_000_000,
  },
];

const SAFE_PROVIDER_CONFIG_KEYS = new Set([
  "name",
  "base_url",
  "env_key",
  "env_key_instructions",
  "wire_api",
  "requires_openai_auth",
  "supports_websockets",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
  "websocket_connect_timeout_ms",
]);

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeProfileId(value) {
  const normalized = normalizeText(value);
  return /^[A-Za-z0-9._-]+$/u.test(normalized || "") ? normalized : null;
}

function normalizeProviderId(value) {
  const normalized = normalizeText(value);
  return /^[A-Za-z0-9_-]+$/u.test(normalized || "") ? normalized : null;
}

function normalizeHostId(value) {
  return normalizeText(value)?.toLowerCase() ?? null;
}

function normalizeBackend(value) {
  const normalized = normalizeText(value)?.toLowerCase() ?? CODEX_PROFILE_BACKEND;
  if (normalized === CODEX_PROFILE_BACKEND || normalized === DEEPSEEK_HTTP_BACKEND) {
    return normalized;
  }
  return null;
}

export function normalizeSessionRuntimeProvider(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["codex", "openai", "gpt"].includes(normalized)) {
    return SESSION_PROVIDER_CODEX;
  }
  if (["deepseek", "ds"].includes(normalized)) {
    return SESSION_PROVIDER_DEEPSEEK;
  }
  if (["openrouter", "or", "router"].includes(normalized)) {
    return SESSION_PROVIDER_OPENROUTER;
  }
  return null;
}

export function normalizeDeepSeekModel(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return DEFAULT_DEEPSEEK_MODEL;
  }
  for (const model of DEEPSEEK_MODELS) {
    if (
      normalized === model.slug
      || normalized === String(model.displayName).toLowerCase()
      || model.aliases.includes(normalized)
    ) {
      return model.slug;
    }
  }
  return null;
}

export function normalizeDeepSeekReasoningEffort(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "high") {
    return "high";
  }
  if (["xhigh", "max", "maximum"].includes(normalized)) {
    return "xhigh";
  }
  return null;
}

function isSafeOpenRouterModelId(value) {
  return /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._:-]*)+$/u.test(value)
    && value.length <= 160;
}

export function normalizeOpenRouterModel(value, { allowCustom = true } = {}) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return DEFAULT_OPENROUTER_MODEL;
  }
  for (const model of OPENROUTER_MODELS) {
    if (
      normalized === model.slug
      || normalized === String(model.displayName).toLowerCase()
      || model.aliases.includes(normalized)
    ) {
      return model.slug;
    }
  }
  if (allowCustom && isSafeOpenRouterModelId(normalized)) {
    return normalized;
  }
  return null;
}

export function normalizeOpenRouterReasoningEffort(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["minimal", "low", "medium", "high"].includes(normalized)) {
    return normalized;
  }
  if (["max", "maximum", "xhigh"].includes(normalized)) {
    return "high";
  }
  return null;
}

export function formatDeepSeekReasoningEffort(value) {
  const normalized = normalizeDeepSeekReasoningEffort(value);
  if (!normalized) {
    return null;
  }
  const entry = DEEPSEEK_REASONING_EFFORTS.find((level) => level.value === normalized);
  return entry ? `${entry.label} (${entry.value})` : normalized;
}

export function formatOpenRouterReasoningEffort(value) {
  const normalized = normalizeOpenRouterReasoningEffort(value);
  if (!normalized) {
    return null;
  }
  const entry = OPENROUTER_REASONING_EFFORTS.find((level) => level.value === normalized);
  return entry ? `${entry.label} (${entry.value})` : normalized;
}

export function resolveDeepSeekModelContextWindow(value) {
  return normalizeDeepSeekModel(value) ? DEEPSEEK_V4_CONTEXT_WINDOW : null;
}

export function resolveOpenRouterModelContextWindow(value) {
  const normalizedModel = normalizeOpenRouterModel(value);
  const entry = OPENROUTER_MODELS.find((model) => model.slug === normalizedModel);
  return entry?.contextWindow ?? null;
}

function buildDeepSeekRuntimeProfile({
  contextWindow,
  providerBaseUrl,
  providerEnvKey,
  providerId,
  reasoningEffort,
  model,
} = {}) {
  const normalizedModel = normalizeDeepSeekModel(model);
  const normalizedReasoningEffort = normalizeDeepSeekReasoningEffort(reasoningEffort)
    || DEFAULT_DEEPSEEK_REASONING_EFFORT;
  const modelProvider = normalizeProviderId(providerId)
    || DEFAULT_DEEPSEEK_CODEX_PROVIDER_ID;
  const baseUrl = normalizeText(providerBaseUrl)
    || DEFAULT_DEEPSEEK_CODEX_PROVIDER_BASE_URL;
  const envKey = normalizeText(providerEnvKey)
    || DEFAULT_DEEPSEEK_CODEX_PROVIDER_ENV_KEY;
  if (!normalizedModel) {
    return null;
  }

  return {
    id: `deepseek:${normalizedModel}`,
    backend: CODEX_PROFILE_BACKEND,
    label: `DeepSeek Codex provider ${normalizedModel}`,
    hostId: null,
    model: normalizedModel,
    reasoningEffort: normalizedReasoningEffort,
    contextWindow:
      Number.isInteger(contextWindow) && contextWindow > 0
        ? contextWindow
        : resolveDeepSeekModelContextWindow(normalizedModel),
    autoCompactTokenLimit: null,
    configOverrides: {
      "features.tool_search_always_defer_mcp_tools": true,
    },
    modelProvider,
    modelProviderConfig: {
      name: "DeepSeek",
      base_url: baseUrl,
      env_key: envKey,
      wire_api: "deepseek_chat",
      requires_openai_auth: false,
      request_max_retries: DEFAULT_DEEPSEEK_CODEX_REQUEST_MAX_RETRIES,
      stream_max_retries: DEFAULT_DEEPSEEK_CODEX_STREAM_MAX_RETRIES,
      stream_idle_timeout_ms: DEFAULT_DEEPSEEK_CODEX_STREAM_IDLE_TIMEOUT_MS,
    },
  };
}

function buildOpenRouterRuntimeProfile({
  contextWindow,
  providerBaseUrl,
  providerEnvKey,
  providerId,
  reasoningEffort,
  model,
} = {}) {
  const normalizedModel = normalizeOpenRouterModel(model);
  const normalizedReasoningEffort = normalizeOpenRouterReasoningEffort(reasoningEffort)
    || DEFAULT_OPENROUTER_REASONING_EFFORT;
  const baseUrl = normalizeText(providerBaseUrl)
    || DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL;
  const envKey = normalizeText(providerEnvKey)
    || DEFAULT_OPENROUTER_CODEX_PROVIDER_ENV_KEY;
  if (!normalizedModel) {
    return null;
  }
  const requestedProviderId = normalizeText(providerId);
  const customTransport =
    baseUrl !== DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL
    || envKey !== DEFAULT_OPENROUTER_CODEX_PROVIDER_ENV_KEY;
  const modelProvider = requestedProviderId
    ? normalizeProviderId(requestedProviderId)
    : customTransport
      ? CUSTOM_OPENROUTER_CODEX_PROVIDER_ID
      : DEFAULT_OPENROUTER_CODEX_PROVIDER_ID;
  if (!modelProvider) {
    return null;
  }
  const usesBuiltInProvider =
    modelProvider === DEFAULT_OPENROUTER_CODEX_PROVIDER_ID
    && !customTransport;

  return {
    id: `openrouter:${normalizedModel}`,
    backend: CODEX_PROFILE_BACKEND,
    label: `OpenRouter Codex provider ${normalizedModel}`,
    hostId: null,
    model: normalizedModel,
    reasoningEffort: normalizedReasoningEffort,
    contextWindow:
      Number.isInteger(contextWindow) && contextWindow > 0
        ? contextWindow
        : resolveOpenRouterModelContextWindow(normalizedModel),
    autoCompactTokenLimit: null,
    configOverrides: {
      "features.tool_search_always_defer_mcp_tools": true,
    },
    modelProvider,
    modelProviderConfig: usesBuiltInProvider
      ? null
      : {
        name: "OpenRouter",
        base_url: baseUrl,
        env_key: envKey,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
        request_max_retries: DEFAULT_OPENROUTER_CODEX_REQUEST_MAX_RETRIES,
        stream_max_retries: DEFAULT_OPENROUTER_CODEX_STREAM_MAX_RETRIES,
        stream_idle_timeout_ms: DEFAULT_OPENROUTER_CODEX_STREAM_IDLE_TIMEOUT_MS,
      },
  };
}

function getRuntimeProfilesPath(config = {}) {
  return path.join(config.stateRoot, "settings", "runtime-profiles.json");
}

function normalizeProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!SAFE_PROVIDER_CONFIG_KEYS.has(key)) {
      continue;
    }
    if (
      typeof entryValue === "string"
      || typeof entryValue === "boolean"
      || Number.isInteger(entryValue)
    ) {
      normalized[key] = entryValue;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeRuntimeProfile(raw) {
  const id = normalizeProfileId(raw?.id);
  const model = normalizeText(raw?.model)?.toLowerCase() ?? null;
  const backend = normalizeBackend(raw?.backend);
  if (!id || !model || !backend) {
    return null;
  }

  if (backend === DEEPSEEK_HTTP_BACKEND) {
    const apiUrl = normalizeText(raw?.api_url ?? raw?.apiUrl);
    if (!apiUrl) {
      return null;
    }
    return {
      id,
      backend,
      label: normalizeText(raw?.label) || id,
      hostId: normalizeHostId(raw?.host_id ?? raw?.hostId),
      model,
      reasoningEffort: null,
      deepSeekApiUrl: apiUrl,
      deepSeekMode: normalizeText(raw?.mode) || "agent",
      deepSeekAllowShell: raw?.allow_shell ?? raw?.allowShell ?? true,
      deepSeekTrustMode: raw?.trust_mode ?? raw?.trustMode ?? false,
      deepSeekAutoApprove: raw?.auto_approve ?? raw?.autoApprove ?? true,
    };
  }

  const modelProvider = normalizeProviderId(
    raw?.model_provider ?? raw?.modelProvider,
  );
  const modelProviderConfig = normalizeProviderConfig(
    raw?.model_provider_config ?? raw?.modelProviderConfig,
  );
  if (!modelProvider || !modelProviderConfig) {
    return null;
  }

  return {
    id,
    backend,
    label: normalizeText(raw?.label) || id,
    hostId: normalizeHostId(raw?.host_id ?? raw?.hostId),
    model,
    reasoningEffort: normalizeReasoningEffort(
      raw?.reasoning_effort ?? raw?.reasoningEffort,
    ),
    modelProvider,
    modelProviderConfig,
  };
}

async function loadCodexRuntimeProfiles({ config, profilesPath = null } = {}) {
  const filePath = normalizeText(profilesPath) || getRuntimeProfilesPath(config);
  try {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
    const rawProfiles = Array.isArray(payload?.profiles)
      ? payload.profiles
      : Object.entries(payload?.profiles || {}).map(([id, profile]) => ({
          id,
          ...profile,
        }));
    return rawProfiles
      .map((profile) => normalizeRuntimeProfile(profile))
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new Error(`Failed to load Codex runtime profiles: ${error.message}`, {
      cause: error,
    });
  }
}

export async function resolveSessionCodexRuntimeProfile({
  session,
  config,
  profilesPath = null,
} = {}) {
  const sessionProvider = normalizeSessionRuntimeProvider(
    session?.session_runtime_provider,
  );
  if (sessionProvider === SESSION_PROVIDER_DEEPSEEK) {
    const profile = buildDeepSeekRuntimeProfile({
      contextWindow: config?.deepSeekContextWindow,
      providerBaseUrl: config?.deepSeekCodexProviderBaseUrl,
      providerEnvKey: config?.deepSeekCodexProviderEnvKey,
      providerId: config?.deepSeekCodexProviderId,
      model: session?.session_runtime_model,
      reasoningEffort:
        session?.agent_reasoning_effort_override
        ?? config?.deepSeekReasoningEffort,
    });
    if (!profile) {
      throw new Error("DeepSeek runtime is selected but provider config/model is invalid");
    }
    return profile;
  }
  if (sessionProvider === SESSION_PROVIDER_OPENROUTER) {
    const profile = buildOpenRouterRuntimeProfile({
      contextWindow: config?.openRouterContextWindow,
      providerBaseUrl: config?.openRouterCodexProviderBaseUrl,
      providerEnvKey: config?.openRouterCodexProviderEnvKey,
      providerId: config?.openRouterCodexProviderId,
      model: session?.session_runtime_model,
      reasoningEffort:
        session?.agent_reasoning_effort_override
        ?? config?.openRouterReasoningEffort,
    });
    if (!profile) {
      throw new Error("OpenRouter runtime is selected but provider config/model is invalid");
    }
    return profile;
  }

  const requestedId = normalizeProfileId(session?.codex_runtime_profile_id);
  if (!requestedId) {
    return null;
  }

  const profiles = await loadCodexRuntimeProfiles({ config, profilesPath });
  const profile = profiles.find((entry) => entry.id === requestedId);
  if (!profile) {
    throw new Error(`Unknown Codex runtime profile: ${requestedId}`);
  }
  if (sessionProvider === SESSION_PROVIDER_CODEX && profile.backend === DEEPSEEK_HTTP_BACKEND) {
    throw new Error(
      `Codex runtime provider cannot use DeepSeek runtime profile: ${requestedId}`,
    );
  }

  const sessionHostId = normalizeHostId(session?.execution_host_id);
  if (profile.hostId && sessionHostId && profile.hostId !== sessionHostId) {
    throw new Error(
      `Codex runtime profile ${profile.id} is bound to host ${profile.hostId}, not ${sessionHostId}`,
    );
  }

  return profile;
}

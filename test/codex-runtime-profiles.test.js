import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_DEEPSEEK_CODEX_PROVIDER_BASE_URL,
  DEFAULT_DEEPSEEK_CODEX_PROVIDER_ENV_KEY,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_REASONING_EFFORT,
  normalizeDeepSeekModel,
  normalizeDeepSeekReasoningEffort,
  normalizeOpenRouterModel,
  normalizeOpenRouterReasoningEffort,
  normalizeSessionRuntimeProvider,
  resolveSessionCodexRuntimeProfile,
  SESSION_PROVIDER_CODEX,
  SESSION_PROVIDER_DEEPSEEK,
  SESSION_PROVIDER_OPENROUTER,
} from "../src/session-manager/codex-runtime-profiles.js";

test("normalizeSessionRuntimeProvider accepts codex and deepseek aliases", () => {
  assert.equal(normalizeSessionRuntimeProvider("codex"), SESSION_PROVIDER_CODEX);
  assert.equal(normalizeSessionRuntimeProvider("openai"), SESSION_PROVIDER_CODEX);
  assert.equal(normalizeSessionRuntimeProvider("deepseek"), SESSION_PROVIDER_DEEPSEEK);
  assert.equal(normalizeSessionRuntimeProvider("ds"), SESSION_PROVIDER_DEEPSEEK);
  assert.equal(normalizeSessionRuntimeProvider("openrouter"), SESSION_PROVIDER_OPENROUTER);
  assert.equal(normalizeSessionRuntimeProvider("or"), SESSION_PROVIDER_OPENROUTER);
  assert.equal(normalizeSessionRuntimeProvider("other"), null);
});

test("normalizeDeepSeekModel accepts flash/pro aliases only", () => {
  assert.equal(normalizeDeepSeekModel(null), DEFAULT_DEEPSEEK_MODEL);
  assert.equal(normalizeDeepSeekModel("flash"), "deepseek-v4-flash");
  assert.equal(normalizeDeepSeekModel("pro"), "deepseek-v4-pro");
  assert.equal(normalizeDeepSeekModel("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(normalizeDeepSeekModel("deepseek-chat"), null);
});

test("normalizeDeepSeekReasoningEffort accepts DeepSeek effort aliases only", () => {
  assert.equal(normalizeDeepSeekReasoningEffort("high"), "high");
  assert.equal(normalizeDeepSeekReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeDeepSeekReasoningEffort("max"), "xhigh");
  assert.equal(normalizeDeepSeekReasoningEffort("medium"), null);
  assert.equal(normalizeDeepSeekReasoningEffort(null), null);
});

test("normalizeOpenRouterModel accepts listed aliases and safe custom ids", () => {
  assert.equal(normalizeOpenRouterModel(null), DEFAULT_OPENROUTER_MODEL);
  assert.equal(normalizeOpenRouterModel("kimi"), "moonshotai/kimi-k2.6");
  assert.equal(normalizeOpenRouterModel("minimax"), "minimax/minimax-m2.7");
  assert.equal(normalizeOpenRouterModel("glm"), "z-ai/glm-5.1");
  assert.equal(normalizeOpenRouterModel("qwen"), "qwen/qwen3.6-plus");
  assert.equal(normalizeOpenRouterModel("qwen3.6-plus"), "qwen/qwen3.6-plus");
  assert.equal(normalizeOpenRouterModel("qwen3.5"), null);
  assert.equal(normalizeOpenRouterModel("openai/gpt-5.5"), "openai/gpt-5.5");
  assert.equal(normalizeOpenRouterModel("OPENAI/GPT-5.5"), "openai/gpt-5.5");
  assert.equal(normalizeOpenRouterModel("vendor/model:free"), "vendor/model:free");
  assert.equal(normalizeOpenRouterModel("vendor/family/model"), "vendor/family/model");
  assert.equal(normalizeOpenRouterModel("gpt-5.5"), null);
  assert.equal(normalizeOpenRouterModel("bad model/id"), null);
  assert.equal(normalizeOpenRouterModel("../vendor/model"), null);
  assert.equal(normalizeOpenRouterModel("https://openrouter.ai/vendor/model"), null);
  assert.equal(normalizeOpenRouterModel("vendor/model\" }"), null);
  assert.equal(normalizeOpenRouterModel("vendor/model\nother/model"), null);
  assert.equal(normalizeOpenRouterModel("vendor/"), null);
  assert.equal(normalizeOpenRouterModel(`${"a".repeat(80)}/${"b".repeat(90)}`), null);
});

test("normalizeOpenRouterReasoningEffort maps max to high", () => {
  assert.equal(normalizeOpenRouterReasoningEffort("minimal"), "minimal");
  assert.equal(normalizeOpenRouterReasoningEffort("low"), "low");
  assert.equal(normalizeOpenRouterReasoningEffort("medium"), "medium");
  assert.equal(normalizeOpenRouterReasoningEffort("high"), "high");
  assert.equal(normalizeOpenRouterReasoningEffort("max"), "high");
  assert.equal(normalizeOpenRouterReasoningEffort("xhigh"), "high");
  assert.equal(normalizeOpenRouterReasoningEffort("none"), null);
});

test("resolveSessionCodexRuntimeProfile builds inline DeepSeek Codex provider profile from session provider", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      deepSeekCodexProviderBaseUrl: "https://api.deepseek.com/v1",
      deepSeekCodexProviderEnvKey: "DEEPSEEK_API_KEY",
      deepSeekReasoningEffort: "xhigh",
    },
    session: {
      session_runtime_provider: "deepseek",
      session_runtime_model: "pro",
    },
  });

  assert.equal(profile.backend, "codex");
  assert.equal(profile.id, "deepseek:deepseek-v4-pro");
  assert.equal(profile.model, "deepseek-v4-pro");
  assert.equal(profile.reasoningEffort, "xhigh");
  assert.equal(profile.contextWindow, 1_000_000);
  assert.equal(profile.autoCompactTokenLimit, null);
  assert.deepEqual(profile.configOverrides, {
    "features.tool_search_always_defer_mcp_tools": true,
  });
  assert.equal(profile.modelProvider, "deepseek");
  assert.deepEqual(profile.modelProviderConfig, {
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    env_key: "DEEPSEEK_API_KEY",
    wire_api: "deepseek_chat",
    requires_openai_auth: false,
    request_max_retries: 6,
    stream_max_retries: 8,
    stream_idle_timeout_ms: 300000,
  });
});

test("DeepSeek provider profile has safe defaults and model metadata helpers", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {},
    session: {
      session_runtime_provider: "deepseek",
      session_runtime_model: "flash",
    },
  });

  assert.equal(profile.backend, "codex");
  assert.equal(
    profile.modelProviderConfig.base_url,
    DEFAULT_DEEPSEEK_CODEX_PROVIDER_BASE_URL,
  );
  assert.equal(
    profile.modelProviderConfig.env_key,
    DEFAULT_DEEPSEEK_CODEX_PROVIDER_ENV_KEY,
  );
  assert.equal(profile.reasoningEffort, DEFAULT_DEEPSEEK_REASONING_EFFORT);
  assert.equal(profile.contextWindow, 1_000_000);
  assert.equal(profile.autoCompactTokenLimit, null);
  assert.equal(profile.modelProviderConfig.request_max_retries, 6);
  assert.equal(profile.modelProviderConfig.stream_max_retries, 8);
  assert.equal(profile.modelProviderConfig.stream_idle_timeout_ms, 300000);
  assert.deepEqual(profile.configOverrides, {
    "features.tool_search_always_defer_mcp_tools": true,
  });
});

test("resolveSessionCodexRuntimeProfile lets DeepSeek config override context window only", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      deepSeekAutoCompactTokenLimit: 750_000,
      deepSeekContextWindow: 1_000_000,
    },
    session: {
      session_runtime_provider: "deepseek",
      session_runtime_model: "flash",
    },
  });

  assert.equal(profile.contextWindow, 1_000_000);
  assert.equal(profile.autoCompactTokenLimit, null);
});

test("resolveSessionCodexRuntimeProfile lets DeepSeek topic reasoning override config", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      deepSeekReasoningEffort: "high",
    },
    session: {
      session_runtime_provider: "deepseek",
      session_runtime_model: "flash",
      agent_reasoning_effort_override: "max",
    },
  });

  assert.equal(profile.reasoningEffort, "xhigh");
});

test("resolveSessionCodexRuntimeProfile keeps explicit codex sessions on Codex defaults", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      deepSeekRuntimeApiUrl: "http://127.0.0.1:7891",
    },
    session: {
      session_runtime_provider: "codex",
      session_runtime_model: "deepseek-v4-pro",
    },
  });

  assert.equal(profile, null);
});

test("resolveSessionCodexRuntimeProfile builds built-in OpenRouter Codex provider profile", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      openRouterCodexProviderBaseUrl: "https://openrouter.ai/api/v1",
      openRouterCodexProviderEnvKey: "OPENROUTER_API_KEY",
      openRouterReasoningEffort: "high",
    },
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "qwen",
    },
  });

  assert.equal(profile.backend, "codex");
  assert.equal(profile.id, "openrouter:qwen/qwen3.6-plus");
  assert.equal(profile.model, "qwen/qwen3.6-plus");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.contextWindow, 1_000_000);
  assert.equal(profile.autoCompactTokenLimit, null);
  assert.deepEqual(profile.configOverrides, {
    "features.tool_search_always_defer_mcp_tools": true,
  });
  assert.equal(profile.modelProvider, "openrouter");
  assert.equal(profile.modelProviderConfig, null);
});

test("OpenRouter provider profile has safe defaults and custom model fallback", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {},
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "some-vendor/some-model:free",
    },
  });

  assert.equal(profile.backend, "codex");
  assert.equal(profile.modelProviderConfig, null);
  assert.equal(profile.model, "some-vendor/some-model:free");
  assert.equal(profile.reasoningEffort, DEFAULT_OPENROUTER_REASONING_EFFORT);
  assert.equal(profile.contextWindow, null);
  assert.equal(profile.autoCompactTokenLimit, null);
});

test("resolveSessionCodexRuntimeProfile can build custom OpenRouter provider config", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      openRouterCodexProviderId: "openrouter_custom",
      openRouterCodexProviderBaseUrl: "https://openrouter.ai/api/v1",
      openRouterCodexProviderEnvKey: "CUSTOM_OPENROUTER_API_KEY",
    },
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "kimi",
    },
  });

  assert.equal(profile.modelProvider, "openrouter_custom");
  assert.deepEqual(profile.modelProviderConfig, {
    name: "OpenRouter",
    base_url: DEFAULT_OPENROUTER_CODEX_PROVIDER_BASE_URL,
    env_key: "CUSTOM_OPENROUTER_API_KEY",
    wire_api: "responses",
    requires_openai_auth: false,
    supports_websockets: false,
    request_max_retries: 8,
    stream_max_retries: 10,
    stream_idle_timeout_ms: 900000,
  });
});

test("OpenRouter custom transport uses a non-reserved provider id by default", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      openRouterCodexProviderEnvKey: "CUSTOM_OPENROUTER_API_KEY",
    },
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "kimi",
    },
  });

  assert.equal(profile.modelProvider, "openrouter_custom");
  assert.equal(profile.modelProviderConfig.env_key, "CUSTOM_OPENROUTER_API_KEY");
});

test("OpenRouter custom provider ids allow hyphens without falling back to the reserved id", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      openRouterCodexProviderId: "openrouter-lab",
      openRouterCodexProviderEnvKey: "CUSTOM_OPENROUTER_API_KEY",
    },
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "kimi",
    },
  });

  assert.equal(profile.modelProvider, "openrouter-lab");
  assert.equal(profile.modelProviderConfig.env_key, "CUSTOM_OPENROUTER_API_KEY");
});

test("OpenRouter invalid custom provider id fails closed", async () => {
  await assert.rejects(
    resolveSessionCodexRuntimeProfile({
      config: {
        openRouterCodexProviderId: "openrouter.bad/id",
        openRouterCodexProviderEnvKey: "CUSTOM_OPENROUTER_API_KEY",
      },
      session: {
        session_runtime_provider: "openrouter",
        session_runtime_model: "kimi",
      },
    }),
    /OpenRouter runtime is selected but provider config\/model is invalid/u,
  );
});

test("OpenRouter custom provider config has safe transport defaults", async () => {
  const profile = await resolveSessionCodexRuntimeProfile({
    config: {
      openRouterCodexProviderId: "openrouter_lab",
    },
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "some-vendor/some-model:free",
    },
  });

  assert.equal(profile.modelProviderConfig.supports_websockets, false);
  assert.equal(profile.modelProviderConfig.request_max_retries, 8);
  assert.equal(profile.modelProviderConfig.stream_max_retries, 10);
  assert.equal(profile.modelProviderConfig.stream_idle_timeout_ms, 900000);
});

test("resolveSessionCodexRuntimeProfile preserves legacy profile sessions without provider", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-profiles-"));
  const profilesPath = path.join(tmp, "runtime-profiles.json");
  await fs.writeFile(
    profilesPath,
    JSON.stringify({
      profiles: [{
        id: "deepseek-native",
        backend: "deepseek-http",
        model: "deepseek-v4-flash",
        api_url: "http://127.0.0.1:7891",
      }],
    }),
  );

  const profile = await resolveSessionCodexRuntimeProfile({
    config: { stateRoot: tmp },
    profilesPath,
    session: {
      codex_runtime_profile_id: "deepseek-native",
      session_runtime_provider: null,
    },
  });

  assert.equal(profile.backend, "deepseek-http");
  assert.equal(profile.model, "deepseek-v4-flash");
});

test("resolveSessionCodexRuntimeProfile lets explicit codex sessions use codex profiles only", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-profiles-"));
  const profilesPath = path.join(tmp, "runtime-profiles.json");
  await fs.writeFile(
    profilesPath,
    JSON.stringify({
      profiles: [
        {
          id: "codex-alt",
          backend: "codex",
          model: "gpt-5.4-mini",
          model_provider: "openai",
          model_provider_config: {
            name: "openai",
            base_url: "https://api.openai.com/v1",
            wire_api: "responses",
            requires_openai_auth: true,
          },
        },
        {
          id: "deepseek-native",
          backend: "deepseek-http",
          model: "deepseek-v4-flash",
          api_url: "http://127.0.0.1:7891",
        },
      ],
    }),
  );

  const codexProfile = await resolveSessionCodexRuntimeProfile({
    config: { stateRoot: tmp },
    profilesPath,
    session: {
      codex_runtime_profile_id: "codex-alt",
      session_runtime_provider: "codex",
    },
  });
  assert.equal(codexProfile.backend, "codex");
  assert.equal(codexProfile.model, "gpt-5.4-mini");

  await assert.rejects(
    resolveSessionCodexRuntimeProfile({
      config: { stateRoot: tmp },
      profilesPath,
      session: {
        codex_runtime_profile_id: "deepseek-native",
        session_runtime_provider: "codex",
      },
    }),
    /Codex runtime provider cannot use DeepSeek runtime profile/u,
  );
});

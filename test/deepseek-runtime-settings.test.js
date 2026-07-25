import test from "node:test";
import assert from "node:assert/strict";

import { handleScopedRuntimeSettingCommand } from "../src/telegram/command-handlers/runtime-settings/handler.js";

test("handleScopedRuntimeSettingCommand changes model inside DeepSeek topics only", async () => {
  const session = {
    session_runtime_provider: "deepseek",
    session_runtime_model: "deepseek-v4-flash",
  };
  const calls = [];
  const result = await handleScopedRuntimeSettingCommand({
    commandName: "model",
    parsedCommand: {
      scope: "topic",
      action: "set",
      value: "pro",
    },
    session,
    sessionService: {
      async updateSessionDeepSeekModel(targetSession, value) {
        calls.push({ targetSession, value });
        return {
          ...targetSession,
          session_runtime_model: value,
        };
      },
    },
    config: {},
    language: "eng",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "deepseek-v4-pro");
  assert.equal(result.handledSession.session_runtime_model, "deepseek-v4-pro");
  assert.match(result.responseText, /DeepSeek model updated/u);
});

test("handleScopedRuntimeSettingCommand changes reasoning inside DeepSeek topics", async () => {
  const calls = [];
  const result = await handleScopedRuntimeSettingCommand({
    commandName: "reasoning",
    parsedCommand: {
      scope: "topic",
      action: "set",
      value: "max",
    },
    session: {
      session_runtime_provider: "deepseek",
      session_runtime_model: "deepseek-v4-flash",
    },
    sessionService: {
      async updateSessionCodexSetting(targetSession, target, kind, value) {
        calls.push({ targetSession, target, kind, value });
        return {
          ...targetSession,
          agent_reasoning_effort_override: value,
        };
      },
    },
    config: {},
    language: "eng",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "agent");
  assert.equal(calls[0].kind, "reasoning");
  assert.equal(calls[0].value, "xhigh");
  assert.equal(result.handledSession.agent_reasoning_effort_override, "xhigh");
  assert.match(result.responseText, /DeepSeek reasoning updated/u);
});

test("handleScopedRuntimeSettingCommand changes model inside OpenRouter topics", async () => {
  const session = {
    session_runtime_provider: "openrouter",
    session_runtime_model: "moonshotai/kimi-k2.6",
  };
  const calls = [];
  const result = await handleScopedRuntimeSettingCommand({
    commandName: "model",
    parsedCommand: {
      scope: "topic",
      action: "set",
      value: "openai/gpt-5.5",
    },
    session,
    sessionService: {
      async updateSessionOpenRouterModel(targetSession, value) {
        calls.push({ targetSession, value });
        return {
          ...targetSession,
          session_runtime_model: value,
        };
      },
    },
    config: {},
    language: "eng",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "openai/gpt-5.5");
  assert.equal(result.handledSession.session_runtime_model, "openai/gpt-5.5");
  assert.match(result.responseText, /OpenRouter model updated/u);
});

test("handleScopedRuntimeSettingCommand changes reasoning inside OpenRouter topics", async () => {
  const calls = [];
  const result = await handleScopedRuntimeSettingCommand({
    commandName: "reasoning",
    parsedCommand: {
      scope: "topic",
      action: "set",
      value: "max",
    },
    session: {
      session_runtime_provider: "openrouter",
      session_runtime_model: "moonshotai/kimi-k2.6",
    },
    sessionService: {
      async updateSessionCodexSetting(targetSession, target, kind, value) {
        calls.push({ targetSession, target, kind, value });
        return {
          ...targetSession,
          agent_reasoning_effort_override: value,
        };
      },
    },
    config: {},
    language: "eng",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, "agent");
  assert.equal(calls[0].kind, "reasoning");
  assert.equal(calls[0].value, "high");
  assert.equal(result.handledSession.agent_reasoning_effort_override, "high");
  assert.match(result.responseText, /OpenRouter reasoning updated/u);
  assert.match(result.responseText, /Max \(high\)/u);
});

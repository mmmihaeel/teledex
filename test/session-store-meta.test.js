import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStoredSessionMeta,
  stripLegacyMetaFields,
} from "../src/session-manager/session-store-meta.js";

test("normalizeStoredSessionMeta keeps OpenRouter custom model ids provider-aware", () => {
  const meta = normalizeStoredSessionMeta({
    session_runtime_provider: "openrouter",
    session_runtime_model: "OpenAI/GPT-5.5",
  });

  assert.equal(meta.session_runtime_provider, "openrouter");
  assert.equal(meta.session_runtime_model, "openai/gpt-5.5");
});

test("normalizeStoredSessionMeta rejects model ids under the wrong runtime provider", () => {
  const meta = normalizeStoredSessionMeta({
    session_runtime_provider: "deepseek",
    session_runtime_model: "openai/gpt-5.5",
  });

  assert.equal(meta.session_runtime_provider, "deepseek");
  assert.equal(meta.session_runtime_model, null);
});

test("normalizeStoredSessionMeta canonicalizes stored language values to English", () => {
  const meta = normalizeStoredSessionMeta({
    ui_language: "unsupported",
  });

  assert.equal(meta.ui_language, "eng");
});

test("stripLegacyMetaFields drops retired runtime provider schema fields", () => {
  const meta = stripLegacyMetaFields({
    session_runtime_provider: "openrouter",
    runtime_provider: "codex",
    progress_notes_consumed_until: "2026-04-24T12:06:00.000Z",
  });

  assert.equal(meta.session_runtime_provider, "openrouter");
  assert.equal(Object.hasOwn(meta, "runtime_provider"), false);
  assert.equal(Object.hasOwn(meta, "progress_notes_consumed_until"), false);
});

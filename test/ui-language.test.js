import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  getSessionUiLanguage,
  isWaitFlushWord,
  normalizeUiLanguage,
  parseUiLanguage,
} from "../src/i18n/ui-language.js";

test("UI language defaults and stored values normalize to English", () => {
  assert.equal(DEFAULT_UI_LANGUAGE, "eng");
  assert.equal(normalizeUiLanguage(), "eng");
  assert.equal(normalizeUiLanguage("unsupported"), "eng");
  assert.equal(getSessionUiLanguage({ ui_language: "legacy" }), "eng");
  assert.equal(formatUiLanguageLabel("legacy"), "ENG");
});

test("UI language command parsing accepts only English aliases", () => {
  assert.equal(parseUiLanguage("en"), "eng");
  assert.equal(parseUiLanguage("ENG"), "eng");
  assert.equal(parseUiLanguage("english"), "eng");
  assert.equal(parseUiLanguage("legacy"), null);
  assert.equal(parseUiLanguage("unsupported"), null);
});

test("wait flush accepts only the English command word", () => {
  assert.equal(isWaitFlushWord("All"), true);
  assert.equal(isWaitFlushWord(" all "), true);
  assert.equal(isWaitFlushWord("everything"), false);
  assert.equal(isWaitFlushWord("flush"), false);
});

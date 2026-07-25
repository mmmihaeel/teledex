import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import {
  isTopicPromptSuffixEnabled,
  normalizePromptSuffixText,
} from "../../../session-manager/prompt-suffix.js";
import { DEFAULT_UI_LANGUAGE } from "./common.js";

export function buildPromptSuffixMessage(
  promptSuffixState,
  heading,
  scope = "topic",
  _language = DEFAULT_UI_LANGUAGE,
) {
  const suffixText = normalizePromptSuffixText(
    promptSuffixState?.prompt_suffix_text,
  );
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    heading,
    "",
    `scope: ${scope}`,
    `status: ${promptSuffixState?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
    `text: ${suffixText ? "set" : "empty"}`,
    "",
    suffixText || `Set it with ${setCommand}.`,
  ].join("\n");
}

export function buildPromptSuffixTooLongMessage(
  maxChars,
  _language = DEFAULT_UI_LANGUAGE,
) {
  return [
    "Prompt suffix is too long.",
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

export function buildPromptSuffixEmptyMessage(
  scope = "topic",
  _language = DEFAULT_UI_LANGUAGE,
) {
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    "Prompt suffix text is empty.",
    "",
    `Set it first with ${setCommand}.`,
  ].join("\n");
}

export function buildPromptSuffixHelpMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Suffix help",
    "",
    "Local suffix in the current topic:",
    "/suffix <text>",
    "/suffix",
    "/suffix on | off | clear",
    "",
    "Global suffix for the whole gateway:",
    "/suffix global <text>",
    "/suffix global",
    "/suffix global on | off | clear",
    "",
    "Topic kill switch:",
    "/suffix topic",
    "/suffix topic off",
    "/suffix topic on",
    "",
    "Priority:",
    "1. /suffix topic off => no suffixes in this topic",
    "2. local suffix on => local overrides global",
    "3. otherwise global suffix if it is enabled",
  ].join("\n");
}

export function buildTopicPromptSuffixStateMessage(
  session,
  heading,
  _language = getSessionUiLanguage(session),
) {
  return [
    heading,
    "",
    "scope: topic-routing",
    `status: ${isTopicPromptSuffixEnabled(session) ? "on" : "off"}`,
    "",
    "When off, this topic ignores both local and global prompt suffixes.",
    "Use /suffix topic on or /suffix topic off.",
  ].join("\n");
}

export function buildTopicPromptSuffixUsageMessage(
  _language = DEFAULT_UI_LANGUAGE,
) {
  return [
    "Topic prompt suffix routing command is invalid.",
    "",
    "Use /suffix topic on, /suffix topic off, or /suffix topic.",
  ].join("\n");
}

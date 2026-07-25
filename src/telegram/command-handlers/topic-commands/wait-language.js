import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import {
  DEFAULT_UI_LANGUAGE,
  formatWaitWindow,
  getLanguageLabel,
  getWaitScopeLabel,
  selectWaitStateByScope,
} from "./common.js";

export function buildWaitUsageMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Collection windows",
    "",
    "Usage:",
    "/wait 60",
    "/wait 1m",
    "/wait global 60",
    "/wait global 1m",
    "/wait",
    "/wait off",
    "/wait global off",
    "",
    "Plain /wait <time> arms a local one-shot window for the next prompt in this topic.",
    "The local window resets automatically after that prompt is sent.",
    "/wait global <time> enables the persistent global window across topics in this chat.",
    "If both exist, the local one-shot window wins in this topic.",
    "Each new message inside the active prompt resets the timer.",
    "Send a separate `All` message to flush immediately.",
  ].join("\n");
}

export function buildWaitStateMessage(
  waitState,
  heading = "Collection windows",
  language = DEFAULT_UI_LANGUAGE,
  scope = "effective",
) {
  const selectedState = selectWaitStateByScope(waitState, scope);
  if (!selectedState?.active) {
    return [
      heading,
      "",
      "status: off",
      "",
      scope === "global"
        ? "Enable it with: /wait global 60 or /wait global 1m"
        : scope === "topic"
          ? "Enable it with: /wait 60 or /wait 1m"
          : "Enable local with /wait 60 or global with /wait global 60",
    ].join("\n");
  }

  const seconds = Number.isInteger(selectedState.flushDelayMs)
    ? Math.round(selectedState.flushDelayMs / 1000)
    : null;
  const lines = [
    heading,
    "",
    "status: on",
    `scope: ${getWaitScopeLabel(selectedState.scope, language)}`,
    `timeout: ${formatWaitWindow(seconds, language)}`,
    `buffered parts: ${selectedState.messageCount ?? 0}`,
  ];

  if (scope === "effective") {
    lines.push(
      "",
      `local one-shot: ${waitState?.local?.active ? "on" : "off"}`,
      `global persistent: ${waitState?.global?.active ? "on" : "off"}`,
    );
  }

  lines.push(
    "",
    selectedState.scope === "global"
      ? "This window stays enabled until /wait global off or a new /wait global <time>."
      : "This window is local to this topic and resets after the next prompt is sent.",
    "Each new message inside the active prompt resets the timer.",
    "Send a separate `All` message to flush immediately.",
    selectedState.scope === "global"
      ? "Disable it: /wait global off"
      : "Disable it: /wait off",
  );

  return lines.join("\n");
}

export function buildWaitDisabledMessage(
  canceled,
  scope = "topic",
  _language = DEFAULT_UI_LANGUAGE,
) {
  return [
    scope === "global" ? "Global wait is off." : "Local wait is off.",
    "",
    `discarded parts: ${canceled?.messageCount ?? 0}`,
  ].join("\n");
}

export function buildWaitUnavailableMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "The collection window is unavailable in this runtime.";
}

export function buildLanguageStateMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  const selected = getLanguageLabel(session?.ui_language ?? language);
  return [
    "Interface language",
    "",
    `current: ${selected}`,
    "",
    "Usage:",
    "/language",
    "/language eng",
  ].join("\n");
}

export function buildLanguageUpdatedMessage(session) {
  const language = getSessionUiLanguage(session);
  return [
    "Interface language updated.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

export function buildLanguageUsageMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Language command is invalid.",
    "",
    "Use /language or /language eng.",
  ].join("\n");
}

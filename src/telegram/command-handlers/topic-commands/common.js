import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  normalizeUiLanguage,
} from "../../../i18n/ui-language.js";

export { DEFAULT_UI_LANGUAGE };

export function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

export function getLanguageLabel(language) {
  return formatUiLanguageLabel(language);
}

export function formatWaitWindow(seconds, _language = DEFAULT_UI_LANGUAGE) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return "unknown";
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  return `${seconds}s`;
}

export function getWaitScopeLabel(scope, _language = DEFAULT_UI_LANGUAGE) {
  if (scope === "global") {
    return "global";
  }

  if (scope === "topic") {
    return "local one-shot";
  }

  return "effective";
}

export function selectWaitStateByScope(waitState, scope = "effective") {
  if (!waitState) {
    return null;
  }

  if (scope === "global") {
    return waitState.global || null;
  }

  if (scope === "topic") {
    return waitState.local || null;
  }

  return waitState;
}

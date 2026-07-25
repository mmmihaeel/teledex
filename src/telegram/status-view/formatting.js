import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import {
  formatReasoningEffort,
} from "../../session-manager/codex-runtime-settings.js";

export function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

export function getLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return formatUiLanguageLabel(language);
}

export function formatNumber(value, _language = DEFAULT_UI_LANGUAGE) {
  return Number.isInteger(value)
    ? String(value)
    : "unknown";
}

export function formatPercent(value, _language = DEFAULT_UI_LANGUAGE) {
  return Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : "unknown";
}

export function formatCodexSettingValue(
  kind,
  value,
  _language = DEFAULT_UI_LANGUAGE,
) {
  if (!value) {
    return "default";
  }

  if (kind === "reasoning") {
    return formatReasoningEffort(value) ?? value;
  }

  return value;
}

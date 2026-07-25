export const DEFAULT_UI_LANGUAGE = "eng";

const UI_LANGUAGE_ALIASES = new Map([
  ["en", "eng"],
  ["eng", "eng"],
  ["english", "eng"],
]);

export function normalizeUiLanguage(_value) {
  return DEFAULT_UI_LANGUAGE;
}

export function parseUiLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UI_LANGUAGE_ALIASES.get(normalized) || null;
}

export function getSessionUiLanguage(session) {
  return normalizeUiLanguage(session?.ui_language);
}

export function formatUiLanguageLabel(_language) {
  return "ENG";
}

export function isWaitFlushWord(text) {
  return /^all$/iu.test(String(text || "").trim());
}

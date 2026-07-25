import { DEFAULT_UI_LANGUAGE } from "../i18n/ui-language.js";

export function buildOnlyMessage({
  command,
  description,
  language: _language = DEFAULT_UI_LANGUAGE,
}) {
  return [
    `Use ${command}.`,
    "",
    description.english,
  ].join("\n");
}

export function buildPendingInputStartedMessage({
  kind,
  language: _language = DEFAULT_UI_LANGUAGE,
  goalText = null,
  newTopicText = null,
  suffixText,
  waitText,
}) {
  if (kind === "suffix_text") {
    return suffixText.english;
  }

  if (kind === "new_topic_title" && newTopicText) {
    return newTopicText.english;
  }

  if (kind === "goal_text" && goalText) {
    return goalText.english;
  }

  return waitText.english;
}

export function buildPendingInputCanceledMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "Pending manual input cleared.";
}

export function buildPendingInputNeedsTextMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "Send the next plain text message.";
}

export function buildInvalidCustomWaitMessage({
  language: _language = DEFAULT_UI_LANGUAGE,
  scopeLabel,
}) {
  return `Invalid custom ${scopeLabel} wait. Send 45s, 2m, 600, or off.`;
}

export function buildWaitUnavailableMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "Manual collection windows are unavailable right now.";
}

export function buildInvalidSuffixMessage({
  language: _language = DEFAULT_UI_LANGUAGE,
  scopeLabel,
}) {
  return `${scopeLabel} suffix text is empty.`;
}

export function buildTooLongSuffixMessage({
  language: _language = DEFAULT_UI_LANGUAGE,
  maxChars,
  scopeLabel,
}) {
  return [
    `${scopeLabel} suffix is too long.`,
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

export function buildLanguageUpdatedMessage({
  currentLabel,
  language: _language = DEFAULT_UI_LANGUAGE,
}) {
  return [
    "Interface language updated.",
    "",
    `current: ${currentLabel}`,
  ].join("\n");
}

export function buildUnavailableModelMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "The selected model is unavailable.";
}

export function buildUnsupportedReasoningMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "The selected reasoning level is unsupported for the current model.";
}

export function buildMenuRefreshMessage({
  language: _language = DEFAULT_UI_LANGUAGE,
  scopeLabel,
}) {
  return `${scopeLabel} control panel is already current.`;
}

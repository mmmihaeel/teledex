import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { PROMPT_SUFFIX_MAX_CHARS } from "../../session-manager/prompt-suffix.js";
import { getLanguageLabel } from "../control-panel-view-common.js";
import {
  buildInvalidCustomWaitMessage as buildSharedInvalidCustomWaitMessage,
  buildInvalidSuffixMessage as buildSharedInvalidSuffixMessage,
  buildLanguageUpdatedMessage as buildSharedLanguageUpdatedMessage,
  buildMenuRefreshMessage as buildSharedMenuRefreshMessage,
  buildOnlyMessage as buildSharedOnlyMessage,
  buildPendingInputCanceledMessage as buildSharedPendingInputCanceledMessage,
  buildPendingInputNeedsTextMessage as buildSharedPendingInputNeedsTextMessage,
  buildPendingInputStartedMessage as buildSharedPendingInputStartedMessage,
  buildTooLongSuffixMessage as buildSharedTooLongSuffixMessage,
  buildUnavailableModelMessage as buildSharedUnavailableModelMessage,
  buildUnsupportedReasoningMessage as buildSharedUnsupportedReasoningMessage,
  buildWaitUnavailableMessage as buildSharedWaitUnavailableMessage,
} from "../control-panel-view-messages.js";

export function buildTopicOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedOnlyMessage({
    command: "/menu inside a topic",
    description: {
      english: "This menu changes settings only for the current topic.",
    },
    language,
  });
}

export function buildPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputStartedMessage({
    kind,
    language,
    suffixText: {
      english: "Send the next text message with the new topic suffix text.",
    },
    waitText: {
      english: "Send 45s, 2m, 600, or off as the next text message.",
    },
    goalText: {
      english: "Send the next text message as the app-server-v2 goal.",
    },
  });
}

export function buildPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputCanceledMessage(language);
}

export function buildPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputNeedsTextMessage(language);
}

export function buildInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidCustomWaitMessage({
    language,
    scopeLabel: "topic",
  });
}

export function buildInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidSuffixMessage({
    language,
    scopeLabel: "Topic",
  });
}

export function buildTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedTooLongSuffixMessage({
    language,
    maxChars: PROMPT_SUFFIX_MAX_CHARS,
    scopeLabel: "Topic",
  });
}

export function buildLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedLanguageUpdatedMessage({
    currentLabel: getLanguageLabel(language),
    language,
  });
}

export function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedWaitUnavailableMessage(language);
}

export function buildMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedMenuRefreshMessage({
    language,
    scopeLabel: "Topic",
  });
}

export function buildUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnavailableModelMessage(language);
}

export function buildUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnsupportedReasoningMessage(language);
}

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

export function buildGlobalMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedMenuRefreshMessage({
    language,
    scopeLabel: "Global",
  });
}

export function buildGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedOnlyMessage({
    command: "/global in General",
    description: {
      english: "It controls gateway-wide defaults and keeps one pin-friendly menu message there.",
    },
    language,
  });
}

export function buildGlobalPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputStartedMessage({
    kind,
    language,
    newTopicText: {
      english: "Send the next text message with the new topic title.",
    },
    suffixText: {
      english: "Send the next text message with the new global suffix text.",
    },
    waitText: {
      english: "Send 45s, 2m, 600, or off as the next text message.",
    },
  });
}

export function buildGlobalPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputCanceledMessage(language);
}

export function buildGlobalPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputNeedsTextMessage(language);
}

export function buildGlobalInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidCustomWaitMessage({
    language,
    scopeLabel: "global",
  });
}

export function buildGlobalWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedWaitUnavailableMessage(language);
}

export function buildGlobalInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidSuffixMessage({
    language,
    scopeLabel: "Global",
  });
}

export function buildGlobalTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedTooLongSuffixMessage({
    language,
    maxChars: PROMPT_SUFFIX_MAX_CHARS,
    scopeLabel: "Global",
  });
}

export function buildGlobalLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedLanguageUpdatedMessage({
    currentLabel: getLanguageLabel(language),
    language,
  });
}

export function buildGlobalUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnavailableModelMessage(language);
}

export function buildGlobalUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnsupportedReasoningMessage(language);
}

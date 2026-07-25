import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../../session-manager/prompt-suffix.js";
import {
  parseWaitCommandArgs,
} from "../command-parsing.js";
import { buildHostSelectionStartedMessage } from "../command-handlers/host-commands.js";
import {
  getPendingInputMessageText,
  isPendingInputTargetMessage,
  isSamePendingInputRequester,
  withPendingInputStatus,
} from "../control-panel-pending-input.js";
import {
  buildGlobalInvalidCustomWaitMessage,
  buildGlobalInvalidSuffixMessage,
  buildGlobalPendingInputCanceledMessage,
  buildGlobalPendingInputNeedsTextMessage,
  buildGlobalPendingInputStartedMessage,
  buildGlobalTooLongSuffixMessage,
  buildGlobalWaitUnavailableMessage,
  getGlobalControlLanguage,
} from "../global-control-panel-view.js";
import { ensureGlobalControlPanelMessage } from "../global-control-panel-lifecycle.js";
import { isGeneralForumMessage } from "./common.js";

function quoteCommandArgument(value) {
  return JSON.stringify(String(value ?? "").trim());
}

function isGlobalPendingInputMessage(message, pendingInput, config) {
  if (!isGeneralForumMessage(message, config)) {
    return false;
  }

  return isPendingInputTargetMessage(message, pendingInput);
}

function buildNewTopicPendingStatus(extra, language) {
  return extra.single_host_auto_selected
    ? buildGlobalPendingInputStartedMessage("new_topic_title", language)
    : buildHostSelectionStartedMessage({
        hostId: extra.requested_host_id,
        hostLabel: extra.requested_host_label,
      }, language);
}

async function updateGlobalPendingInputMenu({
  activeScreen,
  api,
  config,
  controlState,
  globalControlPanelStore,
  message,
  pendingInput,
  promptFragmentAssembler,
  sessionService,
}) {
  await globalControlPanelStore.patch({
    pending_input: pendingInput,
    active_screen: activeScreen,
    menu_message_id: pendingInput?.menu_message_id ?? controlState.menu_message_id,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen,
    actor: message,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: pendingInput,
      active_screen: activeScreen,
      menu_message_id: pendingInput?.menu_message_id ?? controlState.menu_message_id,
    },
    globalControlPanelStore,
    preferredMessageId: pendingInput?.menu_message_id ?? controlState.menu_message_id,
    promptFragmentAssembler,
    sessionService,
  });
}

export async function startGlobalControlPendingInput({
  actor,
  api,
  config,
  controlState,
  extra = {},
  globalControlPanelStore,
  kind,
  promptFragmentAssembler,
  requestedByUserId,
  screen = null,
  sessionService,
}) {
  const language = getGlobalControlLanguage(controlState);
  const nextPendingInput = {
    kind,
    requested_at: new Date().toISOString(),
    requested_by_user_id: String(requestedByUserId),
    menu_message_id: actor.message_id,
    screen: screen || (kind === "suffix_text" ? "suffix" : kind === "new_topic_title" ? "new_topic" : "wait"),
    status_message: kind === "new_topic_title"
      ? buildNewTopicPendingStatus(extra, language)
      : buildGlobalPendingInputStartedMessage(kind, language),
    ...extra,
  };
  await globalControlPanelStore.patch({
    pending_input: nextPendingInput,
    menu_message_id: actor.message_id,
    active_screen: nextPendingInput.screen,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: nextPendingInput.screen,
    actor,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: nextPendingInput,
      menu_message_id: actor.message_id,
      active_screen: nextPendingInput.screen,
    },
    globalControlPanelStore,
    preferredMessageId: actor.message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-started",
  };
}

export async function clearGlobalControlPendingInput({
  actor,
  api,
  config,
  controlState,
  globalControlPanelStore,
  promptFragmentAssembler,
  sessionService,
}) {
  const language = getGlobalControlLanguage(controlState);
  await globalControlPanelStore.patch({
    pending_input: null,
    menu_message_id: actor.message_id,
    active_screen: controlState.active_screen,
    ui_language: language,
    notice: buildGlobalPendingInputCanceledMessage(language),
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: controlState.active_screen,
    actor,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: null,
      menu_message_id: actor.message_id,
      notice: buildGlobalPendingInputCanceledMessage(language),
    },
    globalControlPanelStore,
    preferredMessageId: actor.message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-cleared",
  };
}

export async function maybeHandleGlobalControlReply({
  api,
  config,
  dispatchCommand,
  globalControlPanelStore,
  message,
  promptFragmentAssembler,
  sessionService,
  applyGlobalWaitChange = null,
}) {
  if (!globalControlPanelStore) {
    return { handled: false };
  }

  const controlState = await globalControlPanelStore.load({ force: true });
  const pendingInput = controlState.pending_input;
  const language = getGlobalControlLanguage(controlState);
  if (!pendingInput) {
    return { handled: false };
  }

  if (!isGlobalPendingInputMessage(message, pendingInput, config)) {
    return { handled: false };
  }

  if (!isSamePendingInputRequester(message, pendingInput)) {
    return {
      handled: true,
      reason: "global-control-pending-input-owner-mismatch",
    };
  }

  const text = getPendingInputMessageText(message);
  if (!text.trim()) {
    await updateGlobalPendingInputMenu({
      activeScreen: pendingInput.screen || controlState.active_screen,
      api,
      config,
      controlState,
      globalControlPanelStore,
      message,
      pendingInput: withPendingInputStatus(
        pendingInput,
        buildGlobalPendingInputNeedsTextMessage(language),
      ),
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-pending-input-needs-text",
    };
  }

  if (pendingInput.kind === "wait_custom") {
    const parsed = parseWaitCommandArgs(text);
    const explicitTopicScope = /^(?:topic|local)(?:\s+|$)/iu.test(text.trim());
    if (!["set", "off"].includes(parsed.action) || explicitTopicScope) {
      await updateGlobalPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        globalControlPanelStore,
        message,
        pendingInput: withPendingInputStatus(
          pendingInput,
          buildGlobalInvalidCustomWaitMessage(language),
        ),
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-invalid-custom-wait",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await updateGlobalPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        globalControlPanelStore,
        message,
        pendingInput: withPendingInputStatus(
          pendingInput,
          buildGlobalInvalidSuffixMessage(language),
        ),
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await updateGlobalPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        globalControlPanelStore,
        message,
        pendingInput: withPendingInputStatus(
          pendingInput,
          buildGlobalTooLongSuffixMessage(language),
        ),
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-suffix-too-long",
      };
    }
  }

  if (pendingInput.kind === "new_topic_title" && !text.trim()) {
    await updateGlobalPendingInputMenu({
      activeScreen: pendingInput.screen || controlState.active_screen,
      api,
      config,
      controlState,
      globalControlPanelStore,
      message,
      pendingInput: withPendingInputStatus(
        pendingInput,
        buildGlobalPendingInputNeedsTextMessage(language),
      ),
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-new-topic-needs-title",
    };
  }

  let statusMessage = null;
  if (
    pendingInput.kind === "suffix_text"
    && typeof sessionService?.updateGlobalPromptSuffix === "function"
  ) {
    const updated = await sessionService.updateGlobalPromptSuffix({
      text: normalizePromptSuffixText(text),
      enabled: true,
    });
    void updated;
    statusMessage = "Global prompt suffix updated.";
  } else if (pendingInput.kind === "new_topic_title") {
    const providerPart = pendingInput.requested_runtime_provider
      ? ` provider=${pendingInput.requested_runtime_provider}`
      : "";
    const modelPart = pendingInput.requested_runtime_model
      ? ` model=${pendingInput.requested_runtime_model}`
      : "";
    await dispatchCommand({
      actor: message.from,
      chat: message.chat,
      commandText: `/new host=${pendingInput.requested_host_id}${providerPart}${modelPart} ${quoteCommandArgument(text)}`,
    });
  } else {
    const parsed = parseWaitCommandArgs(text);
    if (typeof applyGlobalWaitChange === "function") {
      const applied = await applyGlobalWaitChange({
        actor: message.from,
        chat: message.chat,
        value: parsed.action === "off" ? "off" : String(parsed.seconds),
      });
      if (!applied?.available) {
        await updateGlobalPendingInputMenu({
          activeScreen: pendingInput.screen || controlState.active_screen,
          api,
          config,
          controlState,
          globalControlPanelStore,
          message,
          pendingInput: withPendingInputStatus(
            pendingInput,
            buildGlobalWaitUnavailableMessage(language),
          ),
          promptFragmentAssembler,
          sessionService,
        });
        return {
          handled: true,
          reason: "global-control-wait-unavailable",
        };
      }
    } else {
      await dispatchCommand({
        actor: message.from,
        chat: message.chat,
        commandText: `/wait global ${text}`,
      });
    }
  }
  await globalControlPanelStore.patch({
    pending_input: null,
    active_screen: pendingInput.screen || controlState.active_screen,
    menu_message_id: pendingInput.menu_message_id,
    notice: statusMessage,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: pendingInput.screen || controlState.active_screen,
    actor: message,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: null,
      active_screen: pendingInput.screen || controlState.active_screen,
      menu_message_id: pendingInput.menu_message_id,
      notice: statusMessage,
    },
    globalControlPanelStore,
    preferredMessageId: pendingInput.menu_message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-applied",
  };
}

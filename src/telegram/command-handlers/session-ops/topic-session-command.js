import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
} from "../../../i18n/ui-language.js";
import {
  buildReplyMessageParams,
} from "../../command-parsing.js";
import {
  safeSendMessage,
} from "../../topic-delivery.js";
import {
  buildGoalCommandArgsFromMessages,
  handleGoalCommand,
} from "../goal-command.js";
import { launchCompactionInBackground } from "./background.js";
import {
  handleCompactCommand,
  handleDiffCommand,
  handlePurgeCommand,
} from "./session-artifacts.js";

function buildUnknownSessionCommandMessage(
  _language = DEFAULT_UI_LANGUAGE,
) {
  return "Available commands: /help, /guide, /clear, /new, /hosts, /host, /zoo, /status, /limits, /global, /menu, /language, /q, /wait, /suffix, /model, /reasoning, /interrupt, /diff, /goal, /compact, and /purge.";
}

function buildBufferedGoalCommandFlush({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  session,
  workerPool,
}) {
  return async (bufferedMessages) => {
    const promptMessages = Array.isArray(bufferedMessages) ? bufferedMessages.filter(Boolean) : [];
    const message = promptMessages.at(-1) ?? null;
    if (!message) {
      return;
    }

    const result = await handleGoalCommand({
      config,
      message,
      session,
      workerPool,
      args: buildGoalCommandArgsFromMessages(promptMessages, botUsername),
    });
    if (result.responseText) {
      await safeSendMessage(
        api,
        buildReplyMessageParams(message, result.responseText),
        session,
        lifecycleManager,
      );
    }
  };
}

export async function handleTopicSessionCommand({
  api,
  botUsername,
  command,
  config,
  lifecycleManager = null,
  markCommandHandled,
  message,
  promptFragmentAssembler = null,
  serviceState,
  session,
  sessionService,
  workerPool,
}) {
  let responseText;
  let handledSession = session;
  let backgroundCompactPromise = null;

  if (command.name === "diff") {
    const result = await handleDiffCommand({
      api,
      lifecycleManager,
      message,
      session,
      sessionService,
      language: getSessionUiLanguage(session),
    });
    handledSession = result.handledSession ?? handledSession;
    responseText = result.responseText;
    if (result.reason === "topic-unavailable") {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: result.reason };
    }
  } else if (command.name === "compact") {
    const result = await handleCompactCommand({
      session,
      sessionService,
      workerPool,
      language: getSessionUiLanguage(session),
    });
    responseText = result.responseText;
    backgroundCompactPromise = result.backgroundCompactPromise;
  } else if (command.name === "purge") {
    const result = await handlePurgeCommand({
      session,
      sessionService,
      workerPool,
      language: getSessionUiLanguage(session),
    });
    handledSession = result.handledSession ?? handledSession;
    responseText = result.responseText;
  } else if (command.name === "goal") {
    const goalArgs = buildGoalCommandArgsFromMessages([message], botUsername);
    if (promptFragmentAssembler?.shouldBufferMessage(message, goalArgs)) {
      promptFragmentAssembler.enqueue({
        message,
        flush: buildBufferedGoalCommandFlush({
          api,
          botUsername,
          config,
          lifecycleManager,
          session,
          workerPool,
        }),
        lockFlush: true,
        mode: "goal",
      });
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "goal-buffered" };
    }

    const result = await handleGoalCommand({
      config,
      message,
      session,
      workerPool,
      args: command.args,
    });
    responseText = result.responseText;
  } else {
    responseText = buildUnknownSessionCommandMessage(getSessionUiLanguage(session));
  }

  if (responseText) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }
  }

  await sessionService.recordHandledSession(
    serviceState,
    handledSession,
    command.name,
  );
  markCommandHandled(serviceState, command.name);

  if (backgroundCompactPromise) {
    launchCompactionInBackground({
      api,
      lifecycleManager,
      message,
      session,
      compactPromise: backgroundCompactPromise,
    });
  }

  return { handled: true, command: command.name };
}

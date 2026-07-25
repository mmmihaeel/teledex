import {
  buildReplyMessageParams,
  isAuthorizedMessage,
} from "./command-parsing.js";
import {
  isGeneralForumMessage,
} from "./global-control-panel.js";
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import {
  safeSendMessage,
} from "./topic-delivery.js";
import {
  buildNoSessionTopicMessage,
  buildApplyTopicWaitChange,
  maybeHandlePromptCommandRouting,
  preparePromptRoutingContext,
} from "./command-handlers/prompt-flow.js";
import { resolveGeneralUiLanguage } from "./command-handlers/control-surface.js";
import {
  buildApplyGlobalWaitChange,
  createGlobalControlDispatcher,
  handleControlPanelCallbackQuery,
  maybeHandleControlPanelCommand,
  maybeHandleControlPanelReplies,
} from "./command-handlers/control-panels.js";
import { maybeHandleSurfaceCommand } from "./command-handlers/surface-commands.js";
import {
  handleNewTopicCommand,
  handleTopicSessionCommand,
} from "./command-handlers/session-ops.js";

function markCommandHandled(serviceState, commandName) {
  serviceState.handledCommands += 1;
  serviceState.lastCommandName = commandName;
  serviceState.lastCommandAt = new Date().toISOString();
}

export async function handleIncomingMessage({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (!isAuthorizedMessage(message, config)) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "unauthorized" };
  }

  if (
    generalMessageLedgerStore
    && isGeneralForumMessage(message, config)
    && !message.is_internal_global_control_dispatch
    && Number.isInteger(message.message_id)
    && message.message_id > 0
  ) {
    await generalMessageLedgerStore.trackMessageId(message.message_id);
  }

  if (zooService) {
    const zooResult = await zooService.maybeHandleIncomingMessage({
      api,
      botUsername,
      message,
    });
    if (zooResult?.handled) {
      if (zooResult.command) {
        markCommandHandled(serviceState, zooResult.command);
      }
      if (zooResult.ackText && !zooResult.suppressAck) {
        await safeSendMessage(
          api,
          buildReplyMessageParams(message, zooResult.ackText),
          null,
          lifecycleManager,
        );
      }
      return zooResult;
    }
  }

  const dispatchGlobalControlCommand = createGlobalControlDispatcher({
    handleIncomingMessage,
    api,
    botUsername,
    config,
    lifecycleManager,
    globalControlPanelStore,
    generalMessageLedgerStore,
    topicControlPanelStore,
    zooService,
    promptStartGuard,
    promptFragmentAssembler,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
  const applyTopicWaitChange = buildApplyTopicWaitChange({
    api,
    botUsername,
    config,
    lifecycleManager,
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
  const applyGlobalWaitChange = buildApplyGlobalWaitChange({
    api,
    botUsername,
    config,
    lifecycleManager,
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });

  const controlReplyResult = await maybeHandleControlPanelReplies({
    api,
    config,
    lifecycleManager,
    globalControlPanelStore,
    message,
    promptFragmentAssembler,
    sessionService,
    topicControlPanelStore,
    workerPool,
    dispatchGlobalControlCommand,
    applyGlobalWaitChange,
    applyTopicWaitChange,
  });
  if (controlReplyResult?.handled) {
    return controlReplyResult;
  }

  const promptIngress = await preparePromptRoutingContext({
    botUsername,
    message,
    promptFragmentAssembler,
    queuePromptAssembler,
  });
  if (promptIngress.handledResult) {
    return promptIngress.handledResult;
  }
  const {
    command,
    foreignBotCommand,
    effectiveQueueCommand,
  } = promptIngress;
  const promptRoutingResult = await maybeHandlePromptCommandRouting({
    api,
    botUsername,
    config,
    lifecycleManager,
    globalControlPanelStore,
    message,
    promptStartGuard,
    promptFragmentAssembler,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
    command,
    foreignBotCommand,
    effectiveQueueCommand,
    markCommandHandled,
  });
  if (promptRoutingResult) {
    return promptRoutingResult;
  }

  if (command.name === "new") {
    const result = await handleNewTopicCommand({
      api,
      config,
      lifecycleManager,
      globalControlPanelStore,
      message: {
        ...message,
        command_args: command.args,
      },
      promptFragmentAssembler,
      topicControlPanelStore,
      sessionService,
      workerPool,
    });
    if (result.handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        result.handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: result.reason };
  }

  const generalUiLanguage = await resolveGeneralUiLanguage(globalControlPanelStore);
  const controlPanelCommandResult = await maybeHandleControlPanelCommand({
    api,
    config,
    lifecycleManager,
    globalControlPanelStore,
    generalMessageLedgerStore,
    message,
    promptFragmentAssembler,
    sessionService,
    topicControlPanelStore,
    workerPool,
    command,
    fallbackLanguage: generalUiLanguage,
    dispatchGlobalControlCommand,
  });
  if (controlPanelCommandResult) {
    markCommandHandled(serviceState, command.name);
    return {
      handled: true,
      command: command.name,
      reason: controlPanelCommandResult.reason,
    };
  }

  const surfaceCommandResult = await maybeHandleSurfaceCommand({
    api,
    command,
    config,
    globalControlPanelStore,
    lifecycleManager,
    markCommandHandled,
    message,
    promptFragmentAssembler,
    promptStartGuard,
    serviceState,
    sessionService,
    workerPool,
  });
  if (surfaceCommandResult) {
    return surfaceCommandResult;
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage(generalUiLanguage)),
      null,
      lifecycleManager,
    );
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: "general-topic" };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  return handleTopicSessionCommand({
    api,
    botUsername,
    command,
    config,
    lifecycleManager,
    markCommandHandled,
    message,
    promptFragmentAssembler,
    serviceState,
    session,
    sessionService,
    workerPool,
  });
}

export async function handleIncomingCallbackQuery({
  api,
  botUsername,
  callbackQuery,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (zooService) {
    const zooResult = await zooService.handleCallbackQuery({
      api,
      callbackQuery,
    });
    if (zooResult?.handled) {
      return zooResult;
    }
  }

  const result = await handleControlPanelCallbackQuery({
    handleIncomingMessage,
    api,
    botUsername,
    callbackQuery,
    config,
    lifecycleManager,
    globalControlPanelStore,
    generalMessageLedgerStore,
    topicControlPanelStore,
    zooService,
    promptStartGuard,
    promptFragmentAssembler,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
  });

  if (!result.handled) {
    serviceState.ignoredUpdates += 1;
  }

  return result;
}

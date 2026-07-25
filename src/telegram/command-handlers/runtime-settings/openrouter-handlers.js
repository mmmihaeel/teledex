import {
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_REASONING_EFFORT,
  OPENROUTER_REASONING_EFFORTS,
  OPENROUTER_MODELS,
  formatOpenRouterReasoningEffort,
  normalizeOpenRouterReasoningEffort,
  normalizeOpenRouterModel,
} from "../../../session-manager/codex-runtime-profiles.js";
import {
  buildCodexSettingListMessage,
  buildCodexSettingStateMessage,
  buildCodexSettingUsageMessage,
  buildInvalidCodexSettingMessage,
  formatCodexModelListEntry,
} from "./formatters.js";

function buildOpenRouterReasoningUsageMessage() {
  return [
    "Usage: /reasoning",
    "/reasoning list",
    "/reasoning minimal",
    "/reasoning low",
    "/reasoning medium",
    "/reasoning high",
    "/reasoning clear",
  ].join("\n");
}

function buildOpenRouterReasoningStateMessage({
  title,
  language: _language,
  topicValue = null,
  effectiveValue = null,
  updated = false,
}) {
  return [
    updated ? `${title} updated.` : title,
    "",
    `topic override: ${formatOpenRouterReasoningEffort(topicValue) || "default"}`,
    `effective: ${
      formatOpenRouterReasoningEffort(effectiveValue || DEFAULT_OPENROUTER_REASONING_EFFORT)
    }`,
    "",
    buildOpenRouterReasoningUsageMessage(),
  ].join("\n");
}

function buildOpenRouterReasoningListMessage({ title }) {
  return [
    title,
    "",
    ...OPENROUTER_REASONING_EFFORTS.map((entry) => `${entry.label} (${entry.value})`),
    "",
    buildOpenRouterReasoningUsageMessage(),
  ].join("\n");
}

function buildInvalidOpenRouterReasoningMessage({
  title,
  invalidValue,
  language: _language,
}) {
  return [
    `${title}: unknown reasoning "${invalidValue}".`,
    "",
    ...OPENROUTER_REASONING_EFFORTS.map((entry) => `${entry.label} (${entry.value})`),
    "",
    buildOpenRouterReasoningUsageMessage(),
  ].join("\n");
}

async function handleOpenRouterModelCommand({
  parsedCommand,
  session,
  sessionService,
  language,
}) {
  const title = "OpenRouter model";
  const entries = OPENROUTER_MODELS.map(formatCodexModelListEntry);
  const currentModel = normalizeOpenRouterModel(session?.session_runtime_model)
    || DEFAULT_OPENROUTER_MODEL;

  if (parsedCommand.scope === "global") {
    return {
      handledSession: session,
      responseText: "OpenRouter model is topic-local. Use /model list or /model provider/model inside an OpenRouter topic.",
    };
  }

  if (parsedCommand.action === "list") {
    return {
      handledSession: session,
      responseText: buildCodexSettingListMessage({
        title,
        commandName: "model",
        entries,
        language,
      }),
    };
  }

  if (parsedCommand.action === "show") {
    return {
      handledSession: session,
      responseText: buildCodexSettingStateMessage({
        title,
        commandName: "model",
        kind: "model",
        language,
        topicValue: session?.session_runtime_model ?? null,
        globalValue: null,
        effectiveValue: currentModel,
        effectiveSource: session?.session_runtime_model ? "topic" : "default",
        showTopicValue: true,
      }),
    };
  }

  if (parsedCommand.action === "clear") {
    const handledSession = await sessionService.clearSessionOpenRouterModel(session);
    return {
      handledSession,
      responseText: buildCodexSettingStateMessage({
        title: `${title} cleared.`,
        commandName: "model",
        kind: "model",
        language,
        topicValue: null,
        globalValue: null,
        effectiveValue: DEFAULT_OPENROUTER_MODEL,
        effectiveSource: "default",
        showTopicValue: true,
      }),
    };
  }

  if (parsedCommand.action === "set") {
    const normalizedValue = normalizeOpenRouterModel(parsedCommand.value);
    if (!normalizedValue) {
      return {
        handledSession: session,
        responseText: buildInvalidCodexSettingMessage({
          title,
          commandName: "model",
          kind: "model",
          invalidValue: parsedCommand.value,
          entries,
          language,
        }),
      };
    }

    const handledSession =
      await sessionService.updateSessionOpenRouterModel(session, normalizedValue);
    return {
      handledSession,
      responseText: buildCodexSettingStateMessage({
        title: `${title} updated.`,
        commandName: "model",
        kind: "model",
        language,
        topicValue: handledSession.session_runtime_model ?? null,
        globalValue: null,
        effectiveValue: normalizedValue,
        effectiveSource: "topic",
        showTopicValue: true,
      }),
    };
  }

  return {
    handledSession: session,
    responseText: buildCodexSettingUsageMessage("model", language),
  };
}

async function handleOpenRouterReasoningCommand({
  parsedCommand,
  session,
  sessionService,
  language,
}) {
  const title = "OpenRouter reasoning";
  const currentTopicValue = normalizeOpenRouterReasoningEffort(
    session?.agent_reasoning_effort_override,
  );
  const currentEffectiveValue = currentTopicValue || DEFAULT_OPENROUTER_REASONING_EFFORT;

  if (parsedCommand.scope === "global") {
    return {
      handledSession: session,
      responseText: "OpenRouter reasoning is topic-local. Use /reasoning list or /reasoning minimal|low|medium|high inside an OpenRouter topic.",
    };
  }

  if (parsedCommand.action === "list") {
    return {
      handledSession: session,
      responseText: buildOpenRouterReasoningListMessage({ title }),
    };
  }

  if (parsedCommand.action === "show") {
    return {
      handledSession: session,
      responseText: buildOpenRouterReasoningStateMessage({
        title,
        language,
        topicValue: currentTopicValue,
        effectiveValue: currentEffectiveValue,
      }),
    };
  }

  if (parsedCommand.action === "clear") {
    const handledSession = await sessionService.clearSessionCodexSetting(
      session,
      "agent",
      "reasoning",
    );
    return {
      handledSession,
      responseText: buildOpenRouterReasoningStateMessage({
        title: `${title} cleared.`,
        language,
        topicValue: null,
        effectiveValue: DEFAULT_OPENROUTER_REASONING_EFFORT,
      }),
    };
  }

  if (parsedCommand.action === "set") {
    const normalizedValue = normalizeOpenRouterReasoningEffort(parsedCommand.value);
    if (!normalizedValue) {
      return {
        handledSession: session,
        responseText: buildInvalidOpenRouterReasoningMessage({
          title,
          invalidValue: parsedCommand.value,
          language,
        }),
      };
    }

    const handledSession = await sessionService.updateSessionCodexSetting(
      session,
      "agent",
      "reasoning",
      normalizedValue,
    );
    return {
      handledSession,
      responseText: buildOpenRouterReasoningStateMessage({
        title,
        language,
        topicValue: normalizedValue,
        effectiveValue: normalizedValue,
        updated: true,
      }),
    };
  }

  return {
    handledSession: session,
    responseText: buildOpenRouterReasoningUsageMessage(),
  };
}

export async function handleOpenRouterRuntimeSettingCommand(args) {
  return args.spec.kind === "reasoning"
    ? handleOpenRouterReasoningCommand(args)
    : handleOpenRouterModelCommand(args);
}

import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import {
  loadVisibleCodexModels,
  resolveCodexRuntimeProfile,
} from "../../session-manager/codex-runtime-settings.js";

export function getGlobalControlLanguage(controlState = null) {
  return normalizeUiLanguage(controlState?.ui_language);
}

export async function loadGlobalControlLanguage(globalControlPanelStore) {
  if (!globalControlPanelStore) {
    return DEFAULT_UI_LANGUAGE;
  }

  try {
    return getGlobalControlLanguage(await globalControlPanelStore.load({ force: true }));
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

export async function loadGlobalControlPanelView({
  actor,
  config,
  promptFragmentAssembler,
  sessionService,
  screen = "root",
}) {
  const needsTopicCreationHosts =
    screen === "root"
    || screen === "hosts"
    || screen === "new_topic"
    || screen === "new_topic_runtime";
  const needsWaitState = screen === "root" || screen === "wait";
  const needsPromptSuffix = screen === "root" || screen === "suffix";
  const needsRuntimeProfiles =
    screen === "root"
    || screen === "bot_settings"
    || screen === "agent_model"
    || screen === "compact_model"
    || screen === "agent_reasoning"
    || screen === "compact_reasoning";

  let availableModels = [];
  let runtimeModels = [];
  let globalSettings = null;
  let globalPromptSuffix = null;
  let limitsSummary = null;
  let topicCreationHosts = [];
  let agentProfile = {
    model: null,
    reasoningEffort: null,
  };
  let compactProfile = {
    model: null,
    reasoningEffort: null,
  };

  if (needsRuntimeProfiles) {
    runtimeModels =
      typeof sessionService.loadAvailableCodexModels === "function"
        ? await sessionService.loadAvailableCodexModels()
        : [];
    availableModels =
      typeof sessionService.loadVisibleCodexModels === "function"
        ? await sessionService.loadVisibleCodexModels()
        : await loadVisibleCodexModels({
          configPath: config.codexConfigPath,
        });
    globalSettings = await sessionService.getGlobalCodexSettings();
    agentProfile = resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config,
      target: "agent",
      availableModels: runtimeModels,
    });
    compactProfile = resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config,
      target: "compact",
      availableModels: runtimeModels,
    });
  }

  if (needsPromptSuffix) {
    globalPromptSuffix = await sessionService.getGlobalPromptSuffix();
  }

  if (screen === "root" && typeof sessionService.getCodexLimitsSummary === "function") {
    limitsSummary = await sessionService.getCodexLimitsSummary({
      allowStale: true,
    });
  }

  if (needsTopicCreationHosts && typeof sessionService.listTopicCreationHosts === "function") {
    topicCreationHosts = await sessionService.listTopicCreationHosts();
  }

  const waitMessage = {
    chat: {
      id: actor?.chat?.id ?? config.telegramForumChatId,
    },
    from: {
      id: actor?.from?.id,
    },
  };

  return {
    availableModels,
    runtimeModels,
    globalSettings,
    globalPromptSuffix,
    limitsSummary,
    profiles: {
      agent: agentProfile,
      compact: compactProfile,
    },
    topicCreationHosts,
    deepSeekRuntimeHostIds: Array.isArray(config.deepSeekRuntimeHostIds)
      ? config.deepSeekRuntimeHostIds
      : [],
    openRouterRuntimeHostIds: Array.isArray(config.openRouterRuntimeHostIds)
      ? config.openRouterRuntimeHostIds
      : [],
    waitState:
      needsWaitState
        && typeof promptFragmentAssembler?.getStateForMessage === "function"
        ? promptFragmentAssembler.getStateForMessage(waitMessage)
        : {
            active: false,
            global: {
              active: false,
              flushDelayMs: null,
            },
          },
  };
}

import {
  loadVisibleCodexModels,
  resolveCodexRuntimeProfile,
} from "../../session-manager/codex-runtime-settings.js";
import { resolveStatusView } from "../status-view.js";
import {
  deepSeekModelEntries,
  isDeepSeekTopic,
  isOpenRouterTopic,
  openRouterModelEntries,
  resolveDeepSeekTopicModel,
  resolveDeepSeekTopicReasoning,
  resolveOpenRouterTopicModel,
  resolveOpenRouterTopicReasoning,
} from "./runtime.js";

export async function loadTopicControlPanelView({
  config,
  message,
  promptFragmentAssembler,
  session,
  sessionService,
  screen = "root",
  workerPool = null,
}) {
  const needsWaitState = screen === "root" || screen === "wait";
  const needsPromptSuffix = screen === "root" || screen === "suffix";
  const needsRuntimeProfiles =
    screen === "root"
    || screen === "bot_settings"
    || screen === "agent_model"
    || screen === "agent_reasoning";

  let availableModels = [];
  let runtimeModels = [];
  let globalPromptSuffix = null;
  let limitsSummary = null;
  let resolvedSession = session;
  let agentProfile = {
    model: null,
    reasoningEffort: null,
  };
  let statusText = null;

  if (screen === "status") {
    const statusView = await resolveStatusView({
      state: config,
      message,
      session,
      sessionService,
      workerPool,
    });
    resolvedSession = statusView.session;
    statusText = statusView.text;
  }

  if (needsRuntimeProfiles) {
    if (isDeepSeekTopic(session)) {
      availableModels = deepSeekModelEntries();
      runtimeModels = availableModels;
      agentProfile = {
        model: resolveDeepSeekTopicModel(session),
        reasoningEffort: resolveDeepSeekTopicReasoning(session),
      };
    } else if (isOpenRouterTopic(session)) {
      availableModels = openRouterModelEntries(session);
      runtimeModels = availableModels;
      agentProfile = {
        model: resolveOpenRouterTopicModel(session),
        reasoningEffort: resolveOpenRouterTopicReasoning(session),
      };
    } else {
      runtimeModels =
        typeof sessionService.loadAvailableCodexModels === "function"
          ? await sessionService.loadAvailableCodexModels(session)
          : [];
      availableModels =
        typeof sessionService.loadVisibleCodexModels === "function"
          ? await sessionService.loadVisibleCodexModels(session)
          : await loadVisibleCodexModels({
            configPath: config.codexConfigPath,
          });
      const globalSettings = await sessionService.getGlobalCodexSettings();
      agentProfile = resolveCodexRuntimeProfile({
        session,
        globalSettings,
        config,
        target: "agent",
        availableModels: runtimeModels,
      });
    }
  }

  if (needsPromptSuffix) {
    globalPromptSuffix = await sessionService.getGlobalPromptSuffix();
  }

  if (screen === "root" && typeof sessionService.getCodexLimitsSummary === "function") {
    limitsSummary = await sessionService.getCodexLimitsSummary({
      allowStale: true,
    });
  }

  return {
    availableModels,
    runtimeModels,
    globalPromptSuffix,
    limitsSummary,
    session: resolvedSession,
    profiles: {
      agent: agentProfile,
    },
    statusText,
    waitState:
      needsWaitState && typeof promptFragmentAssembler?.getStateForMessage === "function"
        ? promptFragmentAssembler.getStateForMessage(message)
        : {
            active: false,
            local: {
              active: false,
              flushDelayMs: null,
            },
          },
  };
}

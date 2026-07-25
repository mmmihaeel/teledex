import {
  getSessionUiLanguage,
} from "../../i18n/ui-language.js";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_REASONING_EFFORT,
  formatDeepSeekReasoningEffort,
  formatOpenRouterReasoningEffort,
  normalizeDeepSeekReasoningEffort,
  normalizeOpenRouterReasoningEffort,
  normalizeSessionRuntimeProvider,
  resolveDeepSeekModelContextWindow,
  resolveOpenRouterModelContextWindow,
  SESSION_PROVIDER_DEEPSEEK,
  SESSION_PROVIDER_OPENROUTER,
} from "../../session-manager/codex-runtime-profiles.js";
import { DEEPSEEK_HTTP_BACKEND } from "../../deepseek-runtime/deepseek-http-runner.js";
import { buildCodexLimitsStatusLines } from "../../codex-runtime/limits.js";
import { buildHookEconomyStatusLines } from "../../pty-worker/hook-economy.js";
import { getTopicLabel } from "../command-parsing.js";
import { buildHostStatusLines } from "../command-handlers/host-commands.js";
import {
  buildContextStatusLines,
  buildEffectiveContextSnapshot,
} from "./context-lines.js";
import {
  formatCodexSettingValue,
  formatNumber,
  getLanguageLabel,
} from "./formatting.js";
import {
  resolveDisplayBackend,
  resolveStoredSessionBackend,
} from "./runtime-profile.js";

export function buildStatusMessage(
  state,
  message,
  session,
  activeRun = null,
  contextSnapshot = null,
  runtimeProfiles = null,
  language = getSessionUiLanguage(session),
  limitsSummary = null,
  displayConfig = null,
  executionHost = null,
) {
  const hostStatus =
    executionHost
    || (
      session?.execution_host_id
        ? {
            ok: !session.execution_host_last_failure,
            hostId: session.execution_host_id,
            hostLabel: session.execution_host_label,
            lastReadyAt: session.execution_host_last_ready_at ?? null,
            failureReason: session.execution_host_last_failure ?? null,
          }
        : null
  );
  const runStatus = activeRun?.state.status ?? session.last_run_status ?? "idle";
  const sessionRuntimeProvider =
    normalizeSessionRuntimeProvider(session?.session_runtime_provider)
    || "codex";
  const isDeepSeekRuntime = sessionRuntimeProvider === SESSION_PROVIDER_DEEPSEEK;
  const isOpenRouterRuntime = sessionRuntimeProvider === SESSION_PROVIDER_OPENROUTER;
  const storedSessionBackend = resolveStoredSessionBackend(session);
  const backend = resolveDisplayBackend({
    activeBackend: activeRun?.state?.backend,
    stateBackend: state.codexBackend,
    storedBackend: storedSessionBackend,
    isDeepSeekRuntime,
  });
  const isDeepSeekHttpRuntime =
    isDeepSeekRuntime && backend === DEEPSEEK_HTTP_BACKEND;
  const effectiveContextSnapshot = buildEffectiveContextSnapshot(
    state,
    session,
    activeRun,
    contextSnapshot,
  );
  const explicitConfiguredContextWindow =
    Number.isInteger(displayConfig?.contextWindow)
      ? displayConfig.contextWindow
      : null;
  const configuredContextWindow =
    explicitConfiguredContextWindow ??
    (Number.isInteger(state.codexContextWindow) ? state.codexContextWindow : null);
  const autoCompactTokenLimit =
    (Number.isInteger(displayConfig?.autoCompactTokenLimit)
      ? displayConfig.autoCompactTokenLimit
      : null) ??
    (Number.isInteger(state.codexAutoCompactTokenLimit)
      ? state.codexAutoCompactTokenLimit
      : null);
  const agentProfile = runtimeProfiles?.agent ?? {
    model: state.codexModel ?? null,
    reasoningEffort: state.codexReasoningEffort ?? null,
    modelContextWindow: null,
  };
  const modelContextWindow = Number.isInteger(agentProfile.modelContextWindow)
    ? agentProfile.modelContextWindow
    : null;
  const resolvedConfiguredContextWindow =
    configuredContextWindow ?? modelContextWindow;
  const contextWindow =
    explicitConfiguredContextWindow ??
    resolvedConfiguredContextWindow ??
    effectiveContextSnapshot?.model_context_window;
  const displayModel = isDeepSeekRuntime
    ? session.session_runtime_model || DEFAULT_DEEPSEEK_MODEL
    : isOpenRouterRuntime
      ? session.session_runtime_model || DEFAULT_OPENROUTER_MODEL
    : agentProfile.model;
  const displayReasoning = isDeepSeekRuntime
    ? (
        normalizeDeepSeekReasoningEffort(session.agent_reasoning_effort_override)
        || normalizeDeepSeekReasoningEffort(state.deepSeekReasoningEffort)
        || DEFAULT_DEEPSEEK_REASONING_EFFORT
      )
    : isOpenRouterRuntime
      ? (
          normalizeOpenRouterReasoningEffort(session.agent_reasoning_effort_override)
          || normalizeOpenRouterReasoningEffort(state.openRouterReasoningEffort)
          || DEFAULT_OPENROUTER_REASONING_EFFORT
        )
      : agentProfile.reasoningEffort;
  const deepSeekContextWindow = isDeepSeekRuntime
    ? (
        Number.isInteger(displayConfig?.deepSeekContextWindow)
          ? displayConfig.deepSeekContextWindow
          : Number.isInteger(state.deepSeekContextWindow)
            ? state.deepSeekContextWindow
            : resolveDeepSeekModelContextWindow(displayModel)
      )
    : null;
  const openRouterContextWindow = isOpenRouterRuntime
    ? (
        Number.isInteger(displayConfig?.openRouterContextWindow)
          ? displayConfig.openRouterContextWindow
          : Number.isInteger(state.openRouterContextWindow)
            ? state.openRouterContextWindow
            : resolveOpenRouterModelContextWindow(displayModel)
      )
    : null;
  const deepSeekActiveTurnId =
    activeRun?.state?.activeTurnId
    ?? session.deepseek_active_turn_id
    ?? null;
  const deepSeekLastTurnId =
    session.deepseek_last_turn_id
    ?? null;
  const deepSeekRuntimeThread = displayConfig?.deepSeekRuntimeThread ?? null;
  const liveStatusWarning = displayConfig?.liveStatusWarning ?? null;
  const hookEconomySummary =
    activeRun?.state?.hookEconomy ?? displayConfig?.hookEconomySummary ?? null;
  const deepSeekLiveTurnId = deepSeekRuntimeThread?.latestTurnId ?? null;
  const deepSeekLiveTurnStatus = deepSeekRuntimeThread?.latestTurnStatus ?? null;
  const deepSeekTurnDisplay = deepSeekActiveTurnId
    ? `${deepSeekActiveTurnId} (running)`
    : deepSeekLiveTurnId
      ? `${deepSeekLiveTurnId} (${deepSeekLiveTurnStatus || "unknown"}, live)`
      : deepSeekLastTurnId ?? "unknown";

  return [
    "Status",
    "",
    `topic: ${session.topic_name ?? getTopicLabel(message)}`,
    `session: ${session.lifecycle_state}`,
    `run: ${runStatus}`,
    `backend: ${backend}`,
    ...(liveStatusWarning
      ? [
          `live status refresh: ${liveStatusWarning}`,
        ]
      : []),
    `folder: ${session.workspace_binding.cwd}`,
    `branch: ${session.workspace_binding.branch ?? "none"}`,
    "",
    ...(hostStatus
      ? [
          ...buildHostStatusLines(hostStatus, language, { session }),
          "",
        ]
      : []),
    `runtime: ${sessionRuntimeProvider}`,
    ...(isDeepSeekHttpRuntime
      ? [
        `thread: ${session.codex_thread_id ?? "unknown"}`,
        `turn: ${deepSeekTurnDisplay}`,
      ]
      : []),
    `language: ${getLanguageLabel(language)}`,
    `model: ${displayModel ?? "unknown"}`,
    ...(isDeepSeekHttpRuntime
      ? []
      : [`reasoning: ${
        isDeepSeekRuntime
          ? formatDeepSeekReasoningEffort(displayReasoning)
          : isOpenRouterRuntime
            ? formatOpenRouterReasoningEffort(displayReasoning)
            : formatCodexSettingValue("reasoning", displayReasoning, language)
      }`]),
    `context window: ${formatNumber(deepSeekContextWindow ?? openRouterContextWindow ?? contextWindow, language)}`,
    isDeepSeekRuntime || isOpenRouterRuntime
      ? "auto-compact: not applicable"
      : `auto-compact: ${formatNumber(autoCompactTokenLimit, language)}`,
    "",
    ...(isDeepSeekHttpRuntime
      ? [
        "limits: DeepSeek API (not tracked by gateway)",
      ]
      : isOpenRouterRuntime
        ? [
          "limits: OpenRouter API (not tracked by gateway)",
        ]
        : buildCodexLimitsStatusLines(limitsSummary, language)),
    ...(hookEconomySummary?.completedRuns
      ? [
        "",
        ...buildHookEconomyStatusLines(hookEconomySummary, language),
      ]
      : []),
    "",
    ...buildContextStatusLines(
      {
        ...(effectiveContextSnapshot ?? {}),
        model_context_window:
          isDeepSeekRuntime
            ? deepSeekContextWindow
            : isOpenRouterRuntime
              ? openRouterContextWindow
              : (
                effectiveContextSnapshot?.model_context_window
                ?? contextWindow
                ?? null
              ),
      },
      language,
      {
        configuredContextWindow: isDeepSeekRuntime
          ? deepSeekContextWindow
          : isOpenRouterRuntime
            ? openRouterContextWindow
            : resolvedConfiguredContextWindow,
        runtimeProvider: isDeepSeekHttpRuntime
          ? sessionRuntimeProvider
          : "codex",
        runStatus,
      },
    ),
  ].join("\n");
}

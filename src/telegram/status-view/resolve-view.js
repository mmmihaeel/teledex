import {
  getSessionUiLanguage,
} from "../../i18n/ui-language.js";
import {
  normalizeSessionRuntimeProvider,
  SESSION_PROVIDER_DEEPSEEK,
} from "../../session-manager/codex-runtime-profiles.js";
import { DEEPSEEK_HTTP_BACKEND } from "../../deepseek-runtime/deepseek-http-runner.js";
import {
  CONTEXT_SNAPSHOT_SOURCE_CODEX_SESSIONS,
} from "../../session-manager/session-context-service.js";
import {
  CONTEXT_SNAPSHOT_SOURCE_REMOTE_CODEX_SESSIONS,
  fetchRemoteCodexContextSnapshot,
} from "../../session-manager/remote-context-snapshot.js";
import { fetchDeepSeekThreadSnapshot } from "../../deepseek-runtime/deepseek-http-status.js";
import {
  mergeActiveRunContextSnapshot,
} from "./context-lines.js";
import {
  resolveStatusRuntimeProfile,
  resolveStoredSessionBackend,
} from "./runtime-profile.js";
import { buildStatusMessage } from "./message.js";

async function loadPersistedHookEconomySummary(sessionService, session) {
  if (
    !session
    || typeof sessionService?.sessionStore?.readSessionText !== "function"
  ) {
    return null;
  }

  try {
    const text = await sessionService.sessionStore.readSessionText(
      session,
      "hook-economy.json",
    );
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function resolveStatusView({
  fetchRemoteCodexContextSnapshotImpl = fetchRemoteCodexContextSnapshot,
  state,
  message,
  session,
  sessionService,
  workerPool = null,
  language = getSessionUiLanguage(session),
}) {
  const activeRun =
    typeof workerPool?.getActiveRun === "function"
      ? workerPool.getActiveRun(session.session_key)
      : null;
  const executionHost =
    typeof sessionService.resolveSessionExecution === "function"
      ? await sessionService.resolveSessionExecution(session)
      : null;
  const contextState =
    typeof sessionService.resolveContextSnapshot === "function"
      ? await sessionService.resolveContextSnapshot(session, {
          threadId: activeRun?.state?.threadId ?? session.codex_thread_id ?? null,
          rolloutPath:
            activeRun?.state?.rolloutPath ?? session.codex_rollout_path ?? null,
        })
      : {
          session,
          snapshot: null,
        };
  let statusContextState = contextState;
  let liveStatusWarning = null;
  const canReadRemoteCodexSessionTail =
    activeRun?.state?.status
    && activeRun?.state?.backend !== DEEPSEEK_HTTP_BACKEND
    && contextState.session?.last_run_backend !== DEEPSEEK_HTTP_BACKEND;
  if (canReadRemoteCodexSessionTail) {
    try {
      const remoteContextState = await fetchRemoteCodexContextSnapshotImpl({
        connectTimeoutSecs: state.hostSshConnectTimeoutSecs,
        currentHostId: state.currentHostId,
        executionHost,
        threadId: activeRun?.state?.threadId ?? session.codex_thread_id ?? null,
      });
      if (remoteContextState?.snapshot) {
        statusContextState = {
          ...remoteContextState,
          session: contextState.session,
        };
      }
    } catch {
      liveStatusWarning = "remote token tail unavailable";
    }
  }
  const handledSession = statusContextState.session;
  const mergedContextSnapshot = mergeActiveRunContextSnapshot(
    statusContextState.snapshot,
    activeRun,
    {
      preferActiveUsage:
        ![
          CONTEXT_SNAPSHOT_SOURCE_CODEX_SESSIONS,
          CONTEXT_SNAPSHOT_SOURCE_REMOTE_CODEX_SESSIONS,
        ].includes(statusContextState.source),
    },
  );
  if (activeRun?.state && mergedContextSnapshot) {
    activeRun.state.contextSnapshot = mergedContextSnapshot;
    activeRun.state.rolloutPath =
      mergedContextSnapshot.rollout_path ??
      handledSession.codex_rollout_path ??
      null;
  }

  const agentRuntimeProfile = await resolveStatusRuntimeProfile(
    sessionService,
    handledSession,
    state,
    "agent",
  );
  const limitsSummary =
    typeof sessionService.getCodexLimitsSummary === "function"
      ? await sessionService.getCodexLimitsSummary({ allowStale: true })
      : null;
  const runtimeProfiles = {
    agent: agentRuntimeProfile,
  };
  const isDeepSeekRuntime =
    normalizeSessionRuntimeProvider(handledSession?.session_runtime_provider)
    === SESSION_PROVIDER_DEEPSEEK;
  const storedBackend = resolveStoredSessionBackend(handledSession);
  const deepSeekRuntimeThread =
    isDeepSeekRuntime
      && (activeRun?.state?.backend ?? storedBackend) === DEEPSEEK_HTTP_BACKEND
      ? await fetchDeepSeekThreadSnapshot({
          apiUrl: state.deepSeekRuntimeApiUrl ?? null,
          connectTimeoutSecs: state.hostSshConnectTimeoutSecs,
          currentHostId: state.currentHostId,
          executionHost,
          threadId: activeRun?.state?.threadId ?? handledSession.codex_thread_id,
        })
      : null;
  const statusContextSnapshot =
    deepSeekRuntimeThread?.latestUsage
      ? {
          ...(mergedContextSnapshot ?? {}),
          last_token_usage: deepSeekRuntimeThread.latestUsage,
        }
      : mergedContextSnapshot;
  const displayConfig =
    deepSeekRuntimeThread || liveStatusWarning
      ? {
          ...(deepSeekRuntimeThread ? { deepSeekRuntimeThread } : {}),
          ...(liveStatusWarning ? { liveStatusWarning } : {}),
        }
      : null;
  const persistedHookEconomySummary = activeRun?.state?.hookEconomy?.completedRuns
    ? null
    : await loadPersistedHookEconomySummary(sessionService, handledSession);
  const statusDisplayConfig =
    persistedHookEconomySummary
      ? {
          ...(displayConfig ?? {}),
          hookEconomySummary: persistedHookEconomySummary,
        }
      : displayConfig;

  return {
    session: handledSession,
    activeRun,
    contextSnapshot: statusContextSnapshot,
    executionHost,
    runtimeProfiles,
    limitsSummary,
    language,
    text: buildStatusMessage(
      state,
      message,
      handledSession,
      activeRun,
      statusContextSnapshot,
      runtimeProfiles,
      language,
      limitsSummary,
      statusDisplayConfig,
      executionHost,
    ),
  };
}

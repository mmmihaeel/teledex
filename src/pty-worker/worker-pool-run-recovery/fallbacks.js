import { getSessionUiLanguage } from "../../i18n/ui-language.js";
import {
  buildProgressText,
  isCodexResumeStreamDisconnectError,
  isCodexThreadCorruptionError,
  isContextWindowExceededText,
} from "../worker-pool-common.js";
import {
  buildRunEventSessionFields,
  buildRunResultDiagnosticFields,
  normalizeOptionalText,
  noteRunEventBestEffort,
} from "../worker-pool-lifecycle-common.js";
import {
  isLegacyAppServerBackend,
  supportsCodexRolloutPathContinuity,
} from "../backend-capabilities.js";
import {
  buildClearContinuitySessionPatch,
  clearRunContinuityState,
} from "../worker-pool-continuity.js";
import {
  resetRunTokenUsageCumulativeDomain,
} from "../worker-pool-run-token-usage.js";

function resultMessages(result) {
  return [
    result?.abortReason,
    ...(Array.isArray(result?.warnings) ? result.warnings : []),
  ];
}

export function shouldRecoverContextWindow(pool, run, result, recoveredContextWindowCount) {
  if (recoveredContextWindowCount > 0 || run?.state?.interruptRequested) {
    return false;
  }
  if (!pool?.sessionCompactor || typeof pool.sessionCompactor.compact !== "function") {
    return false;
  }
  if (result?.ok === true || result?.interrupted === true) {
    return false;
  }

  return resultMessages(result).some((value) => isContextWindowExceededText(value));
}

export function shouldRecoverThreadCorruption(
  pool,
  run,
  result,
  recoveredThreadCorruptionCount,
  { requestedThreadId = null } = {},
) {
  if (recoveredThreadCorruptionCount > 0 || run?.state?.interruptRequested) {
    return false;
  }
  if (!pool?.sessionCompactor || typeof pool.sessionCompactor.compact !== "function") {
    return false;
  }
  if (result?.ok === true || result?.interrupted === true) {
    return false;
  }

  const messages = resultMessages(result);
  if (!messages.some((value) => isCodexThreadCorruptionError(value))) {
    return false;
  }

  const streamDisconnect = messages.some((value) =>
    isCodexResumeStreamDisconnectError(value),
  );
  if (streamDisconnect && !normalizeOptionalText(requestedThreadId)) {
    return false;
  }

  return true;
}

async function prepareFreshThreadFallback(
  pool,
  run,
  {
    prompt,
    recoveryAttempt = 1,
    recoveryKind,
    compactionReason,
    priorResult = null,
  },
) {
  await noteRunEventBestEffort(pool, "run.recovery", {
    ...buildRunEventSessionFields(run.session),
    recovery_kind: recoveryKind,
    attempt: recoveryAttempt,
    prior_thread_id: normalizeOptionalText(run.state.threadId) || null,
    ...buildRunResultDiagnosticFields(priorResult),
  });

  run.state.status = "rebuilding";
  run.state.resumeMode = recoveryKind;
  run.state.latestSummary = recoveryKind;
  run.state.latestSummaryKind = "rebuild";
  run.state.latestProgressMessage = null;
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;
  run.state.finalAgentMessageSource = null;

  const compacted = await pool.sessionCompactor.compact(run.session, {
    reason: compactionReason,
    includeProgressNotes: true,
    latestUserPrompt: run.exchangePrompt,
    progressRunStartedAt: run.startedAt,
  });
  const compactedSession = compacted?.session || run.session;
  run.session = await pool.sessionStore.patch(compactedSession, {
    last_user_prompt: run.exchangePrompt,
    last_run_status: "running",
    agent_run_owner_generation_id: pool.serviceGenerationId,
    last_run_started_at: run.startedAt,
  });
  resetRunTokenUsageCumulativeDomain(run.state);
  clearRunContinuityState(run.state);
  run.state.activeTurnId = null;

  return {
    prompt: await pool.buildFreshBriefBootstrapPrompt(run, prompt),
    sessionThreadId: null,
    skipThreadHistoryLookup: true,
  };
}

export async function prepareContextWindowFallback(
  pool,
  run,
  { prompt, recoveryAttempt = 1, priorResult = null },
) {
  return prepareFreshThreadFallback(pool, run, {
    prompt,
    recoveryAttempt,
    recoveryKind: "context-window-compact",
    compactionReason: "context-window-recovery",
    priorResult,
  });
}

export async function prepareThreadCorruptionFallback(
  pool,
  run,
  { prompt, recoveryAttempt = 1 },
) {
  return prepareFreshThreadFallback(pool, run, {
    prompt,
    recoveryAttempt,
    recoveryKind: "exec-thread-corruption",
    compactionReason: "thread-corruption-recovery",
  });
}

export async function prepareInterruptedRunFallback(
  pool,
  run,
  { prompt, recoveryKind, priorThreadId = null },
) {
  const resumeThreadId =
    typeof priorThreadId === "string" && priorThreadId.trim()
      ? priorThreadId.trim()
      : null;
  const legacyAppServerBackend = isLegacyAppServerBackend(run?.state?.backend);
  const rolloutPathContinuityBackend = supportsCodexRolloutPathContinuity(run?.state?.backend);
  const shouldClearProviderContinuity = !resumeThreadId || !legacyAppServerBackend;
  const shouldClearRolloutPathContinuity = !resumeThreadId || !rolloutPathContinuityBackend;
  if (!resumeThreadId) {
    resetRunTokenUsageCumulativeDomain(run.state);
  }
  run.session = await pool.sessionStore.patch(run.session, {
    codex_thread_id: resumeThreadId,
    ...buildClearContinuitySessionPatch({
      thread: false,
      threadRuntimeProfile: false,
      provider: shouldClearProviderContinuity,
      rollout: shouldClearRolloutPathContinuity,
      context: shouldClearProviderContinuity,
    }),
  });
  run.state.providerSessionId = shouldClearProviderContinuity
    ? null
    : (run.session.provider_session_id ?? run.state.providerSessionId);
  run.state.threadId = resumeThreadId;
  run.state.activeTurnId = null;
  run.state.rolloutPath = shouldClearRolloutPathContinuity
    ? null
    : (run.session.codex_rollout_path ?? run.state.rolloutPath);
  run.state.contextSnapshot = shouldClearProviderContinuity
    ? null
    : (run.session.last_context_snapshot ?? run.state.contextSnapshot);
  run.state.status = "rebuilding";
  run.state.resumeMode = recoveryKind;
  run.state.latestSummary = recoveryKind;
  run.state.latestSummaryKind = "rebuild";
  const holdLiveSteerProgress =
    recoveryKind === "live-steer-restart" &&
    run.state.holdProgressUntilNaturalUpdate;
  if (!holdLiveSteerProgress) {
    run.state.latestProgressMessage = null;
  }
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;
  run.state.finalAgentMessageSource = null;
  if (!holdLiveSteerProgress) {
    run.state.progress?.queueUpdate(
      buildProgressText(run.state, getSessionUiLanguage(run.session)),
    );
  }

  if (resumeThreadId) {
    return {
      prompt,
      sessionThreadId: resumeThreadId,
      skipThreadHistoryLookup: false,
    };
  }

  return {
    prompt,
    sessionThreadId: null,
    skipThreadHistoryLookup: true,
  };
}

export async function prepareResumeFallback(
  pool,
  run,
  { resumeReplacement },
) {
  const current =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id))
    || run.session;
  const requestedThreadId =
    typeof resumeReplacement?.requestedThreadId === "string"
    && resumeReplacement.requestedThreadId.trim()
      ? resumeReplacement.requestedThreadId.trim()
      : null;

  run.session = current;
  const legacyAppServerBackend = isLegacyAppServerBackend(run?.state?.backend);
  const rolloutPathContinuityBackend = supportsCodexRolloutPathContinuity(run?.state?.backend);
  run.state.providerSessionId =
    legacyAppServerBackend
      ? current.provider_session_id ?? run.state.providerSessionId
      : null;
  run.state.threadId =
    current.codex_thread_id ?? requestedThreadId ?? run.state.threadId;
  run.state.rolloutPath = rolloutPathContinuityBackend
    ? current.codex_rollout_path ?? run.state.rolloutPath
    : null;
  run.state.contextSnapshot =
    legacyAppServerBackend
      ? current.last_context_snapshot ?? run.state.contextSnapshot
      : null;
  run.state.resumeMode = "resume-pending";
  run.state.latestSummary =
    requestedThreadId
      ? `resume-unavailable:${requestedThreadId}`
      : "resume-unavailable";
  run.state.latestSummaryKind = "event";
  run.state.latestProgressMessage = null;
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;

  return {
    exitCode: 1,
    signal: null,
    threadId: run.state.threadId,
    providerSessionId: run.state.providerSessionId,
    rolloutPath: run.state.rolloutPath,
    contextSnapshot: run.state.contextSnapshot,
    warnings: [
      requestedThreadId
        ? `Native Codex resume is unavailable for thread ${requestedThreadId}; continuity metadata was preserved for the next prompt retry.`
        : "Native Codex resume is unavailable right now; continuity metadata was preserved for the next prompt retry.",
    ],
    abortReason: "resume_unavailable",
    interrupted: false,
    resumeReplacement: null,
    preserveContinuity: true,
  };
}

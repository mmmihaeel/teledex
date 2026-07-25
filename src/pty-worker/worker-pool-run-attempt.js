import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { resetCompactJsonlLogMirrorArtifacts } from "../codex-exec/jsonl-log-mirror.js";
import { writeTextAtomic } from "../state/file-utils.js";
import { extractTelegramFileDirectives } from "../transport/telegram-file-directive.js";
import { normalizeTelegramReply } from "../transport/telegram-reply-normalizer.js";
import {
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import {
  SESSION_PROVIDER_DEEPSEEK,
  resolveSessionCodexRuntimeProfile,
} from "../session-manager/codex-runtime-profiles.js";
import { DEEPSEEK_HTTP_BACKEND } from "../deepseek-runtime/deepseek-http-runner.js";
import { loadAvailableCodexModelsForSession } from "../session-manager/codex-runtime-host.js";
import {
  buildProgressText,
  excerpt,
  isHiddenProgressDetail,
  outputTail,
  signalChildProcessGroup,
} from "./worker-pool-common.js";
import {
  isLegacyAppServerBackend,
  supportsCodexRolloutPathContinuity,
} from "./backend-capabilities.js";
import { buildCompactResumePrompt } from "./compact-resume.js";
import { buildDeveloperContextSignature } from "./developer-context-signature.js";
import {
  buildRuntimeHookEventDetails,
  recordHookEconomyEvent,
} from "./hook-economy.js";
import {
  buildClearContinuitySessionPatch,
  clearRunContinuityState,
  sanitizeContextSnapshotForBackend,
} from "./worker-pool-continuity.js";
import { normalizeOptionalText } from "./worker-pool-lifecycle-common.js";
import {
  applyRunTokenUsageSummary,
  resetRunTokenUsageCumulativeDomain,
} from "./worker-pool-run-token-usage.js";

function createAttemptInsight() {
  return {
    primaryThreadStarted: false,
    commentaryCount: 0,
    commandCount: 0,
    sawFinalAnswer: false,
    lastEventKind: null,
    lastEventType: null,
  };
}

function formatDeepSeekCommandProgress(summary) {
  const output = outputTail(summary.aggregatedOutput || "", 6, 500);
  const normalized = normalizeTelegramReply(output);
  if (!normalized || isHiddenProgressDetail(normalized)) {
    return null;
  }
  return normalized;
}

async function loadRuntimeProfileInputs(pool, run) {
  if (!Object.hasOwn(run.runtimeProfileInputs, "globalCodexSettings")) {
    run.runtimeProfileInputs.globalCodexSettings = pool.globalCodexSettingsStore
      ? await pool.globalCodexSettingsStore.load()
      : null;
  }
  if (!Object.hasOwn(run.runtimeProfileInputs, "availableModels")) {
    run.runtimeProfileInputs.availableModels = await loadAvailableCodexModelsForSession({
      session: run.session,
      defaultConfigPath: pool.config.codexConfigPath,
      hostRegistryService: pool.hostRegistryService,
    });
  }

  return run.runtimeProfileInputs;
}

function buildLastRunRuntimeProfilePatch(state) {
  const model = normalizeOptionalText(state.model);
  const reasoningEffort = normalizeOptionalText(state.reasoningEffort);
  const runtimeProfileId = normalizeOptionalText(state.runtimeProfileId);
  const clearCodexReasoning = state.backend === DEEPSEEK_HTTP_BACKEND;
  const patch = {};
  if (model) {
    patch.last_run_model = model;
  }
  if (reasoningEffort) {
    patch.last_run_reasoning_effort = reasoningEffort;
  } else if (clearCodexReasoning) {
    patch.last_run_reasoning_effort = null;
  }
  patch.last_run_runtime_profile_id = runtimeProfileId;
  return patch;
}

function buildThreadRuntimeProfilePatch(state) {
  const model = normalizeOptionalText(state.model);
  const reasoningEffort = normalizeOptionalText(state.reasoningEffort);
  const runtimeProfileId = normalizeOptionalText(state.runtimeProfileId);
  const patch = buildLastRunRuntimeProfilePatch(state);
  if (model) {
    patch.codex_thread_model = model;
  }
  if (reasoningEffort) {
    patch.codex_thread_reasoning_effort = reasoningEffort;
  } else if (state.backend === DEEPSEEK_HTTP_BACKEND) {
    patch.codex_thread_reasoning_effort = null;
  }
  patch.codex_thread_runtime_profile_id = runtimeProfileId;
  return patch;
}

function resolveRuntimeProfileRotationReason(session, runtimeProfile, sessionThreadId) {
  const threadId = normalizeOptionalText(sessionThreadId);
  if (!threadId) {
    return null;
  }

  const nextModel = normalizeOptionalText(runtimeProfile?.model);
  const nextReasoning = normalizeOptionalText(runtimeProfile?.reasoningEffort);
  const nextRuntimeProfileId = normalizeOptionalText(runtimeProfile?.runtimeProfileId);
  const threadModel = normalizeOptionalText(session?.codex_thread_model);
  const threadReasoning = normalizeOptionalText(
    session?.codex_thread_reasoning_effort,
  );
  const threadRuntimeProfileId = normalizeOptionalText(
    session?.codex_thread_runtime_profile_id,
  );

  if (nextRuntimeProfileId !== threadRuntimeProfileId) {
    return "runtime-profile-changed";
  }

  if (threadModel && nextModel && threadModel !== nextModel) {
    return "model-changed";
  }
  if (threadReasoning && nextReasoning && threadReasoning !== nextReasoning) {
    return "reasoning-changed";
  }

  const explicitModelSource =
    runtimeProfile?.modelSource === "topic"
    || runtimeProfile?.modelSource === "global";
  const explicitReasoningSource =
    runtimeProfile?.reasoningSource === "topic"
    || runtimeProfile?.reasoningSource === "global";

  if (!threadModel && nextModel && explicitModelSource) {
    return "unknown-thread-model";
  }
  if (!threadReasoning && nextReasoning && explicitReasoningSource) {
    return "unknown-thread-reasoning";
  }

  return null;
}

async function prepareDeveloperContextRefresh(pool, run, {
  prompt,
  sessionThreadId,
  developerContextHash,
  backend,
  legacyAppServerBackend,
}) {
  const threadId = normalizeOptionalText(sessionThreadId);
  const currentHash = normalizeOptionalText(developerContextHash);
  if (!threadId || !currentHash || legacyAppServerBackend || backend !== "app-server-v2") {
    return null;
  }

  const storedHash = normalizeOptionalText(
    run.session?.codex_thread_developer_context_hash,
  );
  if (storedHash === currentHash) {
    return null;
  }

  const activeBrief =
    typeof pool.sessionStore?.loadActiveBrief === "function"
      ? await pool.sessionStore.loadActiveBrief(run.session)
      : "";
  if (!String(activeBrief || "").trim()) {
    return null;
  }

  const refreshedPrompt = buildCompactResumePrompt({
    session: run.session,
    prompt,
    compactState: { activeBrief },
    mode: "developer-context-refresh",
  });
  return {
    prompt: refreshedPrompt,
    reason: storedHash ? "developer-context-changed" : "developer-context-untracked",
  };
}

async function applyRuntimeState(pool, run, payload = {}) {
  const { state } = run;
  const {
    threadId,
    activeTurnId,
    providerSessionId,
    rolloutPath,
    contextSnapshot,
  } = payload;
  const nextThreadId = normalizeOptionalText(threadId);
  const nextActiveTurnId = normalizeOptionalText(activeTurnId);
  const legacyAppServerBackend = isLegacyAppServerBackend(state.backend);
  const rolloutPathContinuityBackend = supportsCodexRolloutPathContinuity(state.backend);
  const nextProviderSessionId = legacyAppServerBackend
    ? normalizeOptionalText(providerSessionId)
    : null;
  const nextRolloutPath = rolloutPathContinuityBackend
    ? normalizeOptionalText(rolloutPath)
    : null;
  const nextContextSnapshotRolloutPath =
    contextSnapshot && !legacyAppServerBackend
      ? normalizeOptionalText(contextSnapshot.rollout_path)
      : null;
  const nextContextSnapshot = sanitizeContextSnapshotForBackend(
    contextSnapshot,
    { legacyAppServerBackend },
  );
  const threadChanged =
    nextThreadId
    && nextThreadId !== (state.threadId || run.session.codex_thread_id || null);
  const patch = {};

  if (nextThreadId) {
    if (threadChanged) {
      resetRunTokenUsageCumulativeDomain(state);
      state.activeTurnId = null;
    }
    state.threadId = nextThreadId;
    patch.codex_thread_id = nextThreadId;
    Object.assign(patch, buildThreadRuntimeProfilePatch(state));
    if (normalizeOptionalText(state.developerContextHash)) {
      patch.codex_thread_developer_context_hash = state.developerContextHash;
    }
  }
  if (threadChanged && !nextProviderSessionId) {
    state.providerSessionId = null;
    patch.provider_session_id = null;
  }
  if (nextActiveTurnId) {
    state.activeTurnId = nextActiveTurnId;
  }
  if (nextProviderSessionId) {
    state.providerSessionId = nextProviderSessionId;
    if (nextProviderSessionId !== run.session.provider_session_id) {
      patch.provider_session_id = nextProviderSessionId;
    }
  }
  if (nextRolloutPath) {
    state.rolloutPath = nextRolloutPath;
    if (nextRolloutPath !== run.session.codex_rollout_path) {
      patch.codex_rollout_path = nextRolloutPath;
    }
  } else if (threadChanged) {
    state.rolloutPath = null;
    patch.codex_rollout_path = null;
  }
  if (nextContextSnapshot) {
    state.contextSnapshot = nextContextSnapshot;
    if (
      JSON.stringify(run.session.last_context_snapshot ?? null)
        !== JSON.stringify(nextContextSnapshot)
    ) {
      patch.last_context_snapshot = nextContextSnapshot;
    }
    if (
      nextContextSnapshotRolloutPath
      && nextContextSnapshotRolloutPath !== run.session.context_snapshot_rollout_path
    ) {
      patch.context_snapshot_rollout_path = nextContextSnapshotRolloutPath;
    }
  } else if (threadChanged) {
    state.contextSnapshot = null;
    patch.last_context_snapshot = null;
    patch.context_snapshot_rollout_path = null;
  }

  if (Object.keys(patch).length > 0) {
    run.session = await pool.sessionStore.patch(run.session, patch);
  }
}

async function handleAttemptEvent(pool, run, summary, attemptInsight) {
  const { state } = run;
  const primaryThreadEvent = summary.isPrimaryThreadEvent !== false;
  attemptInsight.lastEventKind = summary.kind || null;
  attemptInsight.lastEventType = summary.eventType || null;
  let shouldRefreshProgress = false;

  if (summary.threadId && primaryThreadEvent) {
    if (summary.eventType === "thread.started") {
      attemptInsight.primaryThreadStarted = true;
    }
    const threadChanged = summary.threadId !== run.session.codex_thread_id;
    state.threadId = summary.threadId;
    if (threadChanged) {
      resetRunTokenUsageCumulativeDomain(state);
      state.activeTurnId = null;
      clearRunContinuityState(state, { thread: false });
    }
    run.session = await pool.sessionStore.patch(run.session, {
      codex_thread_id: summary.threadId,
      ...buildThreadRuntimeProfilePatch(state),
      ...(threadChanged ? buildClearContinuitySessionPatch({ thread: false }) : {}),
    });
  }

  if (summary.kind === "command") {
    attemptInsight.commandCount += 1;
    state.latestCommand = summary.command || state.latestCommand;
    if (summary.eventType === "item.completed") {
      state.latestCommandOutput = summary.aggregatedOutput
        ? outputTail(summary.aggregatedOutput)
        : null;
      if (state.backend === DEEPSEEK_HTTP_BACKEND && summary.streamDelta) {
        const commandProgress = formatDeepSeekCommandProgress(summary);
        if (commandProgress) {
          state.latestSummary = excerpt(commandProgress, 500);
          state.latestSummaryKind = "command";
          state.latestProgressMessage = commandProgress;
          state.holdProgressUntilNaturalUpdate = false;
          await appendProgressNoteBestEffort(
            pool,
            run,
            {
              ...summary,
              progressSource: "command_execution",
            },
            commandProgress,
          );
          shouldRefreshProgress = true;
        }
      }
    }
  } else if (summary.kind === "turn" && primaryThreadEvent) {
    const isDeepSeekRun = state.backend === DEEPSEEK_HTTP_BACKEND;
    const previousActiveTurnId =
      state.activeTurnId || run.session.deepseek_active_turn_id || null;
    const terminalTurnEvent = ["turn.completed", "turn.failed", "error"].includes(
      summary.eventType,
    );
    if (summary.eventType === "turn.started") {
      state.activeTurnId = summary.turnId || state.activeTurnId;
    }

    applyRunTokenUsageSummary(state, summary);
    if (terminalTurnEvent) {
      state.activeTurnId = null;
    }
    if (isDeepSeekRun) {
      const patch = {};
      if (summary.eventType === "turn.started") {
        patch.deepseek_active_turn_id = state.activeTurnId || null;
        patch.deepseek_active_turn_status = "running";
      } else if (terminalTurnEvent) {
        patch.deepseek_active_turn_id = null;
        patch.deepseek_active_turn_status = null;
        patch.deepseek_last_turn_id = summary.turnId || previousActiveTurnId;
      }
      if (Object.keys(patch).length > 0) {
        run.session = await pool.sessionStore.patch(run.session, patch);
      }
    }
  } else if (summary.kind === "goal" && primaryThreadEvent) {
    state.currentGoal = summary.goal || state.currentGoal;
  } else if (summary.kind === "hook" && primaryThreadEvent) {
    state.hookEconomy = recordHookEconomyEvent(state.hookEconomy, summary);
    if (summary.eventType === "hook.completed") {
      const details = buildRuntimeHookEventDetails({
        session: run.session,
        summary,
      });
      try {
        if (details) {
          await pool.runtimeObserver?.appendEvent?.("codex.hook.completed", details);
        }
        await pool.sessionStore.writeSessionJson(
          run.session,
          "hook-economy.json",
          state.hookEconomy,
        );
      } catch (error) {
        state.warnings.push(`hook economy telemetry write failed: ${error?.message || error}`);
      }
    }
  } else if (summary.kind === "agent_message") {
    const messagePhase = summary.messagePhase || "final_answer";
    const normalizedAgentMessage = normalizeTelegramReply(summary.text);
    if (messagePhase === "commentary" && primaryThreadEvent) {
      attemptInsight.commentaryCount += 1;
      if (!isHiddenProgressDetail(normalizedAgentMessage)) {
        state.latestSummary = excerpt(normalizedAgentMessage, 500);
        state.latestSummaryKind = "agent_message";
        state.latestProgressMessage = normalizedAgentMessage;
        state.holdProgressUntilNaturalUpdate = false;
        await appendProgressNoteBestEffort(pool, run, summary, normalizedAgentMessage);
        shouldRefreshProgress = true;
      }
    }
    if (messagePhase === "final_answer" && primaryThreadEvent) {
      attemptInsight.sawFinalAnswer = true;
      const parsedReply = extractTelegramFileDirectives(summary.text, {
        language: getSessionUiLanguage(run.session),
      });
      state.finalAgentMessage = normalizeTelegramReply(parsedReply.text);
      state.finalAgentMessageSource = parsedReply.text;
      state.replyDocuments = parsedReply.documents;
      state.replyDocumentWarnings = parsedReply.warnings;
    }
  }

  if (!state.finalizing) {
    state.status = state.interruptRequested ? "interrupting" : "running";
  }
  if (shouldRefreshProgress) {
    state.progress.queueUpdate(
      buildProgressText(state, getSessionUiLanguage(run.session)),
    );
  }
}

async function appendProgressNoteBestEffort(pool, run, summary, text) {
  if (typeof pool.sessionStore?.appendProgressNoteEntry !== "function") {
    return;
  }
  try {
    await pool.sessionStore.appendProgressNoteEntry(run.session, {
      created_at: new Date().toISOString(),
      session_key: run.sessionKey,
      run_started_at: run.startedAt,
      thread_id: summary.threadId || run.state.threadId || run.session.codex_thread_id || null,
      source: summary.progressSource || "agent_message",
      event_type: summary.eventType || null,
      text,
    });
  } catch (error) {
    console.warn("Failed to append progress note", error);
  }
}

function applyInterruptToChild(pool, run, child) {
  const { state } = run;
  if (!state.interruptRequested || state.interruptSignalSent || !child) {
    return;
  }

  state.interruptSignalSent = true;
  signalChildProcessGroup(child, "SIGINT");
  setTimeout(() => {
    if (pool.activeRuns.get(run.sessionKey) === run && run.child === child) {
      signalChildProcessGroup(run.child, "SIGKILL");
    }
  }, 5000).unref();
}

export async function runAttempt(
  pool,
  run,
  {
    prompt,
    developerInstructions = null,
    baseInstructions = null,
    imagePaths = [],
    sessionThreadId,
    skipThreadHistoryLookup = false,
    goalStart = null,
  },
) {
  const { state } = run;
  const currentSession =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id))
    || run.session;
  run.session = currentSession;
  const { globalCodexSettings, availableModels } = await loadRuntimeProfileInputs(
    pool,
    run,
  );
  const runtimeProfile = resolveCodexRuntimeProfile({
    session: currentSession,
    globalSettings: globalCodexSettings,
    config: pool.config,
    target: "agent",
    availableModels,
  });
  const runtimeProfileOverride = await resolveSessionCodexRuntimeProfile({
    session: currentSession,
    config: pool.config,
  });
  const suppressAutoCompactFallback =
    currentSession?.session_runtime_provider === SESSION_PROVIDER_DEEPSEEK
    || runtimeProfileOverride?.modelProviderConfig?.wire_api === "deepseek_chat"
    || runtimeProfileOverride?.backend === DEEPSEEK_HTTP_BACKEND;
  if (runtimeProfileOverride) {
    const usesCodexReasoning =
      runtimeProfileOverride.backend !== DEEPSEEK_HTTP_BACKEND;
    runtimeProfile.model = runtimeProfileOverride.model;
    runtimeProfile.modelSource = "runtime-profile";
    runtimeProfile.reasoningEffort = usesCodexReasoning
      ? runtimeProfileOverride.reasoningEffort || runtimeProfile.reasoningEffort
      : null;
    runtimeProfile.reasoningSource =
      usesCodexReasoning && runtimeProfileOverride.reasoningEffort
        ? "runtime-profile"
        : runtimeProfile.reasoningSource;
    runtimeProfile.runtimeProfileId = runtimeProfileOverride.id;
    runtimeProfile.backend = runtimeProfileOverride.backend;
    runtimeProfile.contextWindow = runtimeProfileOverride.contextWindow;
    runtimeProfile.autoCompactTokenLimit = runtimeProfileOverride.autoCompactTokenLimit;
    runtimeProfile.configOverrides = runtimeProfileOverride.configOverrides;
    runtimeProfile.modelProvider = runtimeProfileOverride.modelProvider;
    runtimeProfile.modelProviderConfig = runtimeProfileOverride.modelProviderConfig;
    runtimeProfile.deepSeekApiUrl = runtimeProfileOverride.deepSeekApiUrl;
    runtimeProfile.deepSeekMode = runtimeProfileOverride.deepSeekMode;
    runtimeProfile.deepSeekAllowShell = runtimeProfileOverride.deepSeekAllowShell;
    runtimeProfile.deepSeekTrustMode = runtimeProfileOverride.deepSeekTrustMode;
    runtimeProfile.deepSeekAutoApprove = runtimeProfileOverride.deepSeekAutoApprove;
  }
  state.model = runtimeProfile.model;
  state.reasoningEffort = runtimeProfile.reasoningEffort;
  state.runtimeProfileId = runtimeProfile.runtimeProfileId ?? null;
  state.backend = runtimeProfile.backend || state.backend;
  state.developerContextHash = await buildDeveloperContextSignature({
    developerInstructions: developerInstructions ?? baseInstructions,
    workspaceRootPath: pool.config?.workspaceRootPath ?? null,
  });
  if (
    state.backend
    && (
      run.session.codex_backend !== state.backend
      || run.session.last_run_backend !== state.backend
      || run.session.last_run_runtime_profile_id !== state.runtimeProfileId
    )
  ) {
    run.session = await pool.sessionStore.patch(run.session, {
      codex_backend: state.backend,
      last_run_backend: state.backend,
      ...buildLastRunRuntimeProfilePatch(state),
    });
  }
  const profileRotationReason = resolveRuntimeProfileRotationReason(
    currentSession,
    runtimeProfile,
    sessionThreadId,
  );
  const legacyAppServerBackend = isLegacyAppServerBackend(state.backend);
  const rolloutPathContinuityBackend = supportsCodexRolloutPathContinuity(state.backend);
  let attemptPrompt = prompt;
  let effectiveSessionThreadId = sessionThreadId;
  let effectiveSkipThreadHistoryLookup = skipThreadHistoryLookup;
  const developerContextRefresh = await prepareDeveloperContextRefresh(pool, run, {
    prompt,
    sessionThreadId,
    developerContextHash: state.developerContextHash,
    backend: state.backend,
    legacyAppServerBackend,
  });
  if (developerContextRefresh) {
    attemptPrompt = developerContextRefresh.prompt;
    effectiveSessionThreadId = null;
    effectiveSkipThreadHistoryLookup = true;
    resetRunTokenUsageCumulativeDomain(state);
    state.activeTurnId = null;
    clearRunContinuityState(state);
    state.resumeMode = developerContextRefresh.reason;
    state.latestSummary = developerContextRefresh.reason;
    state.latestSummaryKind = "event";
    run.session = await pool.sessionStore.patch(run.session, {
      ...buildClearContinuitySessionPatch({
        threadRuntimeProfile: false,
        developerContextHash: true,
      }),
    });
  } else if (
    effectiveSessionThreadId
    && state.developerContextHash
    && normalizeOptionalText(run.session?.codex_thread_developer_context_hash)
      !== state.developerContextHash
  ) {
    state.developerContextHash =
      normalizeOptionalText(run.session?.codex_thread_developer_context_hash);
  }
  const attemptSessionThreadId = profileRotationReason ? null : effectiveSessionThreadId;
  const attemptProviderSessionId = profileRotationReason
    ? null
    : legacyAppServerBackend
      ? state.providerSessionId
      : null;
  const attemptRolloutPath = profileRotationReason
    ? null
    : rolloutPathContinuityBackend
      ? state.rolloutPath
      : null;
  const attemptSkipThreadHistoryLookup =
    effectiveSkipThreadHistoryLookup || Boolean(profileRotationReason);
  const execJsonRunLogPath = !legacyAppServerBackend
    && typeof pool.sessionStore?.getExecJsonRunLogPath === "function"
    ? pool.sessionStore.getExecJsonRunLogPath(
        run.session.chat_id,
        run.session.topic_id,
      )
    : null;
  if (execJsonRunLogPath) {
    await resetCompactJsonlLogMirrorArtifacts({ jsonlLogPath: execJsonRunLogPath });
    await writeTextAtomic(execJsonRunLogPath, "");
  }
  if (profileRotationReason) {
    resetRunTokenUsageCumulativeDomain(state);
    state.activeTurnId = null;
    clearRunContinuityState(state);
    state.resumeMode = null;
    state.latestSummary = `fresh-runtime-profile:${profileRotationReason}`;
    state.latestSummaryKind = "event";
  }
  const attemptStartedAt = Date.now();
  const attemptInsight = createAttemptInsight();

  const task = await pool.runTask({
    codexBinPath: pool.config.codexBinPath,
    cwd: run.session.workspace_binding.cwd,
    prompt: attemptPrompt,
    developerInstructions: developerInstructions ?? baseInstructions,
    baseInstructions,
    imagePaths,
    session: run.session,
    sessionKey: run.session.session_key,
    executionHost: run.executionHost,
    sessionThreadId: attemptSessionThreadId,
    providerSessionId: attemptProviderSessionId,
    knownRolloutPath: attemptRolloutPath,
    skipThreadHistoryLookup: attemptSkipThreadHistoryLookup,
    goalStart,
    runtimeBackend: state.backend,
    model: runtimeProfile.model,
    modelProvider: runtimeProfile.modelProvider ?? null,
    modelProviderConfig: runtimeProfile.modelProviderConfig ?? null,
    configOverrides: runtimeProfile.configOverrides ?? null,
    deepSeekApiUrl: runtimeProfile.deepSeekApiUrl ?? null,
    deepSeekMode: runtimeProfile.deepSeekMode ?? null,
    deepSeekAllowShell: runtimeProfile.deepSeekAllowShell ?? null,
    deepSeekTrustMode: runtimeProfile.deepSeekTrustMode ?? null,
    deepSeekAutoApprove: runtimeProfile.deepSeekAutoApprove ?? null,
    reasoningEffort: runtimeProfile.reasoningEffort,
    contextWindow:
      runtimeProfile.contextWindow
      ?? pool.config.codexContextWindow
      ?? null,
    autoCompactTokenLimit:
      suppressAutoCompactFallback
        ? null
        : (
            runtimeProfile.autoCompactTokenLimit
            ?? pool.config.codexAutoCompactTokenLimit
            ?? null
          ),
    jsonlLogPath: execJsonRunLogPath,
    onRuntimeState: (payload) => applyRuntimeState(pool, run, payload),
    onEvent: async (summary) => {
      await handleAttemptEvent(pool, run, summary, attemptInsight);
    },
    onWarning: (line) => {
      state.warnings.push(line);
    },
  });
  const { child, finished } = task;

  run.child = child;
  run.controller = task;
  applyInterruptToChild(pool, run, child);
  void pool.flushPendingLiveSteer(run.sessionKey, run).catch((error) => {
    state.warnings.push(`live steer flush failed: ${error.message}`);
  });

  try {
    const result = await finished;
    return {
      ...result,
      attemptInsight: {
        ...attemptInsight,
        durationMs: Date.now() - attemptStartedAt,
      },
    };
  } finally {
    if (run.child === child) {
      run.child = null;
    }
    if (run.controller === task) {
      run.controller = null;
    }
  }
}

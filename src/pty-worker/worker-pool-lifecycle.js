import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { markPromptAccepted, setActiveRunCount } from "../runtime/service-state.js";
import { TelegramProgressMessage } from "../transport/progress-message.js";
import {
  buildProgressText,
  buildPromptWithAttachments,
  isTransientTransportError,
  resolveReplyToMessageId,
  signalChildProcessGroup,
  sleep,
  stringifyMessageId,
} from "./worker-pool-common.js";
import {
  buildRunEventSessionFields,
  noteRunEventBestEffort,
} from "./worker-pool-lifecycle-common.js";
import { attachRunLifecycle } from "./worker-pool-run-lifecycle.js";
import {
  isLegacyAppServerBackend,
  supportsCodexRolloutPathContinuity,
  supportsManagedGoalStart,
} from "./backend-capabilities.js";

export {
  buildFreshBriefBootstrapPrompt,
  executeRunAttempts,
  executeRunLifecycle,
  prepareResumeFallback,
} from "./worker-pool-run-recovery.js";
export { runAttempt } from "./worker-pool-run-attempt.js";

const SHUTDOWN_DRAIN_POLL_MS = 25;

export async function startPromptRun(
  pool,
  {
    session,
    prompt,
    rawPrompt = prompt,
    message,
    attachments = [],
    includeTopicContext = true,
    goalStart = null,
    initialProgressText = null,
    initialProgressReplyToMessageId = null,
    holdInitialProgressUntilNaturalUpdate = false,
  },
) {
  const sessionKey = session.session_key;
  const allowed = pool.canStart(sessionKey);
  if (!allowed.ok) {
    return allowed;
  }

  pool.startingRuns.add(sessionKey);
  pool.startingRunSessions.set(sessionKey, session);
  let resolveStartingRun;
  const startingRunPromise = new Promise((resolve) => {
    resolveStartingRun = resolve;
  });
  pool.startingRunPromises.set(sessionKey, startingRunPromise);
  let startingRunSettled = false;
  const settleStartingRun = () => {
    if (startingRunSettled) {
      return;
    }

    startingRunSettled = true;
    if (pool.startingRunPromises.get(sessionKey) === startingRunPromise) {
      pool.startingRunPromises.delete(sessionKey);
    }
    resolveStartingRun();
  };
  let startReserved = true;
  const releaseStartReservation = () => {
    if (!startReserved) {
      return;
    }

    pool.startingRuns.delete(sessionKey);
    pool.startingRunSessions.delete(sessionKey);
    startReserved = false;
  };

  let hostExecution;
  try {
    hostExecution =
      typeof pool.hostRegistryService?.resolveSessionExecution === "function"
        ? await pool.hostRegistryService.resolveSessionExecution(session)
        : null;
  } catch (error) {
    releaseStartReservation();
    settleStartingRun();
    throw error;
  }
  if (hostExecution && !hostExecution.ok) {
    releaseStartReservation();
    settleStartingRun();
    return {
      ok: false,
      reason: "host-unavailable",
      hostId: hostExecution.hostId,
      hostLabel: hostExecution.hostLabel,
      failureReason: hostExecution.failureReason,
    };
  }

  const backend = pool.config?.codexGatewayBackend || "exec-json";
  if (goalStart && !supportsManagedGoalStart(backend)) {
    releaseStartReservation();
    settleStartingRun();
    return {
      ok: false,
      reason: "goal-backend-not-app-server-v2",
      backend,
    };
  }

  markPromptAccepted(pool.serviceState);
  let run = null;
  let lifecycleAttached = false;
  let resolveLifecycleGate = null;
  let lifecycleGateSettled = false;
  const settleLifecycleGate = (value) => {
    if (lifecycleGateSettled || typeof resolveLifecycleGate !== "function") {
      return;
    }

    lifecycleGateSettled = true;
    resolveLifecycleGate(value);
  };

  const legacyAppServerBackend = isLegacyAppServerBackend(backend);
  const rolloutPathContinuityBackend = supportsCodexRolloutPathContinuity(backend);
  const state = {
    sessionKey,
    status: "starting",
    startedAtMs: Date.now(),
    providerSessionId: legacyAppServerBackend
      ? (
        session.provider_session_id
        ?? session.last_context_snapshot?.session_id
        ?? session.last_context_snapshot?.sessionId
        ?? null
      )
      : null,
    threadId:
      session.codex_thread_id
      ?? (legacyAppServerBackend
        ? (
          session.last_context_snapshot?.thread_id
          ?? session.last_context_snapshot?.threadId
        )
        : null)
      ?? null,
    activeTurnId: null,
    rolloutPath: rolloutPathContinuityBackend ? session.codex_rollout_path ?? null : null,
    contextSnapshot: legacyAppServerBackend ? session.last_context_snapshot ?? null : null,
    latestSummary: null,
    latestSummaryKind: null,
    latestProgressMessage: null,
    latestCommandOutput: null,
    finalAgentMessage: null,
    finalAgentMessageSource: null,
    replyDocuments: [],
    replyDocumentWarnings: [],
    warnings: [],
    interruptRequested: false,
    interruptSignalSent: false,
    finalizing: false,
    resumeMode:
      session.codex_thread_id
      || (legacyAppServerBackend
        ? (
          session.last_context_snapshot?.thread_id
          || session.last_context_snapshot?.threadId
        )
        : null)
        ? "thread-resume"
        : null,
    lastTokenUsage: session.last_token_usage ?? null,
    currentRunTokenUsage: null,
    currentRunClosedTokenUsage: null,
    currentRunCumulativeTokenUsageBaseline: null,
    currentRunCumulativeTokenUsageSegment: null,
    hookEconomy: null,
    currentGoal: null,
    developerContextHash: session.codex_thread_developer_context_hash ?? null,
    latestCommand: null,
    progress: null,
    backend,
    replyToMessageId: resolveReplyToMessageId(message),
    lastTypingActionAt: 0,
    typingActionInFlight: false,
    acceptedLiveSteerCount: 0,
    holdProgressUntilNaturalUpdate: Boolean(holdInitialProgressUntilNaturalUpdate),
    liveSteerImagePaths: [],
    executionHost: hostExecution?.host ?? null,
  };

  try {
    const progress = new TelegramProgressMessage({
      api: pool.api,
      chatId: Number(session.chat_id),
      messageThreadId: Number(session.topic_id),
      replyToMessageId: initialProgressReplyToMessageId,
      onDeliveryError: async (error) => {
        if (pool.sessionLifecycleManager) {
          return pool.sessionLifecycleManager.handleTransportError(session, error);
        }

        return null;
      },
    });
    state.progress = progress;
    const initialProgress =
      typeof initialProgressText === "string" && initialProgressText.trim()
        ? initialProgressText
        : buildProgressText(state, getSessionUiLanguage(session));
    try {
      await progress.sendInitial(initialProgress);
    } catch (error) {
      if (error?.deliveryHandled || !isTransientTransportError(error)) {
        throw error;
      }

      // Progress bubble is optional for transient Telegram hiccups like 429.
    }
    const exchangePrompt = buildPromptWithAttachments(
      rawPrompt,
      attachments,
      getSessionUiLanguage(session),
    );

    if (pool.shuttingDown) {
      releaseStartReservation();
      settleStartingRun();
      await progress.dismiss().catch(() => false);
      await pool.sessionStore.patch(session, {
        last_user_prompt: exchangePrompt,
        last_run_status: "interrupted",
        agent_run_owner_generation_id: null,
        last_progress_message_id: null,
      });
      return {
        ok: false,
        reason: "shutting-down",
      };
    }

    run = {
      sessionKey,
      session,
      executionHost: hostExecution,
      child: null,
      controller: null,
      lifecyclePromise: new Promise((resolve) => {
        resolveLifecycleGate = resolve;
      }),
      exchangePrompt,
      rawPrompt,
      attachments,
      includeTopicContext,
      goalStart,
      state,
      startedAt: new Date().toISOString(),
      progressMessageId: progress.messageId,
      progressTimer: null,
      runtimeProfileInputs: {},
    };
    run.progressTimer = pool.startProgressLoop(run);
    void pool.sendTypingAction(run);
    pool.activeRuns.set(sessionKey, run);
    releaseStartReservation();
    settleStartingRun();
    setActiveRunCount(pool.serviceState, pool.activeRuns.size);
    await pool.sessionStore.patch(session, {
      codex_backend: state.backend,
      last_user_prompt: exchangePrompt,
      last_run_status: "running",
      last_run_backend: state.backend,
      agent_run_owner_generation_id: pool.serviceGenerationId,
      last_run_started_at: run.startedAt,
      last_run_finished_at: null,
      last_progress_message_id: stringifyMessageId(progress.messageId),
    });
    await noteRunEventBestEffort(pool, "run.started", {
      ...buildRunEventSessionFields(session),
      started_at: run.startedAt,
      reply_to_message_id: state.replyToMessageId,
      include_topic_context: includeTopicContext,
      attachment_count: Array.isArray(attachments) ? attachments.length : 0,
      stored_thread_id: session.codex_thread_id ?? null,
      resume_mode: state.resumeMode,
    });

    const lifecyclePromise = attachRunLifecycle(pool, run, {
      prompt,
      attachments,
      includeTopicContext,
      goalStart,
      originalSession: session,
    });
    lifecycleAttached = true;
    run.lifecyclePromise = lifecyclePromise;
    settleLifecycleGate(lifecyclePromise);

    return {
      ok: true,
      progressMessageId: progress.messageId,
      threadId: state.threadId,
      sessionKey,
      topicId: message?.message_thread_id ?? session.topic_id ?? null,
    };
  } catch (error) {
    settleLifecycleGate();
    if (!lifecycleAttached) {
      if (run) {
        pool.stopProgressLoop(run);
        if (pool.activeRuns.get(sessionKey) === run) {
          pool.activeRuns.delete(sessionKey);
        }
        pool.pendingLiveSteers.delete(sessionKey);
        setActiveRunCount(pool.serviceState, pool.activeRuns.size);
      }
      await state.progress?.dismiss?.().catch(() => false);
    }
    releaseStartReservation();
    settleStartingRun();
    throw error;
  }
}

export function interrupt(pool, sessionKey) {
  const run = pool.activeRuns.get(sessionKey);
  if (!run) {
    return false;
  }

  if (
    run.state.interruptRequested
    || ["completed", "failed", "interrupting", "interrupted"].includes(
      run.state.status,
    )
  ) {
    return false;
  }

  run.state.interruptRequested = true;
  run.state.status = "interrupting";
  run.state.latestSummary = "interrupt-requested";
  run.state.latestSummaryKind = "interrupt";
  run.state.progress.queueUpdate(
    buildProgressText(run.state, getSessionUiLanguage(run.session)),
  );

  const nativeInterruptRequested =
    typeof run.controller?.interrupt === "function";
  if (nativeInterruptRequested) {
    const nativeInterruptResult = Promise.resolve(run.controller.interrupt({
      threadId: run.state.threadId || undefined,
      turnId: run.state.activeTurnId || undefined,
    })).catch(() => false);
    void nativeInterruptResult.then((requested) => {
      if (
        requested !== false
        || pool.activeRuns.get(sessionKey) !== run
        || !run.child
        || run.state.interruptSignalSent
      ) {
        return;
      }

      run.state.interruptSignalSent = true;
      signalChildProcessGroup(run.child, "SIGINT");
      setTimeout(() => {
        if (pool.activeRuns.get(sessionKey) === run && run.child) {
          signalChildProcessGroup(run.child, "SIGKILL");
        }
      }, 5000).unref();
    });
  }

  if (run.child) {
    const scheduleHardKill = () => {
      setTimeout(() => {
        if (pool.activeRuns.get(sessionKey) === run && run.child) {
          signalChildProcessGroup(run.child, "SIGKILL");
        }
      }, 5000).unref();
    };
    const sendSigint = () => {
      if (
        pool.activeRuns.get(sessionKey) !== run
        || !run.child
        || run.state.interruptSignalSent
      ) {
        return;
      }

      run.state.interruptSignalSent = true;
      signalChildProcessGroup(run.child, "SIGINT");
      scheduleHardKill();
    };

    if (nativeInterruptRequested) {
      setTimeout(() => {
        sendSigint();
      }, 5000).unref();
    } else {
      sendSigint();
    }
  }
  return true;
}

async function waitForShutdownDrain(pool, timeoutMs = null) {
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const deadline = hasDeadline ? Date.now() + timeoutMs : null;

  while (true) {
    if (pool.activeRuns.size === 0 && pool.startingRuns.size === 0) {
      return true;
    }

    if (deadline !== null && Date.now() >= deadline) {
      return false;
    }

    const nextWaitMs = deadline === null
      ? SHUTDOWN_DRAIN_POLL_MS
      : Math.max(1, Math.min(SHUTDOWN_DRAIN_POLL_MS, deadline - Date.now()));
    const waitPromises = [
      ...pool.startingRunPromises.values(),
      ...[...pool.activeRuns.values()]
        .map((run) => run.lifecyclePromise)
        .filter(Boolean),
    ];
    if (waitPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(waitPromises),
        sleep(nextWaitMs),
      ]);
    } else {
      await sleep(nextWaitMs);
    }
  }
}

export async function shutdown(
  pool,
  { drainTimeoutMs = 0, interruptActiveRuns = true } = {},
) {
  pool.shuttingDown = true;

  if (drainTimeoutMs > 0) {
    const drained = await waitForShutdownDrain(pool, drainTimeoutMs);
    if (drained || !interruptActiveRuns) {
      return;
    }
  } else if (!interruptActiveRuns) {
    await waitForShutdownDrain(pool, null);
    return;
  }

  for (const [sessionKey] of pool.activeRuns.entries()) {
    pool.interrupt(sessionKey);
  }

  const settleWindowMs = drainTimeoutMs > 0
    ? drainTimeoutMs
    : null;
  await waitForShutdownDrain(pool, settleWindowMs);
}

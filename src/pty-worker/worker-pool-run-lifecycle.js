import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { setActiveRunCount } from "../runtime/service-state.js";
import {
  buildExchangeLogEntry,
  buildFailureText,
  buildInterruptedText,
  buildRunFailureText,
  stringifyMessageId,
} from "./worker-pool-common.js";
import { buildFinalCompletedReplyText } from "./worker-pool-delivery.js";
import {
  buildClearContinuitySessionPatch,
  shouldClearProviderRuntimeContinuity,
  shouldClearRolloutPathContinuity,
} from "./worker-pool-continuity.js";
import {
  buildRunEventSessionFields,
  computeRunDurationMs,
  maybeSuppressSupersededRunCompletion,
  noteRunEventBestEffort,
} from "./worker-pool-lifecycle-common.js";
import { computeNonCachedInputOutputTokenTotal } from "../codex-runtime/token-usage.js";

async function clearProgressNotesAfterTerminalExchange(pool, run) {
  if (typeof pool.sessionStore?.clearProgressNoteEntries !== "function") {
    return;
  }

  try {
    await pool.sessionStore.clearProgressNoteEntries(run.session);
  } catch (error) {
    console.warn("Failed to clear terminal progress notes", error);
  }
}

function isGoalCompletionSummary(text) {
  const normalized = String(text || "").trim();
  return /^Goal (?:complete|achieved)\b[\s\S]*\bTime used:/iu.test(normalized)
    || /^Goal complete\./iu.test(normalized);
}

function isGoalComplete(goal) {
  const status = String(goal?.status || "").trim().toLowerCase();
  return status === "complete" || status === "completed";
}

function preferGoalProgressFinalReply(
  run,
  state,
  { allowCompletedGoalFallback = false } = {},
) {
  const finalMessage = String(state.finalAgentMessage || "").trim();
  const shouldUseProgress =
    isGoalCompletionSummary(finalMessage)
    || (
      allowCompletedGoalFallback
      && !finalMessage
      && isGoalComplete(state.currentGoal)
    );
  if (!run.goalStart || !shouldUseProgress) {
    return;
  }

  const progressMessage = String(state.latestProgressMessage || "").trim();
  if (!progressMessage || progressMessage === finalMessage) {
    return;
  }

  state.finalAgentMessage = progressMessage;
  state.finalAgentMessageSource = progressMessage;
}

function stripTrailingGoalCompletionSummary(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return normalized;
  }

  const paragraphs = normalized.split(/\n{2,}/u);
  if (paragraphs.length <= 1) {
    return normalized;
  }

  const lastParagraph = paragraphs[paragraphs.length - 1].trim();
  if (!isGoalCompletionSummary(lastParagraph)) {
    return normalized;
  }

  return paragraphs.slice(0, -1).join("\n\n").trim();
}

function isGoalRunFooter(text) {
  const normalized = String(text || "").trim();
  return /^Goal run:\s*completed(?:\s|$)/iu.test(normalized)
    && /(?:^|\n)(?:Time|Tokens):/iu.test(normalized);
}

function stripTrailingGoalRunFooter(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return normalized;
  }

  const paragraphs = normalized.split(/\n{2,}/u);
  const lastParagraph = paragraphs[paragraphs.length - 1].trim();
  if (!isGoalRunFooter(lastParagraph)) {
    return normalized;
  }

  return paragraphs.slice(0, -1).join("\n\n").trim();
}

function formatGoalRunDuration(startedAt, finishedAt) {
  const durationMs = computeRunDurationMs(startedAt, finishedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  return `${Math.max(0, Math.round(durationMs / 1000))}s`;
}

function formatGoalDurationSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return `${Math.max(0, Math.round(seconds))}s`;
}

function goalTokenUsage(goal) {
  const tokensUsed = goal?.tokens_used ?? goal?.tokensUsed;
  if (!Number.isFinite(tokensUsed) || tokensUsed < 0) {
    return null;
  }
  return {
    total_tokens: Math.trunc(tokensUsed),
  };
}

function hasTokenUsageBreakdown(usage) {
  return [
    usage?.input_tokens,
    usage?.cached_input_tokens,
    usage?.output_tokens,
    usage?.reasoning_tokens,
  ].some((value) => Number.isFinite(value));
}

function goalRunTokenUsageFromRunUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const blendedTotal = computeNonCachedInputOutputTokenTotal(usage);
  const rawTotal = Number.isFinite(usage.total_tokens)
    ? Math.trunc(usage.total_tokens)
    : null;
  const totalTokens = blendedTotal ?? rawTotal;
  if (!Number.isFinite(totalTokens)) {
    return null;
  }

  return {
    displayed: {
      total_tokens: totalTokens,
    },
    raw: hasTokenUsageBreakdown(usage) ? usage : null,
  };
}

function selectGoalFooterDuration({ run, state, finishedAt }) {
  // The footer describes the Teledex-managed /goal run. Native goal accounting
  // can restart after continuation/recovery boundaries, so it is fallback only.
  return formatGoalRunDuration(run.startedAt, finishedAt)
    ?? formatGoalDurationSeconds(state.currentGoal?.time_used_seconds);
}

function selectGoalFooterTokenUsage(state) {
  return goalRunTokenUsageFromRunUsage(state.currentRunTokenUsage)
    ?? {
      displayed: goalTokenUsage(state.currentGoal),
      raw: null,
    };
}

function formatTokenUsageLine(prefix, usage) {
  if (!usage || typeof usage !== "object") {
    return `${prefix}: unavailable`;
  }

  const fields = [
    ["total", usage.total_tokens],
    ["input", usage.input_tokens],
    ["cached", usage.cached_input_tokens],
    ["output", usage.output_tokens],
    ["reasoning", usage.reasoning_tokens],
  ].filter(([, value]) => Number.isFinite(value));
  if (fields.length === 0) {
    return `${prefix}: unavailable`;
  }

  const body = fields
    .map(([label, value]) => `${label}=${value}`)
    .join(", ");
  return `${prefix}: ${body}`;
}

function formatGoalRunTokenUsage(usage, _language) {
  const lines = [
    formatTokenUsageLine(
      "Tokens",
      usage?.displayed ?? null,
    ),
  ];
  if (usage?.raw) {
    lines.push(formatTokenUsageLine(
      "Tokens (raw)",
      usage.raw,
    ));
  }
  return lines.join("\n");
}

function appendGoalRunFooter({
  text,
  run,
  state,
  finishedAt,
  language,
}) {
  if (!run.goalStart) {
    return text;
  }

  const normalized = stripTrailingGoalRunFooter(
    stripTrailingGoalCompletionSummary(text),
  );

  const duration = selectGoalFooterDuration({ run, state, finishedAt });
  const usage = selectGoalFooterTokenUsage(state);
  const lines = [
    "Goal run: completed",
    duration
      ? `Time: ${duration}`
      : null,
    formatGoalRunTokenUsage(usage, language),
  ].filter(Boolean);

  const footer = lines.join("\n");
  return normalized ? `${normalized}\n\n${footer}` : footer;
}

export function attachRunLifecycle(
  pool,
  run,
  {
    prompt,
    attachments = [],
    includeTopicContext = true,
    goalStart = run.goalStart ?? null,
    originalSession = run.session,
  } = {},
) {
  const { state } = run;
  const progress = state.progress;
  let resultPersisted = false;
  let agentFinalEventEmitted = false;
  let finalReplyDeliveredViaProgress = false;

  return pool.executeRunLifecycle(run, {
    prompt,
    attachments,
    includeTopicContext,
    goalStart,
  })
    .then(async (result) => {
      state.finalizing = true;
      state.threadId = result.threadId || state.threadId;
      state.warnings.push(...result.warnings);
      const successfulRun =
        result?.ok === true
        || (
          result?.ok !== false
          && (
            result.exitCode === 0
            || (
              result?.backend !== "exec-json"
              && result?.attemptInsight?.sawFinalAnswer === true
            )
          )
        );
      if (successfulRun) {
        preferGoalProgressFinalReply(run, state, {
          allowCompletedGoalFallback: true,
        });
      }
      const completedWithReply =
        (
          (
            typeof state.finalAgentMessage === "string"
            && state.finalAgentMessage.trim()
          )
          || state.replyDocuments.length > 0
          || state.replyDocumentWarnings.length > 0
        )
        && successfulRun;
      const interruptedResult =
        state.interruptRequested
        || (
          result?.preserveContinuity === true
          && result?.abortReason === "resume_unavailable"
        )
        || result?.interrupted === true
        || result?.signal === "SIGINT";
      const resumePendingResult =
        result?.preserveContinuity === true
        && result?.abortReason === "resume_unavailable";
      state.status = completedWithReply
        ? "completed"
        : interruptedResult
          ? "interrupted"
          : "failed";
      if (state.status === "completed") {
        preferGoalProgressFinalReply(run, state);
      }
      const finishedAt = new Date().toISOString();
      if (await maybeSuppressSupersededRunCompletion(pool, run, {
        state,
        result,
        progress,
        finishedAt,
      })) {
        return;
      }
      let documentDelivery = {
        successes: [],
        failures: [],
        parked: false,
        session: run.session,
      };

      if (state.status === "completed") {
        documentDelivery = await pool.deliverRunDocuments(
          run.session,
          state.replyDocuments,
        );
        run.session = documentDelivery.session || run.session;
        state.finalAgentMessage = buildFinalCompletedReplyText({
          baseText: state.finalAgentMessage,
          successes: documentDelivery.successes,
          failures: documentDelivery.failures,
          warnings: state.replyDocumentWarnings,
          language: getSessionUiLanguage(run.session),
        });
        state.finalAgentMessageSource = buildFinalCompletedReplyText({
          baseText: state.finalAgentMessageSource ?? state.finalAgentMessage,
          successes: documentDelivery.successes,
          failures: documentDelivery.failures,
          warnings: state.replyDocumentWarnings,
          language: getSessionUiLanguage(run.session),
        });
        state.finalAgentMessage = appendGoalRunFooter({
          text: state.finalAgentMessage,
          run,
          state,
          finishedAt,
          language: getSessionUiLanguage(run.session),
        });
        state.finalAgentMessageSource = appendGoalRunFooter({
          text: state.finalAgentMessageSource,
          run,
          state,
          finishedAt,
          language: getSessionUiLanguage(run.session),
        });
      }

      const finalReplyText =
        state.status === "completed"
          ? state.finalAgentMessage
          : state.status === "interrupted" && !resumePendingResult
            ? buildInterruptedText(getSessionUiLanguage(run.session), {
              requestedByUser: state.interruptRequested,
              interruptReason: result?.interruptReason || null,
            })
            : buildRunFailureText(result, getSessionUiLanguage(run.session));
      const finalReplyDeliveryText =
        state.status === "completed"
          ? state.finalAgentMessageSource || finalReplyText
          : finalReplyText;
      state.finalAgentMessage = finalReplyText;
      state.finalAgentMessageSource = finalReplyDeliveryText;
      const resultBackend = state.backend ?? result?.backend ?? null;
      const clearProviderRuntimeContinuity =
        shouldClearProviderRuntimeContinuity(resultBackend);
      const clearRolloutPathContinuity =
        shouldClearRolloutPathContinuity(resultBackend);
      const clearStoredThreadState =
        state.status === "failed" && result?.preserveContinuity !== true;
      const persistedThreadId = clearStoredThreadState
        ? null
        : state.threadId || run.session.codex_thread_id || null;
      const persistedProviderSessionId =
        clearStoredThreadState || clearProviderRuntimeContinuity
        ? null
        : state.providerSessionId
          || run.session.provider_session_id
          || state.contextSnapshot?.session_id
          || null;
      const persistedRolloutPath =
        clearStoredThreadState || clearRolloutPathContinuity
        ? null
        : state.rolloutPath
          || state.contextSnapshot?.rollout_path
          || run.session.codex_rollout_path
          || null;
      const persistedContextSnapshot =
        clearStoredThreadState || clearProviderRuntimeContinuity
        ? null
        : state.contextSnapshot
          || run.session.last_context_snapshot
          || null;
      const persistedContextSnapshotRolloutPath =
        persistedThreadId && persistedThreadId === run.session.codex_thread_id
          ? run.session.context_snapshot_rollout_path ?? null
          : null;

      run.session = await pool.sessionStore.patch(run.session, {
        ...(persistedProviderSessionId
          ? {
            provider_session_id: persistedProviderSessionId,
          }
          : clearStoredThreadState || clearProviderRuntimeContinuity
            ? { provider_session_id: null }
            : {}),
        codex_backend: resultBackend,
        codex_thread_id: persistedThreadId,
        codex_thread_model: persistedThreadId ? state.model ?? null : null,
        codex_thread_reasoning_effort:
          persistedThreadId ? state.reasoningEffort ?? null : null,
        codex_rollout_path: persistedRolloutPath,
        ...(resultBackend === "deepseek-http"
          ? {
            deepseek_active_turn_id: null,
            deepseek_active_turn_status: null,
            deepseek_last_turn_id:
              state.activeTurnId
              || run.session.deepseek_active_turn_id
              || run.session.deepseek_last_turn_id
              || null,
          }
          : {}),
        last_context_snapshot: persistedContextSnapshot,
        context_snapshot_rollout_path: persistedContextSnapshotRolloutPath,
        last_user_prompt: run.exchangePrompt,
        last_agent_reply: finalReplyText,
        last_run_status: state.status,
        last_run_backend: resultBackend,
        agent_run_owner_generation_id: null,
        last_run_started_at: run.startedAt,
        last_run_finished_at: finishedAt,
        last_run_model: state.model ?? null,
        last_run_reasoning_effort: state.reasoningEffort ?? null,
        last_token_usage: state.lastTokenUsage,
        last_progress_message_id: stringifyMessageId(progress.messageId),
      });
      await noteRunEventBestEffort(pool, "run.finished", {
        ...buildRunEventSessionFields(run.session),
        status: state.status,
        started_at: run.startedAt,
        finished_at: finishedAt,
        duration_ms: computeRunDurationMs(run.startedAt, finishedAt),
        exit_code: result?.exitCode ?? null,
        signal: result?.signal ?? null,
        interrupted: interruptedResult,
        interrupt_reason: result?.interruptReason || null,
        abort_reason: result?.abortReason || null,
        thread_id: state.threadId || null,
        resume_mode: state.resumeMode,
        backend: state.backend ?? result?.backend ?? null,
        warnings_count: state.warnings.length,
        reply_documents_count: state.replyDocuments.length,
        token_usage: state.currentRunTokenUsage ?? null,
      });
      const exchangeLogResult = await pool.sessionStore.appendExchangeLogEntry(
        run.session,
        buildExchangeLogEntry({
          prompt: run.exchangePrompt,
          state,
          finishedAt,
        }),
      );
      run.session = exchangeLogResult.session;
      await clearProgressNotesAfterTerminalExchange(pool, run);
      resultPersisted = true;
      pool.stopProgressLoop(run);
      await pool.finalizeProgress(run);
      let replyDelivery = {
        delivered: false,
        messageIds: [],
      };
      if (!documentDelivery.parked) {
        replyDelivery = await pool.deliverRunReply(run.session, finalReplyDeliveryText, {
          replyToMessageId: state.replyToMessageId,
          progress,
        });
      }
      run.session = replyDelivery.session || run.session;
      finalReplyDeliveredViaProgress = replyDelivery.fallback === "progress";
      await pool.emitAgentFinalEvent(run, {
        finishedAt,
        deliveryResult: replyDelivery,
      });
      agentFinalEventEmitted = true;
      if (replyDelivery.fallback !== "progress") {
        await progress.dismiss();
      }
    })
    .catch(async (error) => {
      state.finalizing = true;
      pool.stopProgressLoop(run);
      if (resultPersisted) {
        if (!agentFinalEventEmitted) {
          await pool.emitAgentFinalEvent(run, {
            finishedAt:
              run.session?.last_run_finished_at || new Date().toISOString(),
            deliveryResult: {
              delivered: false,
              messageIds: Array.isArray(error?.partialTelegramMessageIds)
                ? error.partialTelegramMessageIds
                : [],
            },
          }).catch(() => null);
        }
        if (!finalReplyDeliveredViaProgress) {
          await progress.dismiss().catch(() => false);
        }
        throw error;
      }

      state.status = "failed";
      const finishedAt = new Date().toISOString();
      const failureText = buildFailureText(
        error,
        getSessionUiLanguage(run.session),
      );
      state.finalAgentMessage = failureText;
      state.finalAgentMessageSource = failureText;
      if (await maybeSuppressSupersededRunCompletion(pool, run, {
        state,
        result: null,
        progress,
        finishedAt,
      })) {
        return;
      }
      const resultBackend = state.backend ?? null;
      const clearLegacyRuntimeContinuity =
        shouldClearProviderRuntimeContinuity(resultBackend);
      run.session = await pool.sessionStore.patch(originalSession, {
        ...(clearLegacyRuntimeContinuity
          ? buildClearContinuitySessionPatch()
          : {}),
        codex_backend: resultBackend,
        ...(resultBackend === "deepseek-http"
          ? {
            deepseek_active_turn_id: null,
            deepseek_active_turn_status: null,
            deepseek_last_turn_id:
              state.activeTurnId
              || originalSession.deepseek_active_turn_id
              || originalSession.deepseek_last_turn_id
              || null,
          }
          : {}),
        last_user_prompt: run.exchangePrompt,
        last_agent_reply: failureText,
        last_run_status: "failed",
        last_run_backend: resultBackend,
        agent_run_owner_generation_id: null,
        last_run_started_at: run.startedAt,
        last_run_finished_at: finishedAt,
        last_run_model: state.model ?? null,
        last_run_reasoning_effort: state.reasoningEffort ?? null,
        last_token_usage: state.lastTokenUsage,
      });
      const exchangeLogResult = await pool.sessionStore.appendExchangeLogEntry(
        run.session,
        buildExchangeLogEntry({
          prompt: run.exchangePrompt,
          state,
          finishedAt,
        }),
      );
      run.session = exchangeLogResult.session;
      await clearProgressNotesAfterTerminalExchange(pool, run);
      await pool.finalizeProgress(run);
      const replyDelivery = await pool.deliverRunReply(
        run.session,
        failureText,
        {
          replyToMessageId: state.replyToMessageId,
          progress,
        },
      );
      run.session = replyDelivery.session || run.session;
      await pool.emitAgentFinalEvent(run, {
        finishedAt,
        deliveryResult: replyDelivery,
      });
      agentFinalEventEmitted = true;
      if (replyDelivery.fallback !== "progress") {
        await progress.dismiss();
      }
    })
    .finally(async () => {
      pool.stopProgressLoop(run);
      if (pool.activeRuns.get(run.sessionKey) === run) {
        pool.activeRuns.delete(run.sessionKey);
      }
      if (pool.pendingLiveSteers.has(run.sessionKey)) {
        try {
          const requeued = await pool.requeuePendingLiveSteer(run.sessionKey, run);
          if (!requeued) {
            run.state.warnings.push(
              "pending live steer remained buffered after run cleanup; durable queue is unavailable",
            );
          }
        } catch (error) {
          run.state.warnings.push(
            `pending live steer remained buffered after failed requeue: ${error.message}`,
          );
        }
      }
      setActiveRunCount(pool.serviceState, pool.activeRuns.size);
      if (typeof pool.onRunTerminated === "function") {
        try {
          await pool.onRunTerminated({
            session: run.session,
            status: state.status,
            run,
          });
        } catch (error) {
          console.error(
            `run termination hook failed for ${run.sessionKey}: ${error.message}`,
          );
        }
      }
    })
    .catch((error) => {
      console.error(`run lifecycle failed for ${run.sessionKey}: ${error.message}`);
    });
}

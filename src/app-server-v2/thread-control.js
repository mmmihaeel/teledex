import {
  findInProgressTurn,
  findLatestTurn,
  normalizeOptionalText,
  sleep,
} from "../pty-worker/codex-runner-thread-history.js";
import {
  normalizeTurnStatus,
  publishRuntimeState,
  updateThreadStateFromResponse,
} from "./thread-state.js";

function isRetryableThreadResumeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("failed to resolve rollout path");
}

export async function requestThreadResume(context, params) {
  const { state } = context;
  for (let attempt = 0; attempt <= context.threadResumeRetryDelaysMs.length; attempt += 1) {
    try {
      return await state.rpc.request("thread/resume", params, {
        timeoutMs: context.appServerControlTimeoutMs,
      });
    } catch (error) {
      if (
        !isRetryableThreadResumeError(error)
        || attempt >= context.threadResumeRetryDelaysMs.length
      ) {
        throw error;
      }
      await sleep(context.threadResumeRetryDelaysMs[attempt]);
    }
  }
  return null;
}

export async function refreshActiveTurnFromThreadResume(context) {
  const { state } = context;
  if (!state.rpc || !state.latestThreadId) {
    return null;
  }

  try {
    const resumed = await requestThreadResume(context, {
      ...context.threadParams,
      threadId: state.latestThreadId,
      ...(context.knownRolloutPath ? { path: context.knownRolloutPath } : {}),
    });
    updateThreadStateFromResponse(state, resumed?.thread);
    state.primaryThreadId = state.primaryThreadId || state.latestThreadId;
    const resumedOpenTurn = findInProgressTurn(resumed?.thread);
    const resumedLatestTurn = findLatestTurn(resumed?.thread);
    state.activeTurnId =
      normalizeOptionalText(resumedOpenTurn?.id)
      || (
        normalizeTurnStatus(resumedLatestTurn?.status) === "inprogress"
          ? normalizeOptionalText(resumedLatestTurn?.id)
          : null
      )
      || null;
    await publishRuntimeState(state, context.onRuntimeState, {
      threadId: state.latestThreadId,
      activeTurnId: state.activeTurnId,
      rolloutPath: state.latestRolloutPath,
    });
    return state.activeTurnId;
  } catch {
    return null;
  }
}

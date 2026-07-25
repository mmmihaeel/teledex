import { GOAL_REQUEST_TIMEOUT_MS } from "./runner-constants.js";

function buildGoalSetParams(threadId, goalStart) {
  return {
    threadId,
    ...(goalStart?.objective !== null && goalStart?.objective !== undefined
      ? { objective: goalStart.objective }
      : {}),
    ...(goalStart?.status !== null && goalStart?.status !== undefined
      ? { status: goalStart.status }
      : {}),
    ...(goalStart?.tokenBudget !== undefined
      ? { tokenBudget: goalStart.tokenBudget }
      : {}),
  };
}

export function clearPendingGoalContinuationStartTimer(state) {
  if (!state.pendingGoalContinuationStartTimer) {
    return;
  }
  clearTimeout(state.pendingGoalContinuationStartTimer);
  state.pendingGoalContinuationStartTimer = null;
}

function scheduleGoalContinuationStartTimeout(context) {
  const { state } = context;
  if (!context.goalStart || state.activeTurnId || state.pendingGoalContinuationStartTimer) {
    return;
  }

  state.pendingGoalContinuationStartTimer = setTimeout(() => {
    state.pendingGoalContinuationStartTimer = null;
    if (state.settled || state.shuttingDown || state.activeTurnId) {
      return;
    }
    context.finishRun({
      ok: false,
      exitCode: null,
      signal: null,
      interrupted: false,
      interruptReason: null,
      abortReason: "goal_continuation_not_started",
      warnings: [
        ...state.warnings,
        "app-server-v2 did not start goal continuation after thread/goal/set",
      ],
    });
  }, context.goalContinuationStartTimeoutMs);
}

export async function setGoalAndWaitForContinuation(context) {
  const { state } = context;
  if (!state.latestThreadId) {
    throw new Error("app-server-v2 goal runs require an existing materialized thread");
  }

  state.terminalTurnObserved = false;
  state.sawPrimaryFinalAnswer = false;
  scheduleGoalContinuationStartTimeout(context);
  try {
    await state.rpc.request("thread/goal/set", buildGoalSetParams(
      state.latestThreadId,
      context.goalStart,
    ), {
      timeoutMs: GOAL_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    clearPendingGoalContinuationStartTimer(state);
    throw error;
  }
}

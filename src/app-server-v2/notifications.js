import { summarizeCodexEvent } from "../pty-worker/codex-runner-common.js";
import { normalizeOptionalText } from "../pty-worker/codex-runner-thread-history.js";
import {
  clearPendingGoalContinuationStartTimer,
  setGoalAndWaitForContinuation,
} from "./goal-continuation.js";
import { schedulePendingSteerFlush } from "./steering.js";
import {
  isCompletedTurnStatus,
  isFailedTurnStatus,
  isInterruptedTurnStatus,
  isPrimaryThreadEvent,
  normalizeTurnStatus,
  updateThreadStateFromResponse,
} from "./thread-state.js";

function scheduleCompletedTurnFinish(context) {
  const waitForPossibleGoalContinuation = Boolean(context.goalStart);
  if (context.state.sawPrimaryFinalAnswer && !waitForPossibleGoalContinuation) {
    context.finishRun({
      ok: true,
      exitCode: 0,
      signal: null,
      interrupted: false,
      interruptReason: null,
      abortReason: null,
    });
    return;
  }

  if (context.state.pendingTurnCompletionTimer) {
    return;
  }

  context.state.pendingTurnCompletionTimer = setTimeout(() => {
    context.state.pendingTurnCompletionTimer = null;
    context.finishRun({
      ok: true,
      exitCode: 0,
      signal: null,
      interrupted: false,
      interruptReason: null,
      abortReason: null,
    });
  }, context.turnCompletionFinalMessageGraceMs);
}

export function markTerminalTurnObserved(context, event) {
  if (event?.method !== "turn/completed") {
    return;
  }

  const { state } = context;
  const eventThreadId = event?.params?.threadId || null;
  if (!isPrimaryThreadEvent(state, eventThreadId)) {
    return;
  }

  state.terminalTurnObserved = true;
  state.activeTurnId = null;
}

export async function handleNotification(context, event) {
  const { state } = context;
  const summary = summarizeCodexEvent(event);
  const eventThreadId = summary?.threadId || event?.params?.threadId || null;
  const primaryEvent = isPrimaryThreadEvent(state, eventThreadId);

  if (summary) {
    summary.isPrimaryThreadEvent = primaryEvent;
  }

  if (summary?.threadId && primaryEvent) {
    state.latestThreadId = summary.threadId;
  }
  if (primaryEvent && event?.params?.thread) {
    updateThreadStateFromResponse(state, event.params.thread);
  }
  if (summary?.eventType === "turn.started" && summary.turnId && primaryEvent) {
    if (state.pendingTurnCompletionTimer) {
      clearTimeout(state.pendingTurnCompletionTimer);
      state.pendingTurnCompletionTimer = null;
    }
    clearPendingGoalContinuationStartTimer(state);
    state.sawPrimaryFinalAnswer = false;
    state.terminalTurnObserved = false;
    state.activeTurnId = summary.turnId;
    schedulePendingSteerFlush(context);
  }
  if (
    summary?.kind === "agent_message"
    && summary?.messagePhase === "final_answer"
    && primaryEvent
  ) {
    state.sawPrimaryFinalAnswer = true;
  }

  if (summary && primaryEvent) {
    try {
      await context.mirrorEvent?.(event);
    } catch (error) {
      context.onWarning?.(`app-server-v2 event mirror failed: ${error?.message || error}`);
    }
  }

  if (summary) {
    try {
      await context.onEvent?.(summary, event);
    } catch (error) {
      context.onWarning?.(`app-server-v2 event handler failed: ${error?.message || error}`);
    }
  }

  if (event.method === "error" && primaryEvent) {
    if (event.params?.willRetry === true) {
      state.warnings.push(event.params?.error?.message || "Codex app-server-v2 retrying after error");
      return;
    }

    const errorMessage = normalizeOptionalText(event.params?.error?.message);
    if (errorMessage) {
      state.warnings.push(errorMessage);
    }
    context.finishRun({
      ok: false,
      exitCode: 1,
      signal: null,
      interrupted: false,
      interruptReason: null,
      abortReason: "error_notification",
    });
    return;
  }

  if (event.method !== "turn/completed" || !primaryEvent) {
    return;
  }

  state.terminalTurnObserved = true;
  state.activeTurnId = null;
  const turnStatus = normalizeTurnStatus(summary?.turnStatus || event.params?.turn?.status);
  if (isFailedTurnStatus(turnStatus)) {
    const failureMessage =
      normalizeOptionalText(summary?.turnError?.message)
      || normalizeOptionalText(event.params?.turn?.error?.message)
      || "Codex app-server-v2 turn failed";
    state.warnings.push(failureMessage);
    context.finishRun({
      ok: false,
      exitCode: 1,
      signal: null,
      interrupted: false,
      interruptReason: null,
      abortReason: "turn_failed",
    });
    return;
  }

  if (isInterruptedTurnStatus(turnStatus)) {
    context.finishRun({
      ok: false,
      exitCode: null,
      signal: "SIGINT",
      interrupted: true,
      interruptReason: state.interruptRequested ? "user" : "upstream",
      abortReason: "interrupted",
    });
    return;
  }

  if (isCompletedTurnStatus(turnStatus)) {
    if (state.goalSetAfterMaterialization) {
      state.goalSetAfterMaterialization = false;
      await setGoalAndWaitForContinuation(context);
      return;
    }
    scheduleCompletedTurnFinish(context);
  }
}

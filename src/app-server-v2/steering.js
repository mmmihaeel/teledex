import {
  isNoActiveTurnSteerError,
  sleep,
} from "../pty-worker/codex-runner-thread-history.js";
import { refreshActiveTurnFromThreadResume } from "./thread-control.js";

export function isFinalizingTurnState(state) {
  return Boolean(
    state.settled
    || state.shuttingDown
    || state.pendingTurnCompletionTimer
    || (
      state.terminalTurnObserved
      && !state.activeTurnId
    ),
  );
}

async function flushPendingSteers(context) {
  const { state } = context;
  if (
    !state.rpc
    || !state.latestThreadId
    || !state.activeTurnId
    || state.pendingSteerInputs.length === 0
  ) {
    return {
      ok: true,
      reason: "steer-buffered",
      inputCount: state.pendingSteerInputs.length,
    };
  }

  const input = state.pendingSteerInputs.splice(0, state.pendingSteerInputs.length);
  let lastNoActiveTurnError = null;

  for (
    let attempt = 0;
    attempt <= context.steerActiveTurnRefreshRetryDelaysMs.length;
    attempt += 1
  ) {
    const expectedTurnId = state.activeTurnId;
    if (!state.rpc || !state.latestThreadId || !expectedTurnId) {
      if (attempt >= context.steerActiveTurnRefreshRetryDelaysMs.length) {
        break;
      }
      await sleep(context.steerActiveTurnRefreshRetryDelaysMs[attempt]);
      await refreshActiveTurnFromThreadResume(context);
      continue;
    }

    try {
      const steerResponse = await state.rpc.request("turn/steer", {
        threadId: state.latestThreadId,
        expectedTurnId,
        input,
      }, {
        timeoutMs: context.steerRequestTimeoutMs,
      });
      state.activeTurnId =
        steerResponse?.turn?.id
        || steerResponse?.turnId
        || expectedTurnId;

      return {
        ok: true,
        reason: "steered",
        inputCount: input.length,
        turnId: state.activeTurnId,
        threadId: state.latestThreadId,
      };
    } catch (error) {
      if (!isNoActiveTurnSteerError(error)) {
        state.pendingSteerInputs.unshift(...input);
        throw error;
      }

      lastNoActiveTurnError = error;
      state.activeTurnId = null;
      if (attempt >= context.steerActiveTurnRefreshRetryDelaysMs.length) {
        break;
      }
      await sleep(context.steerActiveTurnRefreshRetryDelaysMs[attempt]);
      await refreshActiveTurnFromThreadResume(context);
    }
  }

  state.pendingSteerInputs.unshift(...input);
  throw lastNoActiveTurnError || new Error("no active turn to steer");
}

export function runPendingSteerFlush(context) {
  context.state.flushChain = context.state.flushChain
    .catch(() => {})
    .then(() => flushPendingSteers(context));
  return context.state.flushChain;
}

export function schedulePendingSteerFlush(context) {
  void runPendingSteerFlush(context).catch((error) => {
    const message = `pending app-server-v2 steer flush failed: ${error?.message || error}`;
    context.state.warnings.push(message);
    context.onWarning?.(message);
  });
}

function isRetryableInterruptError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("no active turn")
    || message.includes("expected active turn")
  );
}

export async function requestTurnInterrupt(context, { threadId, turnId }) {
  const { state } = context;
  let targetThreadId = threadId || state.latestThreadId;
  let targetTurnId = turnId || state.activeTurnId;

  if (!state.rpc || !targetThreadId || !targetTurnId) {
    return false;
  }

  for (let attempt = 0; attempt <= context.interruptRetryDelaysMs.length; attempt += 1) {
    if (!state.rpc || isFinalizingTurnState(state)) {
      return false;
    }

    targetThreadId = threadId || state.latestThreadId || targetThreadId;
    targetTurnId = turnId || state.activeTurnId || targetTurnId;
    if (!targetThreadId || !targetTurnId) {
      return false;
    }

    try {
      await state.rpc.request("turn/interrupt", {
        threadId: targetThreadId,
        turnId: targetTurnId,
      }, {
        timeoutMs: context.appServerControlTimeoutMs,
      });
      return true;
    } catch (error) {
      if (
        !isRetryableInterruptError(error)
        || attempt >= context.interruptRetryDelaysMs.length
      ) {
        return false;
      }
      await sleep(context.interruptRetryDelaysMs[attempt]);
    }
  }

  return false;
}

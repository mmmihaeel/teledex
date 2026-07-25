import { normalizeOptionalText } from "../pty-worker/codex-runner-thread-history.js";

export function normalizeTurnStatus(status) {
  return normalizeOptionalText(status)?.toLowerCase() || null;
}

export function isCompletedTurnStatus(status) {
  return !status || status === "completed";
}

export function isInterruptedTurnStatus(status) {
  return status === "interrupted";
}

export function isFailedTurnStatus(status) {
  return status === "failed";
}

export function buildThreadParams({
  cwd,
  developerInstructions,
  baseInstructions,
  model,
  modelProvider,
  reasoningEffort,
}) {
  const normalizedDeveloperInstructions =
    normalizeOptionalText(developerInstructions)
    || normalizeOptionalText(baseInstructions);

  return {
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    persistExtendedHistory: true,
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(reasoningEffort ? { effort: reasoningEffort } : {}),
    ...(normalizedDeveloperInstructions
      ? { developerInstructions: normalizedDeveloperInstructions }
      : {}),
  };
}

export function buildTurnStartParams({
  threadId,
  input,
  cwd,
  model,
  reasoningEffort,
}) {
  return {
    threadId,
    input,
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { effort: reasoningEffort } : {}),
  };
}

export function isPrimaryThreadEvent(state, threadId) {
  if (!threadId) {
    return true;
  }

  if (!state.primaryThreadId) {
    state.primaryThreadId = threadId;
    state.latestThreadId = threadId;
    return true;
  }

  return threadId === state.primaryThreadId;
}

export function defaultServerRequestHandler({ method }) {
  const error = new Error(`Unsupported app-server server request: ${method}`);
  error.code = -32601;
  throw error;
}

export async function publishRuntimeState(state, onRuntimeState, payload = {}) {
  if (typeof onRuntimeState !== "function") {
    return;
  }

  await onRuntimeState({
    threadId: payload.threadId ?? state.latestThreadId ?? null,
    activeTurnId: payload.activeTurnId ?? state.activeTurnId ?? null,
    providerSessionId: null,
    rolloutPath: payload.rolloutPath ?? state.latestRolloutPath ?? null,
    contextSnapshot: null,
  });
}

export function updateThreadStateFromResponse(state, thread) {
  state.latestThreadId = normalizeOptionalText(thread?.id) || state.latestThreadId;
  state.latestRolloutPath = normalizeOptionalText(thread?.path) || state.latestRolloutPath;
}

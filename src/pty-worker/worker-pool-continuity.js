export function sanitizeContextSnapshotForBackend(
  contextSnapshot,
  { legacyAppServerBackend = false } = {},
) {
  if (!contextSnapshot) {
    return contextSnapshot ?? null;
  }

  if (legacyAppServerBackend) {
    return contextSnapshot;
  }

  return {
    ...contextSnapshot,
    session_id: null,
    rollout_path: null,
  };
}

export function clearRunContinuityState(
  state,
  {
    thread = true,
    provider = true,
    rollout = true,
    context = true,
  } = {},
) {
  if (!state) {
    return;
  }
  if (thread) {
    state.threadId = null;
  }
  if (provider) {
    state.providerSessionId = null;
  }
  if (rollout) {
    state.rolloutPath = null;
  }
  if (context) {
    state.contextSnapshot = null;
  }
}

export function buildClearContinuitySessionPatch({
  thread = true,
  threadRuntimeProfile = thread,
  provider = true,
  rollout = true,
  context = true,
  developerContextHash = false,
} = {}) {
  return {
    ...(provider ? { provider_session_id: null } : {}),
    ...(thread ? { codex_thread_id: null } : {}),
    ...(threadRuntimeProfile
      ? {
        codex_thread_model: null,
        codex_thread_reasoning_effort: null,
      }
      : {}),
    ...(rollout ? { codex_rollout_path: null } : {}),
    ...(context
      ? {
        context_snapshot_rollout_path: null,
        last_context_snapshot: null,
      }
      : {}),
    ...(developerContextHash
      ? { codex_thread_developer_context_hash: null }
      : {}),
  };
}

export function shouldClearProviderRuntimeContinuity(backend) {
  return backend === "exec-json" || backend === "app-server-v2";
}

export function shouldClearRolloutPathContinuity(backend) {
  return backend === "exec-json";
}

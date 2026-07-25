import process from "node:process";

const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SETTLING_ROLLOUT_STATUSES = new Set(["requested", "in_progress"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countRetainedSessions(state) {
  return Array.isArray(state?.retained_session_keys)
    ? state.retained_session_keys.length
    : 0;
}

function buildSoftRolloutResult({
  mode,
  previousGenerationId = null,
  leader,
  leaderGenerationId,
  rolloutStatus = null,
  retiringGenerationId = null,
  retainedSessionCount = null,
}) {
  return {
    mode,
    ...(previousGenerationId ? { previousGenerationId } : {}),
    leaderGenerationId,
    leaderPid: leader.lease.pid,
    ...(rolloutStatus ? { rolloutStatus } : {}),
    ...(retiringGenerationId ? { retiringGenerationId } : {}),
    ...(Number.isInteger(retainedSessionCount)
      ? { retainedSessionCount }
      : {}),
  };
}

async function isLeaderLeaseUsable(generationStore, lease) {
  if (typeof generationStore?.isLeaderLeaseVerifiablyLive === "function") {
    return generationStore.isLeaderLeaseVerifiablyLive(lease);
  }

  return generationStore?.isLeaderLeaseLive?.(lease) ?? false;
}

async function isGenerationRecordUsable(generationStore, record) {
  if (typeof generationStore?.isGenerationRecordVerifiablyLive === "function") {
    return generationStore.isGenerationRecordVerifiablyLive(record);
  }

  return generationStore?.isGenerationRecordLive?.(record) ?? false;
}

export async function loadLiveLeaderGeneration({ generationStore }) {
  const lease = await generationStore.loadLeaderLease();
  if (!await isLeaderLeaseUsable(generationStore, lease)) {
    return null;
  }

  const generation = await generationStore.loadGeneration(lease.generation_id);
  if (!generation?.ipc_endpoint || !await isGenerationRecordUsable(generationStore, generation)) {
    return null;
  }

  return { lease, generation };
}

export function signalGenerationRollout(
  generation,
  {
    processImpl = process,
    signal = "SIGUSR2",
  } = {},
) {
  const pid = generation?.lease?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Current leader pid is unavailable for rollout");
  }

  processImpl.kill(pid, signal);
}

export async function waitForLiveLeaderGeneration({
  generationStore,
  expectedGenerationId = null,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const leader = await loadLiveLeaderGeneration({ generationStore });
    if (
      leader
      && (!expectedGenerationId || leader.lease.generation_id === expectedGenerationId)
    ) {
      return leader;
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

export async function waitForRolloutTrafficShift({
  generationStore,
  rolloutCoordinationStore,
  previousGenerationId = null,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await rolloutCoordinationStore.load({ force: true });
    if (state.status === "failed") {
      throw new Error(state.last_error || "Rollout failed");
    }

    const targetGenerationId = state.target_generation_id;
    if (targetGenerationId && targetGenerationId !== previousGenerationId) {
      const leader = await waitForLiveLeaderGeneration({
        generationStore,
        expectedGenerationId: targetGenerationId,
        timeoutMs: pollIntervalMs,
        pollIntervalMs: Math.min(100, pollIntervalMs),
      });
      if (leader) {
        return {
          state,
          leader,
          targetGenerationId,
        };
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error("Timed out waiting for the replacement generation to take leader traffic");
}

export async function performServiceRollout({
  generationStore,
  rolloutCoordinationStore,
  restartService,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  loadLeaderGeneration = loadLiveLeaderGeneration,
  waitForLeaderGeneration = waitForLiveLeaderGeneration,
  signalRollout = signalGenerationRollout,
  waitForTrafficShift = waitForRolloutTrafficShift,
}) {
  const liveLeader = await loadLeaderGeneration({ generationStore });

  if (!liveLeader) {
    await rolloutCoordinationStore.clear();
    await restartService();
    const restartedLeader = await waitForLeaderGeneration({
      generationStore,
      timeoutMs,
    });
    if (!restartedLeader) {
      throw new Error("Service restart completed but no live leader generation became ready");
    }

    return {
      mode: "restart-fallback",
      leaderGenerationId: restartedLeader.lease.generation_id,
      leaderPid: restartedLeader.lease.pid,
    };
  }

  const currentGenerationId = liveLeader.lease.generation_id;
  const state = await rolloutCoordinationStore.load({ force: true });
  let rolloutMode = "soft-rollout";
  if (SETTLING_ROLLOUT_STATUSES.has(state.status)) {
    const targetGenerationId = state.target_generation_id;
    const retiringGenerationId = state.retiring_generation_id ?? null;
    const previousGenerationId =
      retiringGenerationId
      || (
        state.current_generation_id
        && state.current_generation_id !== targetGenerationId
          ? state.current_generation_id
          : null
      )
      || (
        currentGenerationId !== targetGenerationId
          ? currentGenerationId
          : null
      );

    if (targetGenerationId) {
      if (currentGenerationId === targetGenerationId) {
        if (
          state.status === "in_progress"
          && (retiringGenerationId || countRetainedSessions(state) > 0)
        ) {
          rolloutMode = "soft-rollout-chained";
        } else {
          return buildSoftRolloutResult({
            mode: "soft-rollout-existing",
            previousGenerationId,
            leader: liveLeader,
            leaderGenerationId: targetGenerationId,
            rolloutStatus: state.status,
            retiringGenerationId,
            retainedSessionCount: countRetainedSessions(state),
          });
        }
      } else {
        const shifted = await waitForTrafficShift({
          generationStore,
          rolloutCoordinationStore,
          previousGenerationId,
          timeoutMs,
        });

        return buildSoftRolloutResult({
          mode: "soft-rollout-existing",
          previousGenerationId,
          leader: shifted.leader,
          leaderGenerationId: shifted.targetGenerationId,
          rolloutStatus: shifted.state.status,
          retiringGenerationId: shifted.state.retiring_generation_id ?? retiringGenerationId,
          retainedSessionCount: countRetainedSessions(shifted.state),
        });
      }
    }

    if (rolloutMode !== "soft-rollout-chained") {
      if (state.status === "requested" && (
        !state.current_generation_id
        || state.current_generation_id === currentGenerationId
      )) {
        // A previous operator command wrote the request but died before signaling.
        rolloutMode = "soft-rollout-resumed";
      } else {
        throw new Error(
          "Cannot start a new soft rollout while the previous rollout request is still settling",
        );
      }
    }
  }

  if (rolloutMode === "soft-rollout" || rolloutMode === "soft-rollout-chained") {
    await rolloutCoordinationStore.requestRollout({
      currentGenerationId,
      requestedBy: "service-rollout",
    });
  }

  let shifted;
  try {
    signalRollout(liveLeader);

    shifted = await waitForTrafficShift({
      generationStore,
      rolloutCoordinationStore,
      previousGenerationId: currentGenerationId,
      timeoutMs,
    });
  } catch (error) {
    await rolloutCoordinationStore.failRollout(
      error?.message || "Soft rollout failed",
      {
        currentGenerationId,
        targetGenerationId: null,
      },
    );
    throw error;
  }

  return buildSoftRolloutResult({
    mode: rolloutMode,
    previousGenerationId: currentGenerationId,
    leader: shifted.leader,
    leaderGenerationId: shifted.targetGenerationId,
    rolloutStatus: shifted.state.status,
    retiringGenerationId: shifted.state.retiring_generation_id ?? null,
    retainedSessionCount: countRetainedSessions(shifted.state),
  });
}

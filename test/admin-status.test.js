import test from "node:test";
import assert from "node:assert/strict";

import {
  collectLiveRetainedRolloutState,
  resolveCodexBinPathForStatus,
  summarizeHeartbeat,
  summarizeRolloutState,
} from "../src/cli/admin.js";

test("summarizeHeartbeat marks stale running heartbeats as stale", () => {
  const summary = summarizeHeartbeat(
    {
      observed_at: "2000-01-01T00:00:00.000Z",
      lifecycle_state: "running",
      pid: process.pid,
      service_state: {
        active_run_count: 2,
        last_update_id: 123,
      },
    },
    {
      nowMs: Date.parse("2000-01-01T00:10:00.000Z"),
      pollTimeoutSecs: 30,
    },
  );

  assert.equal(summary.lifecycleState, "stale");
  assert.equal(summary.fresh, false);
  assert.equal(summary.stale, true);
  assert.equal(summary.activeRunCount, 2);
  assert.equal(summary.lastUpdateId, 123);
  assert.equal(summary.generationId, null);
});

test("resolveCodexBinPathForStatus resolves PATH-visible executables for operator status", () => {
  const resolved = resolveCodexBinPathForStatus({
    codexBinPath: "node",
    repoRoot: process.cwd(),
  });

  assert.notEqual(resolved, "node");
  assert.match(resolved, /node/u);
});

test("summarizeHeartbeat keeps generation rollout fields for operator status", () => {
  const summary = summarizeHeartbeat(
    {
      observed_at: "2000-01-01T00:00:00.000Z",
      lifecycle_state: "running",
      pid: process.pid,
      generation: {
        id: "gen-new",
        is_leader: true,
        retiring: false,
        rollout_status: "in_progress",
      },
    },
    {
      nowMs: Date.parse("2000-01-01T00:00:01.000Z"),
      pollTimeoutSecs: 30,
    },
  );

  assert.equal(summary.generationId, "gen-new");
  assert.equal(summary.generationIsLeader, true);
  assert.equal(summary.generationRetiring, false);
  assert.equal(summary.rolloutStatus, "in_progress");
});

test("summarizeRolloutState reports retained handoff details", () => {
  const summary = summarizeRolloutState(
    {
      status: "in_progress",
      current_generation_id: "gen-new",
      target_generation_id: "gen-new",
      retiring_generation_id: "gen-old",
      retained_session_keys: ["topic-a", "topic-b"],
      requested_at: "2026-04-29T10:53:54.838Z",
      started_at: "2026-04-29T10:53:55.357Z",
      finished_at: null,
      last_error: null,
    },
    {
      heartbeatSummary: {
        generationId: "gen-new",
      },
      retiringGenerationLive: true,
    },
  );

  assert.deepEqual(summary, {
    status: "in_progress",
    current_generation_id: "gen-new",
    target_generation_id: "gen-new",
    retiring_generation_id: "gen-old",
    traffic_shifted: true,
    retiring_generation_live: true,
    retained_session_count: 2,
    retained_session_keys: ["topic-a", "topic-b"],
    coordination_retained_session_count: 2,
    coordination_retained_session_keys: ["topic-a", "topic-b"],
    live_retiring_generation_count: 0,
    live_retiring_generation_ids: [],
    live_retained_generation_count: 0,
    live_retained_generation_ids: [],
    live_retained_session_count: 0,
    live_retained_session_keys: [],
    requested_at: "2026-04-29T10:53:54.838Z",
    started_at: "2026-04-29T10:53:55.357Z",
    finished_at: null,
    last_error: null,
  });
});

test("summarizeRolloutState includes live retained sessions outside coordination state", () => {
  const summary = summarizeRolloutState(
    {
      status: "completed",
      current_generation_id: "gen-new",
      target_generation_id: null,
      retiring_generation_id: null,
      retained_session_keys: [],
    },
    {
      heartbeatSummary: {
        generationId: "gen-new",
      },
      liveRetainedSessionKeys: ["topic-b", "topic-a"],
      liveRetainedGenerationIds: ["gen-old"],
      liveRetiringGenerationIds: ["gen-old"],
    },
  );

  assert.equal(summary.status, "completed");
  assert.equal(summary.retained_session_count, 2);
  assert.deepEqual(summary.retained_session_keys, ["topic-a", "topic-b"]);
  assert.equal(summary.coordination_retained_session_count, 0);
  assert.equal(summary.live_retiring_generation_count, 1);
  assert.deepEqual(summary.live_retiring_generation_ids, ["gen-old"]);
  assert.equal(summary.live_retained_generation_count, 1);
  assert.deepEqual(summary.live_retained_generation_ids, ["gen-old"]);
  assert.equal(summary.live_retained_session_count, 2);
});

test("collectLiveRetainedRolloutState reports live foreign owners", async () => {
  const records = new Map([
    ["gen-new", { generation_id: "gen-new", mode: "leader", live: true }],
    ["gen-old", { generation_id: "gen-old", mode: "retiring", live: true }],
    ["gen-stale", { generation_id: "gen-stale", mode: "retiring", live: false }],
    ["gen-foreign", { generation_id: "gen-foreign", mode: "standby", live: true }],
  ]);

  const summary = await collectLiveRetainedRolloutState({
    currentGenerationId: "gen-new",
    generationStore: {
      async listGenerations() {
        return [...records.values()];
      },
      async loadGeneration(generationId) {
        return records.get(generationId) || null;
      },
      async isGenerationRecordVerifiablyLive(record) {
        return Boolean(record?.live);
      },
    },
    sessions: [
      {
        session_key: "topic-a",
        lifecycle_state: "active",
        last_run_status: "running",
        session_owner_generation_id: "gen-old",
      },
      {
        session_key: "topic-b",
        lifecycle_state: "active",
        last_run_status: "running",
        session_owner_generation_id: "gen-stale",
      },
      {
        session_key: "topic-c",
        lifecycle_state: "active",
        last_run_status: "running",
        session_owner_generation_id: "gen-foreign",
      },
      {
        session_key: "topic-d",
        lifecycle_state: "active",
        last_run_status: "running",
        session_owner_generation_id: "gen-new",
      },
    ],
  });

  assert.deepEqual(summary.liveRetainedSessionKeys, ["topic-a", "topic-c"]);
  assert.deepEqual(summary.liveRetainedGenerationIds, ["gen-foreign", "gen-old"]);
  assert.deepEqual(summary.liveRetiringGenerationIds, ["gen-old"]);
});

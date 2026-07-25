import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchDeepSeekThreadSnapshot,
  parseDeepSeekThreadSnapshot,
} from "../src/deepseek-runtime/deepseek-http-status.js";

test("parseDeepSeekThreadSnapshot reads the latest turn", () => {
  assert.deepEqual(
    parseDeepSeekThreadSnapshot({
      id: "thr_live",
      updated_at: "2026-05-08T12:00:00Z",
      turns: [
        { id: "turn_old", status: "completed" },
        {
          id: "turn_live",
          status: "inprogress",
          usage: { total_tokens: 123 },
        },
      ],
    }),
    {
      threadId: "thr_live",
      updatedAt: "2026-05-08T12:00:00Z",
      latestTurnId: "turn_live",
      latestTurnStatus: "in_progress",
      latestUsage: { total_tokens: 123 },
    },
  );

  assert.equal(
    parseDeepSeekThreadSnapshot({
      thread: { id: "thr_wrapped", updated_at: "now" },
      turns: [{ id: "turn_wrapped", status: "in_progress" }],
    }).latestTurnId,
    "turn_wrapped",
  );
});

test("fetchDeepSeekThreadSnapshot queries the runtime on the execution host", async () => {
  const snapshot = await fetchDeepSeekThreadSnapshot({
    apiUrl: "http://127.0.0.1:7891/",
    currentHostId: "local",
    executionHost: {
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
    threadId: "thr:with spaces",
    runHostBashImpl: async ({ currentHostId, host, script }) => {
      assert.equal(currentHostId, "local");
      assert.equal(host.host_id, "workera");
      assert.match(script, /curl -fsS --max-time 3/u);
      assert.match(script, /thr%3Awith%20spaces/u);
      return {
        stdout: JSON.stringify({
          id: "thr_live",
          turns: [{ id: "turn_live", status: "completed" }],
        }),
      };
    },
  });

  assert.equal(snapshot.latestTurnId, "turn_live");
  assert.equal(snapshot.latestTurnStatus, "completed");
});

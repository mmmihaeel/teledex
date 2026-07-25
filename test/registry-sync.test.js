import test from "node:test";
import assert from "node:assert/strict";

import {
  setExitCodeForSyncResults,
  syncResultsHaveFailures,
} from "../src/cli/sync-results.js";

test("syncResultsHaveFailures detects failed per-host sync results", () => {
  assert.equal(syncResultsHaveFailures([
    { host_id: "workera", status: "synced" },
    { host_id: "workerb", status: "failed", reason: "rsync failed" },
  ]), true);
  assert.equal(syncResultsHaveFailures([
    { host_id: "workera", status: "synced" },
    { host_id: "workerz", status: "skipped", reason: "offline" },
  ]), false);
});

test("setExitCodeForSyncResults marks failed sync result sets", () => {
  const processLike = { exitCode: 0 };
  setExitCodeForSyncResults([
    { host_id: "workera", status: "synced" },
    { host_id: "workerb", status: "failed", reason: "rsync failed" },
  ], processLike);

  assert.equal(processLike.exitCode, 1);
});

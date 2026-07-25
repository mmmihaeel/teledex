import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCanaryChecks,
  completedRunTimestamp,
  missingCanaryChecks,
  pickCanaryEvidence,
  pickHookEconomyEvidence,
  prepareCanaryWorkspace,
  summarizeCommandEvent,
} from "../src/cli/run-hook-economy-canary.js";

test("completedRunTimestamp uses last_run_finished_at from Teledex sessions", () => {
  assert.equal(
    completedRunTimestamp({
      last_run_finished_at: "2026-05-18T15:30:00.000Z",
      last_run_completed_at: "stale-field",
    }),
    "2026-05-18T15:30:00.000Z",
  );
  assert.equal(completedRunTimestamp({ last_run_completed_at: "legacy" }), "legacy");
  assert.equal(completedRunTimestamp({}), null);
});

test("prepareCanaryWorkspace creates controlled fixtures by default", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-hook-canary-"));
  const workspace = await prepareCanaryWorkspace({
    workspace: null,
    outDir: tmp,
    stamp: "20260518T000000",
  });

  const smoke = await fs.readFile(path.join(workspace, "fixtures", "smoke.js"), "utf8");
  const noisy = await fs.readFile(path.join(workspace, "fixtures", "noisy.jsonl"), "utf8");

  assert.match(smoke, /bridgeSmoke/u);
  assert.match(noisy, /HOOK_ECONOMY_NOISY_JSONL/u);
});

test("prepareCanaryWorkspace rejects caller workspaces with unexpected fixtures", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-hook-canary-"));
  await fs.mkdir(path.join(tmp, "fixtures"));
  await fs.writeFile(path.join(tmp, "fixtures", "smoke.js"), "secret\n", "utf8");
  await fs.writeFile(path.join(tmp, "fixtures", "noisy.jsonl"), "{}\n", "utf8");

  await assert.rejects(
    () => prepareCanaryWorkspace({
      workspace: tmp,
      outDir: tmp,
      stamp: "20260518T000000",
    }),
    /canary fixture mismatch/u,
  );
});

test("summarizeCommandEvent strips raw command output", () => {
  const summary = summarizeCommandEvent({
    params: {
      item: {
        type: "commandExecution",
        id: "call-1",
        command: "cat fixtures/smoke.js",
        cwd: "/tmp/workspace",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "SECRET_TOKEN=must-not-leak",
      },
    },
  });

  assert.deepEqual(summary, {
    id: "call-1",
    command: "cat fixtures/smoke.js",
    cwd: "/tmp/workspace",
    status: "completed",
    exitCode: 0,
  });
});

test("hook canary checks require Pitlane and RTK Pre/Post evidence separately", () => {
  const commandEvidence = pickCanaryEvidence([
    { command: "pitlane lines fixtures/smoke.js 1 10" },
    { command: "python3 /hooks/rtk-output-guard --b64 abc" },
  ]);
  const hookEvidence = pickHookEconomyEvidence({
    completedRuns: 4,
    byPlugin: {
      "pitlane-codex-plugin": 1,
      "rtk-codex-plugin": 3,
    },
    byDecision: {
      rewrite: 2,
      compact: 1,
    },
    totals: {
      outputOriginalBytes: 10000,
      outputModelVisibleBytes: 1000,
    },
    latest: [
      {
        pluginId: "pitlane-codex-plugin",
        eventName: "PreToolUse",
        decisionType: "rewrite",
      },
      {
        pluginId: "rtk-codex-plugin",
        eventName: "PreToolUse",
        decisionType: "rewrite",
      },
      {
        pluginId: "rtk-codex-plugin",
        eventName: "PostToolUse",
        decisionType: "compact",
        outputOriginalBytes: 10000,
        outputModelVisibleBytes: 1000,
      },
    ],
  });

  const checks = buildCanaryChecks({
    completed: { last_run_status: "completed" },
    commandEvidence,
    hookEvidence,
  });

  assert.deepEqual(checks, {
    completed: true,
    pitlanePreToolUseRewrite: true,
    rtkPreToolUseGuardRewrite: true,
    rtkPostToolUseObserved: true,
    rtkModelVisibleProof: true,
  });
  assert.deepEqual(missingCanaryChecks(checks), []);
});

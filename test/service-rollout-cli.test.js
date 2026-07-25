import test from "node:test";
import assert from "node:assert/strict";

import {
  isUnavailableSystemdUnitError,
  restartSystemdService,
} from "../src/cli/service-rollout.js";

test("isUnavailableSystemdUnitError recognizes missing Teledex user units", () => {
  const missing = new Error("systemctl failed");
  missing.code = 5;
  missing.stderr = "Unit teledex.service could not be found.";

  const failed = new Error("systemctl failed");
  failed.code = 1;
  failed.stderr = "Job for teledex.service failed because the control process exited with error code.";

  assert.equal(isUnavailableSystemdUnitError(missing, "teledex.service"), true);
  assert.equal(isUnavailableSystemdUnitError(failed, "teledex.service"), false);
});

test("restartSystemdService restarts only the Teledex unit", async () => {
  const calls = [];
  await assert.rejects(() => restartSystemdService({
    async runSystemctlImpl(args) {
      calls.push(args);
      const error = new Error("systemctl failed");
      error.stderr = "Unit teledex.service could not be found.";
      throw error;
    },
  }), /systemctl failed/u);

  assert.deepEqual(calls, [
    ["restart", "teledex.service"],
  ]);
});

test("restartSystemdService does not hide broken Teledex unit failures", async () => {
  const calls = [];
  await assert.rejects(
    () => restartSystemdService({
      async runSystemctlImpl(args) {
        calls.push(args);
        const error = new Error("systemctl failed");
        error.stderr = "Job for teledex.service failed because the control process exited with error code.";
        throw error;
      },
    }),
    /systemctl failed/u,
  );

  assert.deepEqual(calls, [["restart", "teledex.service"]]);
});

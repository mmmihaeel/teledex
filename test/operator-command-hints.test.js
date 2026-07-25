import test from "node:test";
import assert from "node:assert/strict";

import {
  formatOperatorCommandHints,
  getOperatorCommandHint,
} from "../src/runtime/operator-command-hints.js";

test("operator command hints stay make-based on Linux", () => {
  assert.equal(getOperatorCommandHint("user-login", { platform: "linux" }), "make user-login");
  assert.equal(getOperatorCommandHint("user-status", { platform: "linux" }), "make user-status");
});

test("operator command hints point Windows operators at wrapper scripts", () => {
  assert.equal(
    getOperatorCommandHint("admin", { platform: "win32" }),
    "scripts\\windows\\admin.cmd",
  );
  assert.equal(
    getOperatorCommandHint("user-e2e", { platform: "win32" }),
    "scripts\\windows\\user-e2e.cmd",
  );
  assert.equal(
    getOperatorCommandHint("test", { platform: "win32" }),
    "scripts\\windows\\test.cmd",
  );
  assert.equal(
    getOperatorCommandHint("test-live", { platform: "win32" }),
    "scripts\\windows\\test-live.cmd",
  );
  assert.equal(
    getOperatorCommandHint("test-live-app-server", { platform: "win32" }),
    "scripts\\windows\\test-live-app-server.cmd",
  );
  assert.equal(
    getOperatorCommandHint("test-live-app-server-v2", { platform: "win32" }),
    "scripts\\windows\\test-live-app-server-v2.cmd",
  );
  assert.equal(
    getOperatorCommandHint("user-agent-audit", { platform: "win32" }),
    "scripts\\windows\\user-agent-audit.cmd",
  );
  assert.equal(
    formatOperatorCommandHints(["doctor", "run"], { platform: "win32" }),
    "`scripts\\windows\\doctor.cmd`, `scripts\\windows\\run.cmd`",
  );
});

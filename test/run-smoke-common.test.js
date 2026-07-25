import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSmokeSupported,
} from "../src/cli/run-smoke-common.js";

test("assertSmokeSupported rejects native Windows smoke runs", async () => {
  await assert.rejects(
    () => assertSmokeSupported("teledex.service", {
      platform: "win32",
      execFileAsync: async () => {},
    }),
    /Linux\/operator-only/u,
  );
});

test("assertSmokeSupported allows inactive Linux user services", async () => {
  const calls = [];
  await assert.doesNotReject(() => assertSmokeSupported("teledex.service", {
    platform: "linux",
    conflictingServiceNames: ["other-poller.service"],
    execFileAsync: async (_command, args) => {
      calls.push(args.at(-1));
      const error = new Error("inactive");
      error.code = 3;
      throw error;
    },
  }));
  assert.deepEqual(calls, [
    "teledex.service",
    "other-poller.service",
  ]);
});

test("assertSmokeSupported refuses when a conflicting unit is active", async () => {
  await assert.rejects(
    () => assertSmokeSupported("teledex.service", {
      platform: "linux",
      conflictingServiceNames: ["other-poller.service"],
      execFileAsync: async (_command, args) => {
        if (args.at(-1) === "other-poller.service") {
          return;
        }
        const error = new Error("inactive");
        error.code = 3;
        throw error;
      },
    }),
    /other-poller\.service is active; refuse smoke run/u,
  );
});

test("assertSmokeSupported fails closed when systemctl health is unknown", async () => {
  await assert.rejects(
    () => assertSmokeSupported("teledex.service", {
      platform: "linux",
      execFileAsync: async () => {
        const error = new Error("Failed to connect to bus");
        error.code = 1;
        error.stderr = "Failed to connect to bus";
        throw error;
      },
    }),
    /Unable to confirm .* systemctl --user/u,
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { createHostAwareRunTask } from "../src/pty-worker/host-aware-run-task.js";
import { DEEPSEEK_HTTP_BACKEND } from "../src/deepseek-runtime/deepseek-http-runner.js";

test("createHostAwareRunTask uses local runner for local execution host", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "app-server",
      codexEnableLegacyAppServer: true,
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 5,
    },
    runLocalTask(args) {
      calls.push({ kind: "local", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask(args) {
      calls.push({ kind: "remote", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: {
      session_key: "s1",
    },
    executionHost: {
      ok: true,
      isLocal: true,
      hostId: "local",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "local");
});

test("createHostAwareRunTask rejects legacy app-server without the legacy gate", () => {
  assert.throws(
    () =>
      createHostAwareRunTask({
        config: {
          codexGatewayBackend: "app-server",
          currentHostId: "local",
        },
      }),
    /TELEDEX_ENABLE_LEGACY_APP_SERVER/u,
  );
});

test("createHostAwareRunTask uses remote runner for ready remote host", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "app-server",
      codexEnableLegacyAppServer: true,
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 9,
    },
    runLocalTask(args) {
      calls.push({ kind: "local", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask(args) {
      calls.push({ kind: "remote", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: {
      session_key: "s2",
    },
    executionHost: {
      ok: true,
      isLocal: false,
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "remote");
  assert.equal(calls[0].args.currentHostId, "local");
  assert.equal(calls[0].args.connectTimeoutSecs, 9);
});

test("createHostAwareRunTask switches to exec-json runners when configured", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "exec-json",
      codexEnableLegacyExecJson: true,
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 7,
    },
    runLocalTask() {
      calls.push({ kind: "local-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask() {
      calls.push({ kind: "remote-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalExecTask(args) {
      calls.push({ kind: "local-exec", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteExecTask(args) {
      calls.push({ kind: "remote-exec", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: { session_key: "s-exec-local" },
    executionHost: { ok: true, isLocal: true, hostId: "local" },
  });
  await runTask({
    session: { session_key: "s-exec-remote" },
    executionHost: {
      ok: true,
      isLocal: false,
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
  });

  assert.deepEqual(calls.map((call) => call.kind), [
    "local-exec",
    "remote-exec",
  ]);
  assert.equal(calls[1].args.currentHostId, "local");
  assert.equal(calls[1].args.connectTimeoutSecs, 7);
});

test("createHostAwareRunTask defaults public runs to app-server-v2 runners", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 7,
    },
    runLocalTask() {
      calls.push({ kind: "local-legacy-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalAppServerV2Task(args) {
      calls.push({ kind: "local-app-server-v2", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalExecTask() {
      calls.push({ kind: "local-exec" });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: { session_key: "s-default-app-server-v2" },
    executionHost: { ok: true, isLocal: true, hostId: "local" },
  });

  assert.deepEqual(calls.map((call) => call.kind), ["local-app-server-v2"]);
});

test("createHostAwareRunTask routes local app-server-v2 runs to v2 runner", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "app-server-v2",
      codexEnableAppServerV2: true,
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 7,
    },
    runLocalTask() {
      calls.push({ kind: "local-legacy-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalAppServerV2Task(args) {
      calls.push({ kind: "local-app-server-v2", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runLocalExecTask() {
      calls.push({ kind: "local-exec" });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: { session_key: "s-v2-local" },
    executionHost: { ok: true, isLocal: true, hostId: "local" },
  });

  assert.deepEqual(calls.map((call) => call.kind), ["local-app-server-v2"]);
});

test("createHostAwareRunTask rejects app-server-v2 without app-server-v2 gate", () => {
  assert.throws(
    () =>
      createHostAwareRunTask({
        config: {
          codexGatewayBackend: "app-server-v2",
          currentHostId: "local",
        },
      }),
    /TELEDEX_ENABLE_APP_SERVER_V2/u,
  );
});

test("createHostAwareRunTask routes remote app-server-v2 runs to v2 remote runner", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      codexGatewayBackend: "app-server-v2",
      codexEnableAppServerV2: true,
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 7,
    },
    runRemoteTask() {
      calls.push({ kind: "remote-legacy-app-server" });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteAppServerV2Task(args) {
      calls.push({ kind: "remote-app-server-v2", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    session: { session_key: "s-v2-remote" },
    executionHost: {
      ok: true,
      isLocal: false,
      hostId: "workera",
      hostLabel: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
  });

  assert.deepEqual(calls.map((call) => call.kind), ["remote-app-server-v2"]);
  assert.equal(calls[0].args.currentHostId, "local");
  assert.equal(calls[0].args.connectTimeoutSecs, 7);
});

test("createHostAwareRunTask routes DeepSeek HTTP profiles to the remote DeepSeek runner", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 11,
    },
    runRemoteDeepSeekTask(args) {
      calls.push({ kind: "remote-deepseek", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await runTask({
    runtimeBackend: DEEPSEEK_HTTP_BACKEND,
    session: { session_key: "s-deepseek" },
    executionHost: {
      ok: true,
      isLocal: false,
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "remote-deepseek");
  assert.equal(calls[0].args.currentHostId, "local");
  assert.equal(calls[0].args.connectTimeoutSecs, 11);
});

test("createHostAwareRunTask fails closed for unavailable execution hosts", async () => {
  const calls = [];
  const runTask = createHostAwareRunTask({
    config: {
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 9,
    },
    runLocalTask(args) {
      calls.push({ kind: "local", args });
      return { child: null, finished: Promise.resolve(null) };
    },
    runRemoteTask(args) {
      calls.push({ kind: "remote", args });
      return { child: null, finished: Promise.resolve(null) };
    },
  });

  await assert.rejects(
    () => runTask({
      session: {
        session_key: "s3",
      },
      executionHost: {
        ok: false,
        isLocal: false,
        hostId: "workera",
        hostLabel: "workera",
        failureReason: "host-not-ready",
      },
    }),
    {
      code: "EXECUTION_HOST_UNAVAILABLE",
      hostId: "workera",
      failureReason: "host-not-ready",
    },
  );

  assert.equal(calls.length, 0);
});

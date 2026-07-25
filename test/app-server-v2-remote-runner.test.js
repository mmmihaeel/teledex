import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runRemoteCodexAppServerV2Task } from "../src/app-server-v2/remote-app-server-v2-runner.js";
import { waitForCondition } from "../test-support/codex-runner-fixtures.js";

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = null;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    child.signalCode = signal;
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

function createFakeAppServer({
  threadId = "thread-remote",
  turnId = "turn-remote",
  autoComplete = true,
} = {}) {
  const child = createFakeChild();
  const requests = [];
  let buffer = "";

  function send(message) {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function notify(method, params = {}) {
    send({ method, params });
  }

  child.stdin.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\n/u);
    buffer = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      requests.push(message);
      if (!message.id) {
        continue;
      }
      if (message.method === "initialize") {
        send({ id: message.id, result: { codexHome: "/home/workerb/.codex" } });
      } else if (message.method === "thread/start") {
        send({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
      } else if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: turnId } } });
        notify("turn/started", { threadId, turn: { id: turnId } });
        if (autoComplete) {
          notify("item/completed", {
            threadId,
            turnId,
            item: {
              type: "agentMessage",
              text: "remote final",
              phase: "final_answer",
            },
          });
          notify("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
          });
        }
      } else if (message.method === "turn/steer") {
        send({ id: message.id, result: { turn: { id: turnId } } });
      }
    }
  });

  return { child, notify, requests };
}

test("runRemoteCodexAppServerV2Task runs app-server-v2 over direct SSH stdio", async () => {
  const fake = createFakeAppServer();
  const execCalls = [];
  const warnings = [];
  let spawnCall = null;
  const task = await runRemoteCodexAppServerV2Task({
    codexBinPath: "/home/example/.local/bin/codex",
    connectTimeoutSecs: 6,
    currentHostId: "local",
    executionHost: {
      hostId: "workerb",
      host: {
        host_id: "workerb",
        ssh_target: "workerb",
        workspace_root: "/path/to/worker-workspace",
        worker_runtime_root: "/path/to/worker-workspace-state/gateway",
        codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
      },
    },
    session: {
      session_key: "-100:4242",
      workspace_binding: {
        workspace_root_path: "/path/to/workspace",
        cwd: "/path/to/workspace/work/example",
      },
    },
    prompt: "hello remote",
    developerInstructions: [
      "Context:",
      "- bound execution host: workerb",
      "- workspace cwd on bound host: /path/to/worker-workspace/work/example",
      "",
      "Work Style:",
      "Keep remote replies short.",
    ].join("\n"),
    execFileImpl(command, args, options, callback) {
      execCalls.push({ command, args, options });
      const stdout = execCalls.length === 1
        ? [
          "cwd=/path/to/worker-workspace/work/example",
          "input_root=/path/to/worker-workspace-state/gateway/remote-inputs/session/run",
          "codex_bin=/path/to/worker-workspace-state/external/forks/codex/bin/codex",
          "",
        ].join("\n")
        : "";
      callback(null, stdout, "");
    },
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return fake.child;
    },
    onWarning(message) {
      warnings.push(message);
    },
  });

  const result = await task.finished;

  assert.equal(result.ok, true);
  assert.equal(result.threadId, "thread-remote");
  assert.equal(spawnCall.command, "ssh");
  assert.notEqual(spawnCall.options.cwd, "/path/to/worker-workspace/work/example");
  assert.equal(spawnCall.args[0], "-T");
  assert.equal(spawnCall.args.includes("workerb"), true);
  assert.match(spawnCall.args.at(-1), /app-server/u);
  assert.match(spawnCall.args.at(-1), /stdio:\/\//u);
  assert.equal(spawnCall.args.at(-1).includes("--session-source"), false);
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0].command, "ssh");
  assert.equal(execCalls[1].command, "ssh");
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    fake.requests.find((request) => request.method === "initialize")?.params?.clientInfo,
    {
      name: "teledex",
      title: "Teledex",
      version: "1.0.0",
    },
  );

  const threadStart = fake.requests.find((request) => request.method === "thread/start");
  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  assert.equal(threadStart.params.cwd, "/path/to/worker-workspace/work/example");
  assert.equal(
    threadStart.params.developerInstructions,
    [
      "Context:",
      "- bound execution host: workerb",
      "- workspace cwd on bound host: /path/to/worker-workspace/work/example",
      "",
      "Work Style:",
      "Keep remote replies short.",
    ].join("\n"),
  );
  assert.equal(turnStart.params.cwd, "/path/to/worker-workspace/work/example");
});

test("runRemoteCodexAppServerV2Task rejects missing remote metadata", async () => {
  await assert.rejects(
    () => runRemoteCodexAppServerV2Task({
      codexBinPath: "codex",
      currentHostId: "local",
      executionHost: { hostId: "workerb", host: { host_id: "workerb" } },
      session: { workspace_binding: { cwd: "/path/to/workspace" } },
      prompt: "hello",
    }),
    /ssh_target/u,
  );
});

test("runRemoteCodexAppServerV2Task cleans remote input root when image staging fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-v2-images-"));
  const localImage = path.join(tmpDir, "screen shot.png");
  await fs.writeFile(localImage, "fake image bytes");
  const execCalls = [];
  const warnings = [];

  await assert.rejects(
    () => runRemoteCodexAppServerV2Task({
      codexBinPath: "codex",
      connectTimeoutSecs: 5,
      currentHostId: "local",
      executionHost: {
        hostId: "workerb",
        host: {
          host_id: "workerb",
          ssh_target: "workerb",
          workspace_root: "/path/to/worker-workspace",
          worker_runtime_root: "/path/to/worker-workspace-state/gateway",
          codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
        },
      },
      session: {
        session_key: "-100:4242",
        workspace_binding: {
          workspace_root_path: "/path/to/workspace",
          cwd: "/path/to/workspace",
        },
      },
      sessionKey: "-100:4242",
      prompt: "remote app-server-v2 prompt with failed image",
      imagePaths: [localImage],
      execFileImpl(command, args, _options, callback) {
        execCalls.push({ command, args });
        if (command === "ssh") {
          const script = args.at(-1) || "";
          if (script.includes("rm -rf --")) {
            callback(null, "", "");
            return;
          }
          callback(
            null,
            [
              "cwd=/path/to/worker-workspace",
              "input_root=/path/to/worker-workspace-state/gateway/remote-inputs/chat-topic/run-cleanup",
              "codex_bin=/path/to/worker-workspace-state/external/forks/codex/bin/codex",
            ].join("\n"),
            "",
          );
          return;
        }
        callback(new Error("rsync failed"), "", "");
      },
      spawnImpl() {
        throw new Error("spawn should not run after staging failure");
      },
      onWarning(message) {
        warnings.push(message);
      },
    }),
    /rsync failed/u,
  );

  assert.equal(
    execCalls.some((call) =>
      call.command === "ssh"
      && String(call.args.at(-1)).includes("rm -rf --")
      && String(call.args.at(-1)).includes("run-cleanup")),
    true,
  );
  assert.deepEqual(warnings, []);
});

test("runRemoteCodexAppServerV2Task stages live-steer images on remote hosts", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-v2-steer-images-"));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const localImage = path.join(tmpDir, "steer.png");
  await fs.writeFile(localImage, "fake image bytes");

  const fake = createFakeAppServer({ autoComplete: false });
  const execCalls = [];
  const warnings = [];
  const task = await runRemoteCodexAppServerV2Task({
    codexBinPath: "codex",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    executionHost: {
      hostId: "workerb",
      host: {
        host_id: "workerb",
        ssh_target: "workerb",
        workspace_root: "/path/to/worker-workspace",
        worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
        codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
      },
    },
    session: {
      session_key: "-100:4242",
      workspace_binding: {
        workspace_root_path: "/path/to/workspace",
        cwd: "/path/to/workspace",
      },
    },
    sessionKey: "-100:4242",
    prompt: "remote app-server-v2 prompt",
    execFileImpl(command, args, options, callback) {
      execCalls.push({ command, args, options });
      if (command === "ssh") {
        const script = String(args.at(-1) || "");
        if (script.includes("rm -rf --")) {
          callback(null, "", "");
          return;
        }
        callback(
          null,
          [
            "cwd=/path/to/worker-workspace",
            "input_root=/path/to/worker-workspace-state/apps/teledex/remote-inputs/100-4242/run-steer",
            "codex_bin=/path/to/worker-workspace-state/external/forks/codex/bin/codex",
          ].join("\n"),
          "",
        );
        return;
      }
      callback(null, "", "");
    },
    spawnImpl() {
      return fake.child;
    },
    onWarning(message) {
      warnings.push(message);
    },
  });

  await waitForCondition(() => fake.requests.some((request) => request.method === "turn/start"));
  const steerResult = await task.steer({
    input: [
      { type: "localImage", path: localImage },
      { type: "localImage", path: localImage },
    ],
  });

  assert.equal(steerResult.ok, true);
  assert.equal(steerResult.reason, "steered");
  const steerRequest = fake.requests.find((request) => request.method === "turn/steer");
  const expectedRemotePath =
    "/path/to/worker-workspace-state/apps/teledex/remote-inputs/100-4242/run-steer/0001-steer.png";
  assert.deepEqual(steerRequest.params.input, [
    { type: "localImage", path: expectedRemotePath },
    { type: "localImage", path: expectedRemotePath },
  ]);

  const rsyncTargets = execCalls
    .filter((call) => call.command === "rsync")
    .map((call) => String(call.args.at(-1)));
  assert.deepEqual(rsyncTargets, [`workerb:${expectedRemotePath}`]);
  assert.equal(rsyncTargets.some((target) => target.includes(":~/")), false);
  assert.deepEqual(warnings, []);

  fake.notify("item/completed", {
    threadId: "thread-remote",
    turnId: "turn-remote",
    item: {
      type: "agentMessage",
      text: "remote final",
      phase: "final_answer",
    },
  });
  fake.notify("turn/completed", {
    threadId: "thread-remote",
    turn: { id: "turn-remote", status: "completed" },
  });
  assert.equal((await task.finished).ok, true);
});

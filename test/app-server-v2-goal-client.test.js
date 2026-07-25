import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { runCodexAppServerV2GoalRpc } from "../src/app-server-v2/goal-client.js";

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

function createGoalServer({ resumeRejectsBeforeSuccess = 0 } = {}) {
  const child = createFakeChild();
  const requests = [];
  let buffer = "";
  let resumeRejectsLeft = resumeRejectsBeforeSuccess;

  function send(message) {
    child.stdout.write(`${JSON.stringify(message)}\n`);
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
        send({ id: message.id, result: { codexHome: "/tmp/codex" } });
      } else if (message.method === "thread/resume") {
        if (resumeRejectsLeft > 0) {
          resumeRejectsLeft -= 1;
          send({
            id: message.id,
            error: {
              code: -32600,
              message: `failed to resolve rollout path \`${message.params.path}\`: No such file or directory (os error 2)`,
            },
          });
        } else {
          send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
        }
      } else if (message.method === "thread/goal/get") {
        send({
          id: message.id,
          result: {
            goal: {
              threadId: message.params.threadId,
              objective: "keep app-server stable",
              status: "active",
              tokenBudget: 5000,
              tokensUsed: 100,
            },
          },
        });
      } else if (message.method === "thread/goal/set") {
        send({
          id: message.id,
          result: {
            goal: {
              threadId: message.params.threadId,
              objective: message.params.objective,
              status: message.params.status,
              tokenBudget: message.params.tokenBudget,
              tokensUsed: 0,
            },
          },
        });
      } else if (message.method === "thread/goal/clear") {
        send({ id: message.id, result: { cleared: true } });
      } else {
        send({ id: message.id, error: { code: -32601, message: "not found" } });
      }
    }
  });

  return { child, requests };
}

test("runCodexAppServerV2GoalRpc resumes a local app-server-v2 thread over stdio", async () => {
  const fake = createGoalServer();
  let spawnCall = null;
  const { result } = await runCodexAppServerV2GoalRpc({
    action: "set",
    codexBinPath: "codex",
    config: {
      workspaceRootPath: "/tmp/workspace/project",
    },
    objective: "keep app-server stable",
    session: {
      codex_thread_id: "thr-local",
      codex_rollout_path: "/tmp/codex/rollout-thr-local.jsonl",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    status: "active",
    tokenBudget: 5000,
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return fake.child;
    },
  });

  assert.equal(spawnCall.command, "codex");
  assert.deepEqual(spawnCall.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.equal(spawnCall.options.cwd, "/tmp/workspace/project/work");
  assert.deepEqual(
    fake.requests.find((request) => request.method === "initialize")?.params?.clientInfo,
    {
      name: "teledex",
      title: "Teledex",
      version: "1.0.0",
    },
  );
  assert.equal(result.goal.objective, "keep app-server stable");
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/resume")?.params,
    {
      threadId: "thr-local",
      path: "/tmp/codex/rollout-thr-local.jsonl",
      cwd: "/tmp/workspace/project/work",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    },
  );
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/goal/set")?.params,
    {
      threadId: "thr-local",
      objective: "keep app-server stable",
      status: "active",
      tokenBudget: 5000,
    },
  );
});

test("runCodexAppServerV2GoalRpc resumes a remote app-server-v2 thread through direct SSH stdio", async () => {
  const fake = createGoalServer();
  const execCalls = [];
  let spawnCall = null;
  const { result } = await runCodexAppServerV2GoalRpc({
    action: "get",
    codexBinPath: "/home/example/.local/bin/codex",
    config: {
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 6,
    },
    executionHost: {
      isLocal: false,
      hostId: "workerb",
      host: {
        host_id: "workerb",
        ssh_target: "workerb",
        workspace_root: "/path/to/worker-workspace",
        worker_runtime_root: "/path/to/worker-workspace-state/gateway",
        codex_bin_path: "/home/workerb/bin/codex-lab",
      },
    },
    session: {
      codex_thread_id: "thr-remote",
      codex_rollout_path: "/home/workerb/.codex/sessions/rollout-thr-remote.jsonl",
      workspace_binding: {
        workspace_root_path: "/path/to/workspace",
        cwd: "/path/to/workspace/work/example",
      },
    },
    execFileImpl(command, args, options, callback) {
      execCalls.push({ command, args, options });
      callback(null, [
        "cwd=/path/to/worker-workspace/work/example",
        "input_root=/path/to/worker-workspace-state/gateway",
        "codex_bin=/home/workerb/bin/codex-lab",
        "",
      ].join("\n"), "");
    },
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return fake.child;
    },
  });

  assert.equal(result.goal.objective, "keep app-server stable");
  assert.equal(execCalls.length, 1);
  assert.equal(spawnCall.command, "ssh");
  assert.equal(spawnCall.args[0], "-T");
  assert.equal(spawnCall.args.includes("workerb"), true);
  assert.match(spawnCall.args.at(-1), /app-server/u);
  assert.match(spawnCall.args.at(-1), /stdio:\/\//u);
  assert.equal(spawnCall.args.at(-1).includes("--session-source"), false);
  assert.equal(spawnCall.options.cwd, process.cwd());
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/resume")?.params,
    {
      threadId: "thr-remote",
      path: "/home/workerb/.codex/sessions/rollout-thr-remote.jsonl",
      cwd: "/path/to/worker-workspace/work/example",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    },
  );
});

test("runCodexAppServerV2GoalRpc retries transient rollout-path resume misses", async () => {
  const fake = createGoalServer({ resumeRejectsBeforeSuccess: 1 });
  const { result } = await runCodexAppServerV2GoalRpc({
    action: "get",
    codexBinPath: "codex",
    config: {
      workspaceRootPath: "/tmp/workspace/project",
    },
    session: {
      codex_thread_id: "thr-local",
      codex_rollout_path: "/tmp/codex/rollout-thr-local.jsonl",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    spawnImpl() {
      return fake.child;
    },
  });

  assert.equal(result.goal.objective, "keep app-server stable");
  assert.equal(
    fake.requests.filter((request) => request.method === "thread/resume").length,
    2,
  );
});

test("runCodexAppServerV2GoalRpc rejects missing thread ids before spawning", async () => {
  await assert.rejects(
    () => runCodexAppServerV2GoalRpc({
      action: "get",
      codexBinPath: "codex",
      session: {},
      spawnImpl() {
        throw new Error("should not spawn");
      },
    }),
    /No app-server-v2 thread/u,
  );
});

test("runCodexAppServerV2GoalRpc rejects child process spawn errors", async () => {
  const child = createFakeChild();
  const promise = runCodexAppServerV2GoalRpc({
    action: "get",
    codexBinPath: "missing-codex",
    session: {
      codex_thread_id: "thr-local",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    spawnImpl() {
      setImmediate(() => child.emit("error", new Error("spawn failed")));
      return child;
    },
  });

  await assert.rejects(promise, /spawn failed/u);
});

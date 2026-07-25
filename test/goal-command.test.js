import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  handleGoalCommand,
  parseGoalCommandArgs,
} from "../src/telegram/command-handlers/goal-command.js";

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

function createGoalServer() {
  const child = createFakeChild();
  const requests = [];
  let buffer = "";

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
        send({
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              turns: [],
            },
          },
        });
      } else if (message.method === "thread/goal/set") {
        send({
          id: message.id,
          result: {
            goal: {
              threadId: message.params.threadId,
              objective: message.params.objective || "lab",
              status: message.params.status || "active",
              tokenBudget: message.params.tokenBudget ?? null,
              tokensUsed: 7,
            },
          },
        });
      } else if (message.method === "thread/goal/get") {
        send({
          id: message.id,
          result: {
            goal: {
              threadId: message.params.threadId,
              objective: "lab",
              status: "active",
              tokenBudget: 100,
              tokensUsed: 7,
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

test("parseGoalCommandArgs maps Telegram goal controls to app-server-v2 RPC actions", () => {
  assert.deepEqual(parseGoalCommandArgs(""), { action: "get" });
  assert.deepEqual(parseGoalCommandArgs("clear"), { action: "clear" });
  assert.deepEqual(parseGoalCommandArgs("pause"), { action: "set", status: "paused" });
  assert.deepEqual(parseGoalCommandArgs("resume"), { action: "set", status: "active" });
  assert.deepEqual(parseGoalCommandArgs("complete"), { action: "set", status: "complete" });
  assert.deepEqual(parseGoalCommandArgs("budget 1200"), { action: "set", tokenBudget: 1200 });
  assert.deepEqual(parseGoalCommandArgs("set ship the app-server backend"), {
    action: "set",
    objective: "ship the app-server backend",
    status: "active",
  });
  assert.deepEqual(parseGoalCommandArgs("ship the app-server backend"), {
    action: "set",
    objective: "ship the app-server backend",
    status: "active",
  });
  assert.equal(parseGoalCommandArgs("budget nope").reason, "invalid-budget");
});

test("handleGoalCommand uses active app-server-v2 controller without spawning a side process", async () => {
  const calls = [];
  const result = await handleGoalCommand({
    config: {
      codexEnableAppServerV2: true,
    },
    args: "set ship stable goals",
    session: {
      session_key: "s1",
      ui_language: "eng",
    },
    workerPool: {
      getActiveRun(sessionKey) {
        assert.equal(sessionKey, "s1");
        return {
          state: { backend: "app-server-v2" },
          controller: {
            async setGoal(goal) {
              calls.push(goal);
              return {
                goal: {
                  objective: goal.objective,
                  status: goal.status,
                },
              };
            },
          },
        };
      },
    },
  });

  assert.equal(result.reason, "goal-set-active");
  assert.match(result.responseText, /ship stable goals/u);
  assert.deepEqual(calls, [{
    objective: "ship stable goals",
    status: "active",
    tokenBudget: undefined,
  }]);
});

test("handleGoalCommand bounds huge goal objective replies for Telegram delivery", async () => {
  const hugeObjective = `start-${"x".repeat(5000)}-end`;
  const result = await handleGoalCommand({
    config: {
      codexEnableAppServerV2: true,
    },
    args: `set ${hugeObjective}`,
    session: {
      session_key: "s1",
      ui_language: "eng",
    },
    workerPool: {
      getActiveRun() {
        return {
          state: { backend: "app-server-v2" },
          controller: {
            async setGoal(goal) {
              return {
                goal: {
                  objective: goal.objective,
                  status: goal.status,
                },
              };
            },
          },
        };
      },
    },
  });

  assert.equal(result.reason, "goal-set-active");
  assert.equal(result.responseText.includes("-end"), false);
  assert.match(result.responseText, /1800\/5010 chars shown/u);
  assert.equal(result.responseText.length < 2200, true);
});

test("handleGoalCommand rejects non app-server-v2 sessions", async () => {
  const result = await handleGoalCommand({
    config: {
      codexEnableAppServerV2: true,
    },
    session: {
      session_key: "s1",
      ui_language: "eng",
      last_run_backend: "exec-json",
      codex_thread_id: "thr-1",
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
    },
  });

  assert.equal(result.reason, "backend-not-app-server-v2");
  assert.match(result.responseText, /app-server-v2/u);
});

test("handleGoalCommand invalid usage mentions complete action", async () => {
  const result = await handleGoalCommand({
    config: {
      codexEnableAppServerV2: true,
    },
    args: "budget nope",
    session: {
      session_key: "s1",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
    },
  });

  assert.equal(result.reason, "invalid-budget");
  assert.match(result.responseText, /complete/u);
});

test("handleGoalCommand rejects stale app-server-v2 sessions when app-server-v2 gate is off", async () => {
  const result = await handleGoalCommand({
    config: {
      codexEnableAppServerV2: false,
    },
    session: {
      session_key: "s1",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      codex_thread_id: "thr-1",
    },
    workerPool: {
      getActiveRun() {
        throw new Error("should not inspect active runs when app-server-v2 gate is disabled");
      },
    },
  });

  assert.equal(result.reason, "app-server-v2-disabled");
  assert.match(result.responseText, /app-server-v2 is enabled/u);
});

test("handleGoalCommand rejects non-Codex provider topics before active or idle goal handling", async () => {
  const result = await handleGoalCommand({
    config: {
      codexBinPath: "codex",
      workspaceRootPath: "/tmp/workspace/project",
      codexEnableAppServerV2: true,
      codexGatewayBackend: "app-server-v2",
    },
    args: "set mutate a provider topic",
    message: {
      message_id: 41,
      text: "mutate a provider topic",
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    session: {
      session_key: "s1",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      session_runtime_provider: "openrouter",
      codex_thread_id: "thr-openrouter",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    workerPool: {
      getActiveRun() {
        return {
          state: { backend: "app-server-v2" },
          controller: {
            async setGoal() {
              throw new Error("provider topics must not use goal controllers");
            },
          },
        };
      },
      async startPromptRun() {
        throw new Error("provider topics must not start managed goal runs");
      },
    },
    spawnImpl() {
      throw new Error("provider topics must not use sidecar goal RPC");
    },
  });

  assert.equal(result.reason, "provider-not-codex");
  assert.match(result.responseText, /Codex app-server-v2 topics/u);
});

test("handleGoalCommand starts a managed app-server-v2 goal run for idle objective sets", async () => {
  const starts = [];
  const result = await handleGoalCommand({
    config: {
      codexBinPath: "codex",
      workspaceRootPath: "/tmp/workspace/project",
      codexEnableAppServerV2: true,
      codexGatewayBackend: "app-server-v2",
    },
    args: "set ship the gateway refactor",
    message: {
      message_id: 42,
      text: "ship the gateway refactor",
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    session: {
      session_key: "s1",
      chat_id: "-1000000",
      topic_id: "4242",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      codex_thread_id: "thr-goal",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      async startPromptRun(args) {
        starts.push(args);
        return { ok: true, sessionKey: args.session.session_key };
      },
    },
    spawnImpl() {
      throw new Error("idle objective set should not use sidecar goal RPC");
    },
  });

  assert.equal(result.reason, "goal-run-started");
  assert.equal(result.responseText, null);
  assert.match(result.deliveredResponseText, /started app-server-v2 continuation/u);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].rawPrompt, "/goal ship the gateway refactor");
  assert.match(starts[0].initialProgressText, /started app-server-v2 continuation/u);
  assert.equal(starts[0].initialProgressReplyToMessageId, 42);
  assert.equal(starts[0].holdInitialProgressUntilNaturalUpdate, true);
  assert.deepEqual(starts[0].goalStart, {
    objective: "ship the gateway refactor",
    status: "active",
    tokenBudget: undefined,
  });
});

test("handleGoalCommand starts managed goal runs even when the materialized thread was cleared", async () => {
  const starts = [];
  const result = await handleGoalCommand({
    config: {
      codexBinPath: "codex",
      workspaceRootPath: "/tmp/workspace/project",
      codexEnableAppServerV2: true,
      codexGatewayBackend: "app-server-v2",
    },
    args: "set refactor from compact brief",
    message: {
      message_id: 43,
      text: "refactor from compact brief",
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    session: {
      session_key: "s1",
      chat_id: "-1000000",
      topic_id: "4242",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      codex_thread_id: null,
      last_compacted_at: "2026-05-12T22:36:44.522Z",
      last_compaction_reason: "context-window-recovery",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      async startPromptRun(args) {
        starts.push(args);
        return { ok: true, sessionKey: args.session.session_key };
      },
    },
    spawnImpl() {
      throw new Error("fresh objective set should not use sidecar goal RPC");
    },
  });

  assert.equal(result.reason, "goal-run-started");
  assert.equal(result.responseText, null);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].session.codex_thread_id, null);
  assert.equal(starts[0].rawPrompt, "/goal refactor from compact brief");
  assert.match(starts[0].initialProgressText, /started app-server-v2 continuation/u);
  assert.equal(starts[0].initialProgressReplyToMessageId, 43);
  assert.equal(starts[0].holdInitialProgressUntilNaturalUpdate, true);
  assert.deepEqual(starts[0].goalStart, {
    objective: "refactor from compact brief",
    status: "active",
    tokenBudget: undefined,
  });
});

test("handleGoalCommand does not start managed goal runs through a non-v2 backend", async () => {
  const fake = createGoalServer();
  let spawnCall = null;
  const result = await handleGoalCommand({
    config: {
      codexBinPath: "codex",
      workspaceRootPath: "/tmp/workspace/project",
      codexEnableAppServerV2: true,
      codexGatewayBackend: "exec-json",
    },
    args: "set keep this on the materialized v2 thread",
    message: {
      message_id: 44,
      text: "keep this on the materialized v2 thread",
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    session: {
      session_key: "s1",
      chat_id: "-1000000",
      topic_id: "4242",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      codex_thread_id: "thr-goal",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      async startPromptRun() {
        throw new Error("must not dispatch goalStart through exec-json");
      },
    },
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return fake.child;
    },
  });

  assert.equal(result.reason, "goal-rpc");
  assert.match(result.responseText, /keep this on the materialized v2 thread/u);
  assert.equal(spawnCall.command, "codex");
  assert.equal(fake.requests.some((request) => request.method === "thread/resume"), true);
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/goal/set")?.params,
    {
      threadId: "thr-goal",
      objective: "keep this on the materialized v2 thread",
      status: "active",
    },
  );
});

test("handleGoalCommand runs idle app-server-v2 goal RPC against stored thread", async () => {
  const fake = createGoalServer();
  let spawnCall = null;
  const result = await handleGoalCommand({
    config: {
      codexBinPath: "codex",
      workspaceRootPath: "/tmp/workspace/project",
      codexEnableAppServerV2: true,
    },
    args: "budget 100",
    session: {
      session_key: "s1",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      codex_thread_id: "thr-goal",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return fake.child;
    },
  });

  assert.equal(result.reason, "goal-rpc");
  assert.match(result.responseText, /Budget: 7\/100 tokens/u);
  assert.equal(spawnCall.command, "codex");
  assert.deepEqual(spawnCall.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.equal(spawnCall.options.cwd, "/tmp/workspace/project/work");
  assert.equal(fake.requests.some((request) => request.method === "thread/resume"), true);
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/goal/set")?.params,
    {
      threadId: "thr-goal",
      tokenBudget: 100,
    },
  );
});

test("handleGoalCommand treats finalizing active app-server-v2 runs as idle", async () => {
  const fake = createGoalServer();
  const result = await handleGoalCommand({
    config: {
      codexBinPath: "codex",
      workspaceRootPath: "/tmp/workspace/project",
      codexEnableAppServerV2: true,
    },
    session: {
      session_key: "s1",
      ui_language: "eng",
      last_run_backend: "app-server-v2",
      codex_thread_id: "thr-goal",
      workspace_binding: {
        cwd: "/tmp/workspace/project/work",
      },
    },
    workerPool: {
      getActiveRun() {
        return {
          state: {
            backend: "app-server-v2",
            finalizing: true,
          },
          controller: {
            async getGoal() {
              throw new Error("finalizing controller should not be used");
            },
          },
        };
      },
    },
    spawnImpl() {
      return fake.child;
    },
  });

  assert.equal(result.reason, "goal-rpc");
  assert.match(result.responseText, /lab/u);
  assert.equal(fake.requests.some((request) => request.method === "thread/resume"), true);
});

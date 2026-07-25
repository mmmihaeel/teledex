import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runCodexAppServerV2Task } from "../src/app-server-v2/app-server-v2-runner.js";

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
  threadId = "thread-1",
  turnId = "turn-1",
  rolloutPath = "/tmp/codex/rollout-thread-1.jsonl",
  autoComplete = true,
  hangMethods = [],
  resumeOpenTurn = false,
  resumeRejectsBeforeSuccess = 0,
  noActiveOnSteer = false,
  interruptRejectsBeforeSuccess = 0,
  goalStartsContinuation = false,
  goalContinuationBeforeResponse = false,
  goalContinuationTurns = goalStartsContinuation ? 1 : 0,
} = {}) {
  const child = createFakeChild();
  const requests = [];
  const notifications = [];
  let buffer = "";
  let interruptRejectsLeft = interruptRejectsBeforeSuccess;
  let resumeRejectsLeft = resumeRejectsBeforeSuccess;

  function send(message) {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function notify(method, params = {}) {
    notifications.push({ method, params });
    send({ method, params });
  }

  function close(code = 0, signal = null) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.exitCode = code;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("close", code, signal));
  }

  function closeProcessOnly(code = 0, signal = null) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => child.emit("close", code, signal));
  }

  function notifyGoalContinuationTurns(threadId) {
    for (let index = 0; index < goalContinuationTurns; index += 1) {
      const nextTurnId = index === 0 ? turnId : `${turnId}-goal-${index + 1}`;
      notify("turn/started", {
        threadId,
        turn: { id: nextTurnId },
      });
      notify("item/completed", {
        threadId,
        turnId: nextTurnId,
        item: {
          type: "agentMessage",
          text: index === 0 ? "goal final answer" : `goal final answer ${index + 1}`,
          phase: "final_answer",
        },
      });
      notify("turn/completed", {
        threadId,
        turn: { id: nextTurnId, status: "completed" },
      });
    }
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
      if (hangMethods.includes(message.method)) {
        continue;
      }
      if (message.method === "initialize") {
        send({ id: message.id, result: { codexHome: "/tmp/codex" } });
      } else if (message.method === "thread/start" || message.method === "thread/resume") {
        if (message.method === "thread/resume" && resumeRejectsLeft > 0) {
          resumeRejectsLeft -= 1;
          send({
            id: message.id,
            error: {
              code: -32600,
              message: `failed to resolve rollout path \`${message.params.path}\`: No such file or directory (os error 2)`,
            },
          });
          continue;
        }
        send({
          id: message.id,
          result: {
            thread: {
              id: message.params?.threadId || threadId,
              path: message.params?.path || rolloutPath,
              turns: message.method === "thread/resume" && resumeOpenTurn
                ? [{ id: turnId, status: "inProgress" }]
                : [],
            },
          },
        });
      } else if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: turnId } } });
        notify("turn/started", {
          threadId,
          turn: { id: turnId },
        });
        if (autoComplete) {
          notify("item/completed", {
            threadId,
            turnId,
            item: {
              type: "agentMessage",
              text: "final answer",
              phase: "final_answer",
            },
          });
          notify("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
          });
        }
      } else if (message.method === "turn/steer") {
        if (noActiveOnSteer) {
          send({
            id: message.id,
            error: { code: -32602, message: "no active turn to steer" },
          });
        } else {
          send({ id: message.id, result: { turnId } });
        }
      } else if (message.method === "turn/interrupt") {
        if (interruptRejectsLeft > 0) {
          interruptRejectsLeft -= 1;
          send({
            id: message.id,
            error: { code: -32600, message: "no active turn to interrupt" },
          });
        } else {
          send({ id: message.id, result: {} });
        }
      } else if (message.method.startsWith("thread/goal/")) {
        const sendGoalResponse = () => {
          send({ id: message.id, result: { goal: { objective: "x", status: "active" } } });
        };
        if (
          message.method === "thread/goal/set"
          && goalStartsContinuation
          && goalContinuationBeforeResponse
        ) {
          notifyGoalContinuationTurns(message.params.threadId);
          setImmediate(sendGoalResponse);
        } else {
          sendGoalResponse();
          if (message.method === "thread/goal/set" && goalStartsContinuation) {
            notifyGoalContinuationTurns(message.params.threadId);
          }
        }
      } else {
        send({ id: message.id, error: { code: -32601, message: "not found" } });
      }
    }
  });

  return {
    child,
    requests,
    notifications,
    send,
    notify,
    close,
    closeProcessOnly,
  };
}

function startRun(fake, overrides = {}) {
  const events = [];
  const runtimeStates = [];
  const run = runCodexAppServerV2Task({
    codexBinPath: "codex",
    cwd: "/tmp/work",
    prompt: "hello",
    spawnImpl(command, args, options) {
      fake.spawn = { command, args, options };
      return fake.child;
    },
    onEvent(summary) {
      events.push(summary);
    },
    onRuntimeState(state) {
      runtimeStates.push(state);
    },
    ...overrides,
  });
  return { run, events, runtimeStates };
}

test("runCodexAppServerV2Task starts app-server over stdio without unsupported session-source flag", async () => {
  const fake = createFakeAppServer();
  const { run, events, runtimeStates } = startRun(fake);

  const result = await run.finished;

  assert.equal(fake.spawn.command, "codex");
  assert.deepEqual(fake.spawn.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.equal(fake.spawn.args.includes("--enable"), true);
  assert.equal(fake.spawn.args.includes("goals"), true);
  assert.equal(fake.spawn.args.includes("--session-source"), false);
  assert.deepEqual(
    fake.requests.find((request) => request.method === "initialize")?.params?.clientInfo,
    {
      name: "teledex",
      title: "Teledex",
      version: "1.0.0",
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.backend, "app-server-v2");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.rolloutPath, "/tmp/codex/rollout-thread-1.jsonl");
  assert.equal(events.some((event) => event.kind === "agent_message" && event.text === "final answer"), true);
  assert.equal(
    runtimeStates.some((state) => (
      state.threadId === "thread-1"
      && state.rolloutPath === "/tmp/codex/rollout-thread-1.jsonl"
    )),
    true,
  );
});

test("runCodexAppServerV2Task mirrors primary app-server-v2 events to JSONL", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-v2-jsonl-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const jsonlLogPath = path.join(tmpDir, "app-server-v2-run.jsonl");
  const fake = createFakeAppServer();
  const { run } = startRun(fake, { jsonlLogPath });

  await run.finished;

  const mirrored = (await fs.readFile(jsonlLogPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    mirrored.map((event) => event.method),
    ["turn/started", "item/completed", "turn/completed"],
  );
  assert.equal(mirrored[1].params.item.text, "final answer");
  assert.equal(mirrored[2].params.turn.status, "completed");
});

test("runCodexAppServerV2Task sends developer instructions to thread/start", async () => {
  const fake = createFakeAppServer();
  const { run } = startRun(fake, {
    developerInstructions: "Context:\n- bound execution host: local\n\nWork Style:\nKeep it short.",
    baseInstructions: "Context:\n- stale legacy base instructions",
  });

  const result = await run.finished;

  assert.equal(result.ok, true);
  const threadStart = fake.requests.find((request) => request.method === "thread/start");
  assert.equal(
    threadStart.params.developerInstructions,
    "Context:\n- bound execution host: local\n\nWork Style:\nKeep it short.",
  );
  assert.equal("baseInstructions" in threadStart.params, false);
});

test("runCodexAppServerV2Task sends developer instructions to thread/resume", async () => {
  const fake = createFakeAppServer();
  const { run } = startRun(fake, {
    sessionThreadId: "thread-1",
    knownRolloutPath: "/tmp/codex/rollout-thread-1.jsonl",
    baseInstructions: "Context:\n- bound execution host: workerb\n\nWork Style:\nBe concise.",
  });

  const result = await run.finished;

  assert.equal(result.ok, true);
  const threadResume = fake.requests.find((request) => request.method === "thread/resume");
  assert.equal(threadResume.params.threadId, "thread-1");
  assert.equal(threadResume.params.path, "/tmp/codex/rollout-thread-1.jsonl");
  assert.equal(
    threadResume.params.developerInstructions,
    "Context:\n- bound execution host: workerb\n\nWork Style:\nBe concise.",
  );
  assert.equal("baseInstructions" in threadResume.params, false);
});

test("runCodexAppServerV2Task classifies transport loss before thread id", async () => {
  const fake = createFakeChild();
  const run = runCodexAppServerV2Task({
    codexBinPath: "codex",
    cwd: "/tmp/work",
    prompt: "hello",
    spawnImpl() {
      return fake;
    },
  });

  fake.stdout.end();
  const result = await run.finished;

  assert.equal(result.ok, false);
  assert.equal(result.abortReason, "transport_lost_before_thread");
});

test("runCodexAppServerV2Task times out stalled control RPCs", async () => {
  const threadStartHang = createFakeAppServer({
    hangMethods: ["thread/start"],
  });
  const threadRun = startRun(threadStartHang, {
    appServerControlTimeoutMs: 5,
  });

  await assert.rejects(
    threadRun.run.finished,
    /request thread\/start timed out/u,
  );

  const threadResumeHang = createFakeAppServer({
    hangMethods: ["thread/resume"],
  });
  const resumeRun = startRun(threadResumeHang, {
    appServerControlTimeoutMs: 5,
    sessionThreadId: "thread-1",
  });

  const resumeResult = await resumeRun.run.finished;
  assert.equal(resumeResult.ok, false);
  assert.equal(resumeResult.threadId, "thread-1");
  assert.equal(resumeResult.abortReason, "control_rpc_failed");
  assert.equal(resumeResult.preserveContinuity, true);
  assert.match(resumeResult.warnings.join("\n"), /request thread\/resume timed out/u);

  const turnStartHang = createFakeAppServer({
    hangMethods: ["turn/start"],
  });
  const turnRun = startRun(turnStartHang, {
    appServerControlTimeoutMs: 5,
  });

  const turnResult = await turnRun.run.finished;
  assert.equal(turnResult.ok, false);
  assert.equal(turnResult.threadId, "thread-1");
  assert.equal(turnResult.abortReason, "control_rpc_failed");
  assert.equal(turnResult.preserveContinuity, true);
  assert.match(turnResult.warnings.join("\n"), /request turn\/start timed out/u);
});

test("runCodexAppServerV2Task preserves continuity when thread/start times out after notification", async () => {
  const fake = createFakeAppServer({
    hangMethods: ["thread/start"],
  });
  const { run } = startRun(fake, {
    appServerControlTimeoutMs: 5,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fake.notify("thread/started", {
    thread: { id: "thread-partial" },
  });

  const result = await run.finished;
  assert.equal(result.ok, false);
  assert.equal(result.threadId, "thread-partial");
  assert.equal(result.abortReason, "control_rpc_failed");
  assert.equal(result.preserveContinuity, true);
  assert.match(result.warnings.join("\n"), /request thread\/start timed out/u);
});

test("runCodexAppServerV2Task preserves thread id on mid-turn transport loss", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const { run } = startRun(fake);

  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.child.stdout.end();
  const result = await run.finished;

  assert.equal(result.ok, false);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.abortReason, "transport_lost");
  assert.equal(result.preserveContinuity, true);
});

test("runCodexAppServerV2Task classifies process close after thread materialization", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const { run } = startRun(fake);

  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.closeProcessOnly(0, null);
  const result = await run.finished;

  assert.equal(result.ok, false);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.abortReason, "process_closed_before_terminal");
  assert.equal(result.preserveContinuity, true);
});

test("runCodexAppServerV2Task maps failed and interrupted turn completion", async () => {
  const failedFake = createFakeAppServer({ autoComplete: false });
  const failed = startRun(failedFake);
  await new Promise((resolve) => setImmediate(resolve));
  failedFake.notify("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "failed",
      error: { message: "boom" },
    },
  });
  const failedResult = await failed.run.finished;
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.abortReason, "turn_failed");
  assert.deepEqual(failedResult.warnings, ["boom"]);

  const interruptedFake = createFakeAppServer({ autoComplete: false });
  const interrupted = startRun(interruptedFake);
  await new Promise((resolve) => setImmediate(resolve));
  await interrupted.run.interrupt();
  interruptedFake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "interrupted" },
  });
  const interruptedResult = await interrupted.run.finished;
  assert.equal(interruptedResult.ok, false);
  assert.equal(interruptedResult.interrupted, true);
  assert.equal(interruptedResult.abortReason, "interrupted");
  assert.equal(interruptedResult.interruptReason, "user");
});

test("runCodexAppServerV2Task bounds interrupt RPC latency", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    hangMethods: ["turn/interrupt"],
  });
  const { run } = startRun(fake, {
    appServerControlTimeoutMs: 5,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await run.interrupt(), false);

  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "interrupted" },
  });
  const result = await run.finished;
  assert.equal(result.ok, false);
  assert.equal(result.abortReason, "interrupted");
  assert.equal(result.interruptReason, "user");
});

test("runCodexAppServerV2Task retries transient early interrupt rejection", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    interruptRejectsBeforeSuccess: 1,
  });
  const { run } = startRun(fake, {
    interruptRetryDelaysMs: [1],
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await run.interrupt(), true);
  assert.equal(
    fake.requests.filter((request) => request.method === "turn/interrupt").length,
    2,
  );

  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "interrupted" },
  });
  const result = await run.finished;
  assert.equal(result.ok, false);
  assert.equal(result.abortReason, "interrupted");
});

test("runCodexAppServerV2Task bounds active-turn refresh during stale steer recovery", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    hangMethods: ["thread/resume"],
    noActiveOnSteer: true,
  });
  const { run } = startRun(fake, {
    appServerControlTimeoutMs: 5,
    steerActiveTurnRefreshRetryDelaysMs: [1],
  });

  await new Promise((resolve) => setImmediate(resolve));
  const steerResult = await run.steer({
    input: [{ type: "text", text: "follow-up" }],
  });

  assert.equal(steerResult.ok, false);
  assert.equal(steerResult.reason, "steer-failed");
  assert.equal(
    fake.requests.some((request) => request.method === "thread/resume"),
    true,
  );

  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "interrupted" },
  });
  await run.finished;
});

test("runCodexAppServerV2Task handles app-server error notifications", async () => {
  const retryingFake = createFakeAppServer({ autoComplete: false });
  const retrying = startRun(retryingFake);
  await new Promise((resolve) => setImmediate(resolve));
  retryingFake.notify("error", {
    threadId: "thread-1",
    willRetry: true,
    error: { message: "temporary" },
  });
  retryingFake.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "done", phase: "final_answer" },
  });
  retryingFake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  const retryingResult = await retrying.run.finished;
  assert.equal(retryingResult.ok, true);
  assert.deepEqual(retryingResult.warnings, ["temporary"]);

  const fatalFake = createFakeAppServer({ autoComplete: false });
  const fatal = startRun(fatalFake);
  await new Promise((resolve) => setImmediate(resolve));
  fatalFake.notify("error", {
    threadId: "thread-1",
    willRetry: false,
    error: { message: "fatal" },
  });
  const fatalResult = await fatal.run.finished;
  assert.equal(fatalResult.ok, false);
  assert.equal(fatalResult.abortReason, "error_notification");
  assert.deepEqual(fatalResult.warnings, ["fatal"]);
});

test("runCodexAppServerV2Task drains terminal notifications before transport-loss classification", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const run = runCodexAppServerV2Task({
    codexBinPath: "codex",
    cwd: "/tmp/work",
    prompt: "hello",
    spawnImpl() {
      return fake.child;
    },
    async onEvent(summary) {
      if (summary?.kind === "agent_message") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  fake.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "done", phase: "final_answer" },
  });
  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  fake.child.stdout.end();

  const result = await run.finished;
  assert.equal(result.ok, true);
  assert.equal(result.abortReason, null);
});

test("runCodexAppServerV2Task rejects late steer after terminal turn notification", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const { run } = startRun(fake, {
    turnCompletionFinalMessageGraceMs: 10,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });

  const steerResult = await run.steer({
    input: [{ type: "text", text: "too late" }],
  });
  assert.equal(steerResult.ok, false);
  assert.equal(steerResult.reason, "finalizing");
  assert.equal(
    fake.requests.some((request) => request.method === "turn/steer"),
    false,
  );
  assert.equal((await run.finished).ok, true);
});

test("runCodexAppServerV2Task rejects unsupported server requests instead of hanging", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const { run } = startRun(fake);

  await new Promise((resolve) => setImmediate(resolve));
  fake.send({
    id: 77,
    method: "item/tool/requestUserInput",
    params: { threadId: "thread-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const response = fake.requests.find((request) => request.id === 77 && request.error);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Unsupported app-server server request/u);

  fake.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "done", phase: "final_answer" },
  });
  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  assert.equal((await run.finished).ok, true);
});

test("runCodexAppServerV2Task buffers steer until an active turn exists", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const { run } = startRun(fake);

  const steerResult = await run.steer({
    input: [{ type: "text", text: "follow-up" }],
  });
  assert.equal(steerResult.ok, true);

  await new Promise((resolve) => setImmediate(resolve));
  const steerRequest = fake.requests.find((request) => request.method === "turn/steer");
  assert.equal(steerRequest.params.expectedTurnId, "turn-1");
  assert.deepEqual(steerRequest.params.input, [{ type: "text", text: "follow-up" }]);

  fake.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "done", phase: "final_answer" },
  });
  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  assert.equal((await run.finished).ok, true);
});

test("runCodexAppServerV2Task steers the initial prompt into a resumed open turn", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    resumeOpenTurn: true,
  });
  const { run } = startRun(fake, {
    sessionThreadId: "thread-1",
  });

  await new Promise((resolve) => setImmediate(resolve));
  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  assert.equal(turnStart, undefined);
  const steerRequest = fake.requests.find((request) => request.method === "turn/steer");
  assert.equal(steerRequest.params.threadId, "thread-1");
  assert.equal(steerRequest.params.expectedTurnId, "turn-1");
  assert.deepEqual(steerRequest.params.input, [{ type: "text", text: "hello" }]);

  fake.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "done", phase: "final_answer" },
  });
  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  assert.equal((await run.finished).ok, true);
});

test("runCodexAppServerV2Task starts a new turn when resumed open turn is stale", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    resumeOpenTurn: true,
    noActiveOnSteer: true,
  });
  const { run } = startRun(fake, {
    sessionThreadId: "thread-1",
    steerActiveTurnRefreshRetryDelaysMs: [],
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const steerRequest = fake.requests.find((request) => request.method === "turn/steer");
  assert.equal(steerRequest.params.expectedTurnId, "turn-1");
  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "hello" }]);

  fake.notify("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "done", phase: "final_answer" },
  });
  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  const result = await run.finished;
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /not steerable/u);
});

test("runCodexAppServerV2Task retries transient rollout-path resume misses", async () => {
  const fake = createFakeAppServer({
    resumeRejectsBeforeSuccess: 1,
  });
  const { run } = startRun(fake, {
    sessionThreadId: "thread-1",
    knownRolloutPath: "/tmp/codex/rollout-thread-1.jsonl",
    threadResumeRetryDelaysMs: [1],
  });

  const result = await run.finished;
  assert.equal(result.ok, true);
  assert.equal(
    fake.requests.filter((request) => request.method === "thread/resume").length,
    2,
  );
  assert.equal(result.rolloutPath, "/tmp/codex/rollout-thread-1.jsonl");
});

test("runCodexAppServerV2Task can set a goal and wait for runtime continuation", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    goalStartsContinuation: true,
  });
  const { run, events } = startRun(fake, {
    prompt: "/goal ship the managed loop",
    sessionThreadId: "thread-1",
    knownRolloutPath: "/tmp/codex/rollout-thread-1.jsonl",
    goalStart: {
      objective: "ship the managed loop",
      status: "active",
    },
    goalContinuationStartTimeoutMs: 25,
    turnCompletionFinalMessageGraceMs: 5,
  });

  const result = await run.finished;

  assert.equal(result.ok, true);
  assert.equal(result.threadId, "thread-1");
  assert.equal(
    fake.requests.some((request) => request.method === "turn/start"),
    false,
  );
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/goal/set")?.params,
    {
      threadId: "thread-1",
      objective: "ship the managed loop",
      status: "active",
    },
  );
  assert.equal(
    events.some((event) => (
      event.kind === "agent_message"
      && event.text === "goal final answer"
    )),
    true,
  );
});

test("runCodexAppServerV2Task preserves goal continuation events before goal RPC response", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    goalStartsContinuation: true,
    goalContinuationBeforeResponse: true,
  });
  const { run, events } = startRun(fake, {
    prompt: "/goal ship the managed loop",
    sessionThreadId: "thread-1",
    knownRolloutPath: "/tmp/codex/rollout-thread-1.jsonl",
    goalStart: {
      objective: "ship the managed loop",
      status: "active",
    },
    goalContinuationStartTimeoutMs: 25,
    turnCompletionFinalMessageGraceMs: 5,
  });

  const result = await run.finished;

  assert.equal(result.ok, true);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.abortReason, null);
  assert.equal(
    events.some((event) => (
      event.kind === "agent_message"
      && event.text === "goal final answer"
    )),
    true,
  );
});

test("runCodexAppServerV2Task keeps chained goal continuation turns alive", async () => {
  const fake = createFakeAppServer({
    autoComplete: false,
    goalStartsContinuation: true,
    goalContinuationTurns: 2,
  });
  const { run, events } = startRun(fake, {
    prompt: "/goal keep going until the goal is complete",
    sessionThreadId: "thread-1",
    knownRolloutPath: "/tmp/codex/rollout-thread-1.jsonl",
    goalStart: {
      objective: "keep going until the goal is complete",
      status: "active",
    },
    goalContinuationStartTimeoutMs: 25,
    turnCompletionFinalMessageGraceMs: 5,
  });

  const result = await run.finished;

  assert.equal(result.ok, true);
  assert.deepEqual(
    events
      .filter((event) => event.kind === "agent_message")
      .map((event) => event.text),
    [
      "goal final answer",
      "goal final answer 2",
    ],
  );
});

test("runCodexAppServerV2Task materializes fresh threads before setting a goal", async () => {
  const fake = createFakeAppServer({
    autoComplete: true,
    goalStartsContinuation: true,
  });
  const { run, events } = startRun(fake, {
    prompt: "ship the managed loop from a compact brief",
    goalStart: {
      objective: "ship the managed loop from a compact brief",
      status: "active",
    },
    goalContinuationStartTimeoutMs: 25,
    turnCompletionFinalMessageGraceMs: 5,
  });

  const result = await run.finished;

  assert.equal(result.ok, true);
  assert.equal(result.threadId, "thread-1");
  assert.deepEqual(
    fake.requests
      .map((request) => request.method)
      .filter((method) => (
        method === "thread/start"
        || method === "turn/start"
        || method === "thread/goal/set"
      )),
    [
      "thread/start",
      "turn/start",
      "thread/goal/set",
    ],
  );
  assert.deepEqual(
    fake.requests.find((request) => request.method === "thread/goal/set")?.params,
    {
      threadId: "thread-1",
      objective: "ship the managed loop from a compact brief",
      status: "active",
    },
  );
  assert.equal(
    events.some((event) => (
      event.kind === "agent_message"
      && event.text === "goal final answer"
    )),
    true,
  );
});

test("runCodexAppServerV2Task exposes goal requests for materialized threads", async () => {
  const fake = createFakeAppServer({ autoComplete: false });
  const { run } = startRun(fake, {
    turnCompletionFinalMessageGraceMs: 5,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await run.setGoal({ objective: "ship stable app-server", tokenBudget: 1000 });
  await run.getGoal();
  await run.clearGoal();

  const goalMethods = fake.requests
    .map((request) => request.method)
    .filter((method) => method?.startsWith("thread/goal/"));
  assert.deepEqual(goalMethods, [
    "thread/goal/set",
    "thread/goal/get",
    "thread/goal/clear",
  ]);
  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: "dangerFullAccess" });

  fake.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  await run.finished;
});

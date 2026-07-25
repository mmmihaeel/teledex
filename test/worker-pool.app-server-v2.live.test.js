import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { buildSleepCommandPrompt } from "../src/runtime/live-command-prompts.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { handleGoalCommand } from "../src/telegram/command-handlers/goal-command.js";

const LIVE_ENABLED = process.env.CODEX_LIVE_TESTS === "1";
const LIVE_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_APP_SERVER_V2_LIVE_TIMEOUT_MS || "180000",
  10,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function buildMockApi(sentMessages) {
  return {
    async sendMessage(payload) {
      sentMessages.push(payload);
      return { message_id: sentMessages.length };
    },
    async editMessageText(payload) {
      sentMessages.push({ ...payload, edited: true });
      return { ok: true };
    },
    async deleteMessage() {
      return true;
    },
  };
}

async function createSession(sessionStore, topicId, topicName, workspaceRoot) {
  return sessionStore.ensure({
    chatId: -1000000,
    topicId,
    topicName,
    createdVia: "test/live-app-server-v2",
    workspaceBinding: {
      repo_root: workspaceRoot,
      cwd: workspaceRoot,
      branch: "main",
      worktree_path: workspaceRoot,
    },
  });
}

async function createWorkerPool(sentMessages, sessionStore) {
  const config = await loadRuntimeConfig();
  return new CodexWorkerPool({
    api: buildMockApi(sentMessages),
    config: {
      ...config,
      codexBinPath: process.env.CODEX_APP_SERVER_V2_LIVE_CODEX_BIN || config.codexBinPath,
      codexGatewayBackend: "app-server-v2",
      codexEnableAppServerV2: true,
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });
}

test("live worker pool app-server-v2 run returns a final reply", {
  skip: LIVE_ENABLED ? false : "set CODEX_LIVE_TESTS=1 to run live app-server-v2 smoke",
  timeout: LIVE_TIMEOUT_MS + 5000,
}, async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-live-app-server-v2-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const sentMessages = [];
  const workerPool = await createWorkerPool(sentMessages, sessionStore);
  t.after(async () => {
    await workerPool.shutdown({
      drainTimeoutMs: 1000,
      interruptActiveRuns: true,
    }).catch(() => null);
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  });

  const workspaceRoot = process.cwd();
  const session = await createSession(
    sessionStore,
    4401,
    "Live App Server V2",
    workspaceRoot,
  );
  const token = `APP_SERVER_V2_SMOKE_${Date.now()}`;

  const started = await workerPool.startPromptRun({
    session,
    prompt: `Reply with exactly ${token} and nothing else.`,
    message: {
      message_id: 4401,
      message_thread_id: 4401,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key) === null,
    LIVE_TIMEOUT_MS,
    "worker-pool app-server-v2 live run",
  );

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_backend, "app-server-v2");
  assert.equal(reloaded.last_run_status, "completed");
  assert.ok(reloaded.codex_thread_id, "worker pool should persist app-server-v2 thread id");
  assert.match(reloaded.last_agent_reply || "", new RegExp(token, "u"));
  assert.equal(
    sentMessages.some((payload) => new RegExp(token, "u").test(payload.text || "")),
    true,
  );

  const goalToken = `goal-${Date.now()}`;
  const goalSet = await handleGoalCommand({
    config: workerPool.config,
    session: reloaded,
    workerPool,
    args: `set ${goalToken}`,
  });
  assert.equal(goalSet.reason, "goal-rpc");
  assert.match(goalSet.responseText, new RegExp(goalToken, "u"));

  const goalGet = await handleGoalCommand({
    config: workerPool.config,
    session: reloaded,
    workerPool,
  });
  assert.equal(goalGet.reason, "goal-rpc");
  assert.match(goalGet.responseText, new RegExp(goalToken, "u"));

  const goalClear = await handleGoalCommand({
    config: workerPool.config,
    session: reloaded,
    workerPool,
    args: "clear",
  });
  assert.equal(goalClear.reason, "goal-rpc");
  assert.match(goalClear.responseText, /cleared/u);

  const managedGoalToken = `APP_SERVER_V2_GOAL_${Date.now()}`;
  const managedGoal = await handleGoalCommand({
    config: workerPool.config,
    session: await sessionStore.load(session.chat_id, session.topic_id),
    workerPool,
    message: {
      message_id: 4404,
      message_thread_id: 4401,
    },
    args: [
      "set",
      `Reply with exactly ${managedGoalToken} and nothing else.`,
      "Then call update_goal with status complete.",
    ].join(" "),
  });
  assert.equal(managedGoal.reason, "goal-run-started");

  await waitFor(
    () => workerPool.getActiveRun(session.session_key) === null,
    LIVE_TIMEOUT_MS,
    "worker-pool app-server-v2 managed goal continuation",
  );

  const goalReloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(goalReloaded.last_run_backend, "app-server-v2");
  assert.equal(goalReloaded.last_run_status, "completed");
  assert.match(goalReloaded.last_agent_reply || "", new RegExp(managedGoalToken, "u"));
});

test("live worker pool app-server-v2 steers a running session", {
  skip: LIVE_ENABLED ? false : "set CODEX_LIVE_TESTS=1 to run live app-server-v2 steer smoke",
  timeout: LIVE_TIMEOUT_MS + 5000,
}, async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-live-app-server-v2-steer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const sentMessages = [];
  const workerPool = await createWorkerPool(sentMessages, sessionStore);
  t.after(async () => {
    await workerPool.shutdown({
      drainTimeoutMs: 1000,
      interruptActiveRuns: true,
    }).catch(() => null);
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  });

  const session = await createSession(
    sessionStore,
    4402,
    "Live App Server V2 Steer",
    process.cwd(),
  );
  const baseToken = `APP_SERVER_V2_BASE_${Date.now()}`;
  const steerToken = `APP_SERVER_V2_STEER_${Date.now()}`;

  const started = await workerPool.startPromptRun({
    session,
    prompt: [
      buildSleepCommandPrompt(3),
      `After the command finishes, reply ONLY with ${baseToken}.`,
      "If a later user message tells you to append another token, obey it and keep the final answer to a single line.",
    ].join(" "),
    message: {
      message_id: 4402,
      message_thread_id: 4402,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key) !== null,
    60000,
    "app-server-v2 live run to start",
  );
  await sleep(500);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: `Append token ${steerToken}. Final answer must be exactly: ${baseToken} ${steerToken}`,
    message: {
      message_id: 4403,
      message_thread_id: 4402,
    },
  });
  assert.equal(steered.ok, true);

  await waitFor(
    () => workerPool.getActiveRun(session.session_key) === null,
    LIVE_TIMEOUT_MS,
    "app-server-v2 live steer completion",
  );

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_backend, "app-server-v2");
  assert.equal(reloaded.last_run_status, "completed");
  assert.match(reloaded.last_agent_reply || "", new RegExp(baseToken, "u"));
  assert.match(reloaded.last_agent_reply || "", new RegExp(steerToken, "u"));
});

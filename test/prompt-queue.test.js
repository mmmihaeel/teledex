import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AgentPromptQueueStore,
  drainPendingAgentPromptQueue,
  summarizeQueuedPrompt,
} from "../src/session-manager/prompt-queue.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/path/to/workspace",
    cwd: "/path/to/workspace",
    branch: "main",
    worktree_path: "/path/to/workspace",
  };
}

async function ensureSession(sessionStore, topicId = 991) {
  return sessionStore.ensure({
    chatId: -1000000,
    topicId,
    topicName: "Prompt queue test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
}

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("AgentPromptQueueStore enqueues, lists, and deletes queue items", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore);

  const first = await promptQueueStore.enqueue(session, {
    rawPrompt: "first queued prompt for verification",
    prompt: "first queued prompt for verification",
  });
  const second = await promptQueueStore.enqueue(session, {
    rawPrompt: "second queued prompt after that",
    prompt: "second queued prompt after that",
  });

  assert.equal(first.position, 1);
  assert.equal(second.position, 2);
  assert.equal(summarizeQueuedPrompt("alpha beta gamma delta epsilon zeta"), "alpha beta gamma delta epsilon...");

  const listed = await promptQueueStore.load(session);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].raw_prompt, "first queued prompt for verification");

  const deleted = await promptQueueStore.deleteAt(session, 2);
  assert.equal(deleted.entry.raw_prompt, "second queued prompt after that");
  assert.equal(deleted.size, 1);

  const remaining = await promptQueueStore.load(session);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].raw_prompt, "first queued prompt for verification");
});

test("drainPendingAgentPromptQueue starts the head prompt and keeps the tail queued", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-drain-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 992);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "head prompt",
    prompt: "head prompt",
    attachments: [{ file_path: "/tmp/a.txt", is_image: false }],
    replyToMessageId: 700,
  });
  await promptQueueStore.enqueue(session, {
    rawPrompt: "tail prompt",
    prompt: "tail prompt",
  });

  const started = [];
  const results = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool: {
      async startPromptRun(args) {
        started.push(args);
        return { ok: true };
      },
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, "User Prompt:\nhead prompt");
  assert.equal(started[0].rawPrompt, "head prompt");
  assert.equal(started[0].attachments.length, 1);
  assert.equal(started[0].message.message_id, 700);

  const remaining = await promptQueueStore.load(session);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].raw_prompt, "tail prompt");
});

test("drainPendingAgentPromptQueue uses the queue-file index when scanning all sessions", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-index-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 997);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "indexed prompt",
    prompt: "indexed prompt",
  });

  sessionStore.listSessions = async () => {
    throw new Error("full session scan should not run here");
  };

  const started = [];
  const results = await drainPendingAgentPromptQueue({
    sessionStore,
    promptQueueStore,
    workerPool: {
      async startPromptRun(args) {
        started.push(args);
        return { ok: true };
      },
    },
  });

  assert.equal(results.length, 1);
  assert.equal(started.length, 1);
  assert.equal(started[0].rawPrompt, "indexed prompt");
});

test("drainPendingAgentPromptQueue normalizes legacy structured prompt bodies before starting them", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-legacy-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 996);

  await promptQueueStore.enqueue(session, {
    rawPrompt: [
      "Work Style:",
      "Keep it short.",
      "",
      "User Prompt:",
      "head prompt",
    ].join("\n"),
    prompt: [
      "Work Style:",
      "Keep it short.",
      "",
      "User Prompt:",
      "head prompt",
    ].join("\n"),
  });

  const started = [];
  const results = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool: {
      async startPromptRun(args) {
        started.push(args);
        return { ok: true };
      },
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].rawPrompt, "head prompt");
  assert.equal(started[0].prompt, "User Prompt:\nhead prompt");
});

test("drainPendingAgentPromptQueue keeps the head queued when the worker is still busy and starts it on retry", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-busy-retry-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 993);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "finish teardown, then run this next",
    prompt: "finish teardown, then run this next",
    replyToMessageId: 701,
  });

  const started = [];
  let busy = true;
  const workerPool = {
    async startPromptRun(args) {
      if (busy) {
        return { ok: false, reason: "busy" };
      }

      started.push(args);
      return { ok: true };
    },
  };

  const firstResults = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
  });
  assert.equal(firstResults.length, 1);
  assert.equal(firstResults[0].result.reason, "busy");

  const queuedAfterBusy = await promptQueueStore.load(session);
  assert.equal(queuedAfterBusy.length, 1);
  assert.equal(
    queuedAfterBusy[0].raw_prompt,
    "finish teardown, then run this next",
  );

  busy = false;
  const secondResults = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
  });
  assert.equal(secondResults.length, 1);
  assert.equal(secondResults[0].result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, "User Prompt:\nfinish teardown, then run this next");
  assert.equal(started[0].rawPrompt, "finish teardown, then run this next");
  assert.equal(started[0].message.message_id, 701);

  const queuedAfterRetry = await promptQueueStore.load(session);
  assert.equal(queuedAfterRetry.length, 0);
});

test("drainPendingAgentPromptQueue backs off unavailable-host retries", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-host-backoff-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 998);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "run when host returns",
    prompt: "run when host returns",
  });

  let startCalls = 0;
  const blockedSessions = new Set();
  const workerPool = {
    shouldSkipQueuedPromptStart(sessionKey) {
      return blockedSessions.has(sessionKey);
    },
    noteQueuedPromptStartResult(sessionKey, result) {
      if (result?.reason === "host-unavailable") {
        blockedSessions.add(sessionKey);
      }
    },
    async startPromptRun() {
      startCalls += 1;
      return { ok: false, reason: "host-unavailable" };
    },
  };

  const firstResults = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
  });
  const secondResults = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
  });

  assert.equal(startCalls, 1);
  assert.equal(firstResults[0].result.reason, "host-unavailable");
  assert.equal(secondResults[0].result.reason, "queue-backoff");
  assert.equal((await promptQueueStore.load(session)).length, 1);
});

test("drainPendingAgentPromptQueue skips prompts for a running session owned by another generation", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-foreign-owner-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  let session = await ensureSession(sessionStore, 995);
  session = await sessionStore.claimSessionOwner(session, {
    generationId: "gen-old",
    mode: "retiring",
  });
  session = await sessionStore.patch(session, {
    last_run_status: "running",
  });

  await promptQueueStore.enqueue(session, {
    rawPrompt: "queued behind foreign run",
    prompt: "queued behind foreign run",
  });

  let startCalls = 0;
  const results = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    currentGenerationId: "gen-new",
    workerPool: {
      async startPromptRun() {
        startCalls += 1;
        return { ok: true };
      },
    },
  });

  assert.equal(results.length, 0);
  assert.equal(startCalls, 0);
  assert.equal((await promptQueueStore.load(session)).length, 1);
});

test("drainPendingAgentPromptQueue claims the head before starting work", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-claim-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 999);
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const started = [];

  await promptQueueStore.enqueue(session, {
    rawPrompt: "only queued prompt",
    prompt: "only queued prompt",
  });

  const workerPool = {
    async startPromptRun(args) {
      started.push(args.rawPrompt);
      firstStarted.resolve();
      await releaseFirst.promise;
      return { ok: true };
    },
  };

  const firstDrain = drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
    currentGenerationId: "generation-a",
  });
  await firstStarted.promise;
  const secondResults = await drainPendingAgentPromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool: {
      async startPromptRun() {
        throw new Error("claimed prompt should not start twice");
      },
    },
    currentGenerationId: "generation-b",
  });

  assert.equal(secondResults.length, 1);
  assert.equal(secondResults[0].result.reason, "queue-claimed");
  assert.deepEqual(started, ["only queued prompt"]);

  releaseFirst.resolve();
  const firstResults = await firstDrain;
  assert.equal(firstResults[0].result.reason, "prompt-started");
  assert.equal((await promptQueueStore.load(session)).length, 0);
});

test("drainPendingAgentPromptQueue releases the head claim when start throws", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-throw-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 1000);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "queued prompt with throwing start",
    prompt: "queued prompt with throwing start",
  });

  await assert.rejects(
    drainPendingAgentPromptQueue({
      session,
      sessionStore,
      promptQueueStore,
      workerPool: {
        async startPromptRun() {
          throw new Error("simulated start failure");
        },
      },
    }),
    /simulated start failure/u,
  );

  const queued = await promptQueueStore.load(session);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].claim_id, null);
  assert.equal(queued[0].claimed_at, null);
});

test("SessionStore rejects purge while a queued prompt claim is active", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-purge-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 1001);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "claimed prompt blocks purge",
    prompt: "claimed prompt blocks purge",
  });
  await promptQueueStore.claimHead(session, { generationId: "gen-queue" });

  await assert.rejects(
    sessionStore.purge(session, "test/purge"),
    /claimed queued prompt/u,
  );

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.lifecycle_state, "active");
});

test("AgentPromptQueueStore quarantines malformed queue files instead of silently keeping them", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-prompt-queue-corrupt-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new AgentPromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 994);
  const queuePath = promptQueueStore.getPath(session);

  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, "{not-json", "utf8");

  const loaded = await promptQueueStore.load(session);
  const entries = await fs.readdir(path.dirname(queuePath));

  assert.deepEqual(loaded, []);
  assert.equal(entries.includes("agent-prompt-queue.json"), false);
  assert.ok(
    entries.some((entry) => entry.startsWith("agent-prompt-queue.json.corrupt-")),
  );
});

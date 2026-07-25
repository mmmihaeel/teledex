import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { withSuppressedConsole } from "../test-support/console-fixtures.js";
import {
  createDeferred,
  sleep,
  waitFor,
} from "../test-support/worker-pool-fixtures.js";

const INITIAL_PROGRESS_TEXT = "...";

test("CodexWorkerPool preserves continuity metadata when native resume stays unavailable after retry", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 144,
    topicName: "Resume fallback test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "stale-thread",
    last_user_prompt: "Remember sentinel SENTINEL_FOX",
    last_agent_reply: "SENTINEL_FOX",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-03-22T12:00:00.000Z",
    status: "completed",
    user_prompt: "Remember sentinel SENTINEL_FOX",
    assistant_reply: "SENTINEL_FOX",
  });

  await sessionStore.writeSessionText(
    resumedSession,
    "active-brief.md",
    "# Active brief\n\nSentinel: SENTINEL_FOX\n",
  );

  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const runCalls = [];
  const runTask = ({ prompt, baseInstructions, sessionThreadId }) => {
    runCalls.push({ prompt, baseInstructions, sessionThreadId });
    const child = {
      kill() {},
    };

    if (runCalls.length <= 2) {
      return {
        child,
        finished: Promise.resolve({
          exitCode: 0,
          signal: null,
          threadId: "replacement-thread",
          warnings: [],
          resumeReplacement: {
            requestedThreadId: "stale-thread",
            replacementThreadId: "replacement-thread",
          },
        }),
      };
    }

    throw new Error(`unexpected extra run attempt #${runCalls.length}`);
  };

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    sessionCompactor: {
      async compact(meta) {
        return {
          session: meta,
          activeBrief: "# Active brief\n\nSentinel: SENTINEL_FOX\n",
          exchangeLogEntries: 1,
        };
      },
    },
    runTask,
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "What sentinel did we agree on?",
    message: {
      message_id: 99,
      message_thread_id: 144,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "stale-thread");
  assert.equal(runCalls[1].sessionThreadId, "replacement-thread");
  assert.doesNotMatch(runCalls[1].prompt, /Context:/u);
  assert.match(runCalls[1].baseInstructions, /Context:/u);
  assert.match(
    runCalls[1].baseInstructions,
    /Telegram topic 144 \(-1000000:144\)/u,
  );
  assert.match(runCalls[1].prompt, /What sentinel did we agree on\?/u);

  const meta = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(meta.codex_thread_id, "replacement-thread");
  assert.equal(meta.last_run_status, "interrupted");
  assert.match(meta.last_agent_reply, /continuity metadata was preserved/u);

  const exchangeLog = await sessionStore.loadExchangeLog(resumedSession);
  assert.equal(exchangeLog.length, 2);
  assert.equal(exchangeLog.at(-1).status, "interrupted");
  assert.equal(exchangeLog.at(-1).user_prompt, "What sentinel did we agree on?");
  assert.match(exchangeLog.at(-1).assistant_reply, /continuity metadata was preserved/u);

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.match(sentMessages.at(-1).text, /Could not finish the run|Could not finish the run/u);
  assert.match(sentMessages.at(-1).text, /continuity metadata was preserved/u);
  assert.equal(sentMessages.at(-1).reply_to_message_id, 99);
  assert.equal(deletedMessages.length, 1);
});

test("CodexWorkerPool passes the stored rollout path into runTask for continuity-aware runs", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-rollout-path-pass-through-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 145,
    topicName: "Known rollout path",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "resume-thread",
    provider_session_id: "provider-session",
    codex_rollout_path: "/tmp/stored-rollout-path.jsonl",
  });

  const runCalls = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        return { message_id: payload.reply_to_message_id ?? 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "app-server",
      codexEnableLegacyAppServer: true,
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ knownRolloutPath, onEvent }) => {
      runCalls.push({ knownRolloutPath });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: "Continuation reached completion.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Continuation reached completion.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "resume-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue with the known rollout path.",
    message: {
      message_id: 1001,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].knownRolloutPath, "/tmp/stored-rollout-path.jsonl");
});

test("CodexWorkerPool passes the stored rollout path into app-server-v2 managed runs", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-v2-rollout-path-pass-through-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 245,
    topicName: "Known app-server-v2 rollout path",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "resume-v2-thread",
    codex_thread_model: "gpt-5.5",
    codex_thread_reasoning_effort: "xhigh",
    codex_rollout_path: "/tmp/stored-v2-rollout-path.jsonl",
  });

  const runCalls = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        return { message_id: payload.reply_to_message_id ?? 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ knownRolloutPath, runtimeBackend, onEvent }) => {
      runCalls.push({ knownRolloutPath, runtimeBackend });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: "App-server-v2 continuation finished.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "App-server-v2 continuation finished.",
              },
            },
          );
          return {
            backend: "app-server-v2",
            ok: true,
            exitCode: 0,
            signal: null,
            threadId: "resume-v2-thread",
            rolloutPath: "/tmp/stored-v2-rollout-path.jsonl",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue with the known app-server-v2 rollout path.",
    message: {
      message_id: 1002,
      message_thread_id: 245,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);
  assert.deepEqual(runCalls, [
    {
      knownRolloutPath: "/tmp/stored-v2-rollout-path.jsonl",
      runtimeBackend: "app-server-v2",
    },
  ]);
});

test("CodexWorkerPool uses the last goal progress message when app-server-v2 finalizes with a completion summary", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-v2-goal-progress-final-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 246,
    topicName: "Goal progress final",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
    codex_thread_model: "gpt-5.5",
    codex_thread_reasoning_effort: "xhigh",
    codex_rollout_path: "/tmp/goal-v2-rollout-path.jsonl",
  });
  const sentMessages = [];
  const token = "APP_SERVER_V2_GOAL_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
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
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "commentary",
        });
	        await onEvent({
	          kind: "turn",
	          eventType: "thread.tokenUsage.updated",
	          usage: {
	            input_tokens: 100,
	            output_tokens: 20,
	            reasoning_tokens: 5,
	            total_tokens: 120,
	          },
	        });
        await onEvent({
          kind: "agent_message",
          text: "Goal complete. Time used: 4 seconds.",
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          rolloutPath: "/tmp/goal-v2-rollout-path.jsonl",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1003,
      message_thread_id: 246,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.match(reloaded.last_agent_reply, new RegExp(`^${token}\\n\\nGoal run: complet`, "u"));
  assert.match(reloaded.last_agent_reply, /Tokens: total=120/u);
  assert.match(reloaded.last_agent_reply, /Tokens \(raw\): total=120, input=100, output=20, reasoning=5/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /Goal complete/u);
  assert.equal(
    sentMessages.some((payload) => (
	      typeof payload.text === "string"
	      && payload.text.includes(token)
	      && payload.text.includes("Tokens: total=120")
	      && payload.text.includes("Tokens (raw): total=120")
	    )),
    true,
  );
});

test("CodexWorkerPool completes app-server-v2 goal runs with an empty final answer after update_goal complete", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-v2-empty-goal-final-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 247,
    topicName: "Empty goal final",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "empty-goal-final-thread",
    codex_thread_model: "gpt-5.5",
    codex_thread_reasoning_effort: "xhigh",
    codex_rollout_path: "/tmp/empty-goal-final-rollout-path.jsonl",
  });
  const sentMessages = [];
  const token = "APP_SERVER_V2_EMPTY_GOAL_FINAL";

  const workerPool = new CodexWorkerPool({
    api: {
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
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "commentary",
        });
        await onEvent({
          kind: "goal",
          eventType: "thread.goal.updated",
          goal: {
            thread_id: "empty-goal-final-thread",
            objective: `Reply with exactly ${token}.`,
            status: "complete",
            tokens_used: 1512,
            time_used_seconds: 41,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: "",
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "empty-goal-final-thread",
          rolloutPath: "/tmp/empty-goal-final-rollout-path.jsonl",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}. Then call update_goal with status complete.`,
    rawPrompt: `/goal Reply with exactly ${token}. Then call update_goal with status complete.`,
    goalStart: {
      objective: `Reply with exactly ${token}. Then call update_goal with status complete.`,
      status: "active",
    },
    message: {
      message_id: 1004,
      message_thread_id: 247,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.match(reloaded.last_agent_reply, new RegExp(`^${token}\\n\\nGoal run: complet`, "u"));
  assert.match(reloaded.last_agent_reply, /Tokens: total=1512/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /Could not finish the run/u);
  assert.equal(
    sentMessages.some((payload) => (
      typeof payload.text === "string"
      && payload.text.includes(token)
      && payload.text.includes("Tokens: total=1512")
    )),
    true,
  );
});

test("CodexWorkerPool strips trailing manual goal summary before appending the canonical footer", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-summary-dedupe-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 248,
    topicName: "Goal summary dedupe",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
    codex_rollout_path: "/tmp/goal-v2-rollout-path.jsonl",
  });
  const sentMessages = [];

  const workerPool = new CodexWorkerPool({
    api: {
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
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          usage: {
            total_tokens: 400,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: [
            "Done.",
            "",
            "Verification: passed.",
            "",
            "Goal complete. Time used: 9s, tokens: 400.",
          ].join("\n"),
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          rolloutPath: "/tmp/goal-v2-rollout-path.jsonl",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Finish the goal.",
    rawPrompt: "/goal Finish the goal.",
    goalStart: {
      objective: "Finish the goal.",
      status: "active",
    },
    message: {
      message_id: 1004,
      message_thread_id: 248,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.match(reloaded.last_agent_reply, /^Done\.\n\nVerification: passed\./u);
  assert.match(reloaded.last_agent_reply, /\n\nGoal run: completed\n/u);
  assert.match(reloaded.last_agent_reply, /Tokens: total=400/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /Goal complete/u);
  assert.equal(
    sentMessages.some((payload) => (
      typeof payload.text === "string"
      && payload.text.includes("Verification: passed.")
      && payload.text.includes("Goal run: completed")
      && !payload.text.includes("Goal complete")
    )),
    true,
  );
});

test("CodexWorkerPool replaces a manual canonical goal footer with computed metrics", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-canonical-footer-replace-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 248,
    topicName: "Goal canonical footer replace",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 20,
            reasoning_tokens: 5,
            total_tokens: 120,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: [
            "Done.",
            "",
            "Goal run: completed",
            "Time: 1s",
            "Tokens: total=37119",
          ].join("\n"),
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Finish the goal.",
    rawPrompt: "/goal Finish the goal.",
    goalStart: {
      objective: "Finish the goal.",
      status: "active",
    },
    message: {
      message_id: 1005,
      message_thread_id: 248,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /^Done\.\n\nGoal run: completed/u);
  assert.match(reloaded.last_agent_reply, /Tokens: total=40/u);
  assert.match(reloaded.last_agent_reply, /Tokens \(raw\): total=120, input=100, cached=80, output=20, reasoning=5/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /37119/u);
});

test("CodexWorkerPool renders English goal footer token metrics", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-english-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 248,
    topicName: "Goal English token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 20,
            reasoning_tokens: 5,
            total_tokens: 120,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: "Done.",
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Finish the goal.",
    rawPrompt: "/goal Finish the goal.",
    goalStart: {
      objective: "Finish the goal.",
      status: "active",
    },
    message: {
      message_id: 1006,
      message_thread_id: 248,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Goal run: completed/u);
  assert.match(reloaded.last_agent_reply, /Tokens: total=40/u);
  assert.match(reloaded.last_agent_reply, /Tokens \(raw\): total=120, input=100, cached=80, output=20, reasoning=5/u);
});

test("CodexWorkerPool goal footer falls back to raw total for partial run usage", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-partial-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 248,
    topicName: "Goal partial token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });
  const token = "APP_SERVER_V2_GOAL_PARTIAL_TOKEN_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          usage: {
            output_tokens: 25,
            total_tokens: 400,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1005,
      message_thread_id: 248,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Tokens: total=400/u);
  assert.match(reloaded.last_agent_reply, /Tokens \(raw\): total=400, output=25/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /Tokens: total=25/u);
});

test("CodexWorkerPool goal footer reports cumulative app-server run token delta", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-cumulative-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 249,
    topicName: "Goal cumulative token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });
  const sentMessages = [];
  const token = "APP_SERVER_V2_GOAL_CUMULATIVE_TOKEN_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
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
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          turnId: "rollout-1",
          usage: {
            input_tokens: 800,
            cached_input_tokens: 700,
            output_tokens: 100,
            reasoning_tokens: 40,
            total_tokens: 900,
          },
          totalUsage: {
            input_tokens: 9000,
            cached_input_tokens: 8000,
            output_tokens: 1000,
            reasoning_tokens: 400,
            total_tokens: 10000,
          },
        });
        await onEvent({
          kind: "turn",
          eventType: "turn.started",
          turnId: "turn-1",
        });
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          turnId: "turn-1",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 90,
            output_tokens: 20,
            reasoning_tokens: 5,
            total_tokens: 120,
          },
          totalUsage: {
            input_tokens: 9100,
            cached_input_tokens: 8090,
            output_tokens: 1020,
            reasoning_tokens: 405,
            total_tokens: 10120,
          },
        });
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          turnId: "turn-1",
          usage: {
            input_tokens: 110,
            cached_input_tokens: 100,
            output_tokens: 20,
            reasoning_tokens: 10,
            total_tokens: 130,
          },
          totalUsage: {
            input_tokens: 9210,
            cached_input_tokens: 8190,
            output_tokens: 1040,
            reasoning_tokens: 415,
            total_tokens: 10250,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1005,
      message_thread_id: 249,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Tokens: total=60/u);
  assert.match(reloaded.last_agent_reply, /Tokens \(raw\): total=250, input=210, cached=190, output=40, reasoning=15/u);
  assert.deepEqual(reloaded.last_token_usage, {
    input_tokens: 110,
    cached_input_tokens: 100,
    output_tokens: 20,
    reasoning_tokens: 10,
    total_tokens: 130,
  });
});

test("CodexWorkerPool goal footer keeps run tokens across fresh-thread recovery", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-recovered-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 251,
    topicName: "Goal recovered token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "oversized-goal-thread",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-05-14T10:00:00.000Z",
    status: "completed",
    user_prompt: "old prompt",
    assistant_reply: "old reply",
  });

  const compactCalls = [];
  const runCalls = [];
  const runtimeEvents = [];
  const token = "APP_SERVER_V2_GOAL_RECOVERED_TOKEN_RESULT";
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
      },
    },
    sessionCompactor: {
      async compact(meta, { reason }) {
        compactCalls.push({ sessionKey: meta.session_key, reason });
        await sessionStore.writeSessionText(
          meta,
          "active-brief.md",
          "# Active brief\n\nRecovered token footer context.\n",
        );
        const compacted = await sessionStore.patch(meta, {
          last_compacted_at: "2026-05-14T10:01:00.000Z",
          last_compaction_reason: reason,
          exchange_log_entries: 1,
          codex_thread_id: null,
          provider_session_id: null,
          codex_rollout_path: null,
          last_context_snapshot: null,
        });
        return { session: compacted };
      },
    },
    runTask: ({ onEvent, sessionThreadId, skipThreadHistoryLookup }) => {
      runCalls.push({ sessionThreadId, skipThreadHistoryLookup });
      if (runCalls.length === 1) {
        return {
          child: { kill() {} },
          finished: (async () => {
            await onEvent({
              kind: "turn",
              eventType: "turn.started",
              turnId: "turn-before-recovery",
            });
            await onEvent({
              kind: "turn",
              eventType: "thread.tokenUsage.updated",
              turnId: "turn-before-recovery",
              usage: {
                input_tokens: 100,
                cached_input_tokens: 80,
                output_tokens: 30,
                reasoning_tokens: 5,
                total_tokens: 130,
              },
              totalUsage: {
                input_tokens: 1000,
                cached_input_tokens: 900,
                output_tokens: 100,
                reasoning_tokens: 10,
                total_tokens: 1100,
              },
            });
            return {
              ok: false,
              backend: "app-server-v2",
              exitCode: 1,
              signal: null,
              threadId: "oversized-goal-thread",
              warnings: [
                "Error running remote compact task:\nCodex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
              ],
              abortReason: "error_notification",
            };
          })(),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "thread",
            eventType: "thread.started",
            threadId: "fresh-goal-thread",
          });
          await onEvent({
            kind: "turn",
            eventType: "turn.started",
            turnId: "turn-after-recovery",
          });
          await onEvent({
            kind: "turn",
            eventType: "thread.tokenUsage.updated",
            turnId: "turn-after-recovery",
            usage: {
              input_tokens: 50,
              cached_input_tokens: 20,
              output_tokens: 40,
              reasoning_tokens: 7,
              total_tokens: 90,
            },
            totalUsage: {
              input_tokens: 200,
              cached_input_tokens: 100,
              output_tokens: 50,
              reasoning_tokens: 8,
              total_tokens: 250,
            },
          });
          await onEvent({
            kind: "agent_message",
            text: token,
            messagePhase: "final_answer",
          });
          return {
            ok: true,
            backend: "app-server-v2",
            exitCode: 0,
            signal: null,
            threadId: "fresh-goal-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1007,
      message_thread_id: 251,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].reason, "context-window-recovery");
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "oversized-goal-thread");
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);
  const attemptEvent = runtimeEvents.find((event) =>
    event.type === "run.attempt" && event.details.abort_reason === "error_notification",
  );
  assert.ok(attemptEvent);
  assert.equal(attemptEvent.details.warnings_count, 1);
  assert.deepEqual(attemptEvent.details.warning_samples, [
    "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
  ]);
  const recoveryEvent = runtimeEvents.find((event) =>
    event.type === "run.recovery"
    && event.details.recovery_kind === "context-window-compact",
  );
  assert.ok(recoveryEvent);
  assert.equal(recoveryEvent.details.warnings_count, 1);
  assert.deepEqual(recoveryEvent.details.warning_samples, attemptEvent.details.warning_samples);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(reloaded.codex_thread_id, "fresh-goal-thread");
  assert.match(reloaded.last_agent_reply, /Tokens: total=120/u);
  assert.match(
    reloaded.last_agent_reply,
    /Tokens \(raw\): total=220, input=150, cached=100, output=70, reasoning=12/u,
  );
  assert.doesNotMatch(reloaded.last_agent_reply, /Tokens: total=70/u);
});

test("CodexWorkerPool clears active turn state across replacement-thread token domains", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-replacement-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 253,
    topicName: "Goal replacement token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "old-goal-thread",
  });
  const runtimeEvents = [];
  const runCalls = [];
  const token = "APP_SERVER_V2_GOAL_REPLACEMENT_TOKEN_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ onEvent, sessionThreadId }) => {
      runCalls.push({ sessionThreadId });
      if (runCalls.length === 1) {
        return {
          child: { kill() {} },
          finished: (async () => {
            await onEvent({
              kind: "turn",
              eventType: "turn.started",
              threadId: "old-goal-thread",
              turnId: "old-turn",
            });
            return {
              ok: false,
              backend: "app-server-v2",
              exitCode: 1,
              signal: null,
              threadId: "old-goal-thread",
              warnings: [],
              resumeReplacement: {
                reason: "transport-disconnect",
                requestedThreadId: "old-goal-thread",
                replacementThreadId: "replacement-goal-thread",
              },
            };
          })(),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "thread",
            eventType: "thread.started",
            threadId: "replacement-goal-thread",
          });
          await onEvent({
            kind: "turn",
            eventType: "thread.tokenUsage.updated",
            threadId: "replacement-goal-thread",
            usage: {
              input_tokens: 100,
              cached_input_tokens: 80,
              output_tokens: 20,
              total_tokens: 120,
            },
            totalUsage: {
              input_tokens: 1000,
              cached_input_tokens: 900,
              output_tokens: 100,
              total_tokens: 1100,
            },
          });
          await onEvent({
            kind: "turn",
            eventType: "turn.started",
            threadId: "replacement-goal-thread",
            turnId: "replacement-turn",
          });
          await onEvent({
            kind: "turn",
            eventType: "thread.tokenUsage.updated",
            threadId: "replacement-goal-thread",
            turnId: "replacement-turn",
            usage: {
              input_tokens: 50,
              cached_input_tokens: 20,
              output_tokens: 40,
              reasoning_tokens: 7,
              total_tokens: 90,
            },
            totalUsage: {
              input_tokens: 1050,
              cached_input_tokens: 920,
              output_tokens: 140,
              reasoning_tokens: 7,
              total_tokens: 1190,
            },
          });
          await onEvent({
            kind: "agent_message",
            text: token,
            messagePhase: "final_answer",
          });
          return {
            ok: true,
            backend: "app-server-v2",
            exitCode: 0,
            signal: null,
            threadId: "replacement-goal-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1009,
      message_thread_id: 253,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[1].sessionThreadId, "replacement-goal-thread");
  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(reloaded.codex_thread_id, "replacement-goal-thread");
  assert.match(reloaded.last_agent_reply, /Tokens: total=70/u);
  assert.match(
    reloaded.last_agent_reply,
    /Tokens \(raw\): total=90, input=50, cached=20, output=40, reasoning=7/u,
  );
  assert.doesNotMatch(reloaded.last_agent_reply, /Tokens: total=110/u);
  const finishedEvent = runtimeEvents.find((event) => event.type === "run.finished");
  assert.deepEqual(finishedEvent?.details.token_usage, {
    input_tokens: 50,
    cached_input_tokens: 20,
    output_tokens: 40,
    reasoning_tokens: 7,
    total_tokens: 90,
  });
});

test("CodexWorkerPool keeps completion-only turn usage in run token accounting", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-completion-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 254,
    topicName: "Goal completion token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });
  const runtimeEvents = [];
  const token = "APP_SERVER_V2_GOAL_COMPLETION_TOKEN_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "turn",
          eventType: "turn.started",
          threadId: "goal-v2-thread",
          turnId: "completion-turn",
        });
        await onEvent({
          kind: "turn",
          eventType: "turn.completed",
          threadId: "goal-v2-thread",
          turnId: "completion-turn",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 3,
            total_tokens: 13,
          },
          totalUsage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 3,
            total_tokens: 13,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "final_answer",
        });
        return {
          ok: true,
          backend: "app-server-v2",
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1010,
      message_thread_id: 254,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Tokens: total=11/u);
  assert.match(
    reloaded.last_agent_reply,
    /Tokens \(raw\): total=13, input=10, cached=2, output=3/u,
  );
  const finishedEvent = runtimeEvents.find((event) => event.type === "run.finished");
  assert.deepEqual(finishedEvent?.details.token_usage, {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 3,
    reasoning_tokens: null,
    total_tokens: 13,
  });
});

test("CodexWorkerPool goal footer uses blended Teledex run tokens and preserves raw metrics", async (t) => {
  const startedAt = new Date("2026-05-14T06:06:46.297Z");
  const finishedAt = new Date("2026-05-14T07:01:08.921Z");
  t.mock.timers.enable({ apis: ["Date"], now: startedAt });
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-run-envelope-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 250,
    topicName: "Goal accounting footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });
  const token = "APP_SERVER_V2_GOAL_ACCOUNTING_RESULT";
  const finishRun = createDeferred();

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await finishRun.promise;
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          turnId: "baseline",
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
          },
          totalUsage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
          },
        });
        await onEvent({
          kind: "turn",
          eventType: "turn.started",
          turnId: "turn-1",
        });
        await onEvent({
          kind: "turn",
          eventType: "thread.tokenUsage.updated",
          turnId: "turn-1",
          usage: {
            input_tokens: 1100,
            cached_input_tokens: 1000,
            output_tokens: 200,
            reasoning_tokens: 100,
            total_tokens: 1300,
          },
          totalUsage: {
            input_tokens: 32990004,
            cached_input_tokens: 32267904,
            output_tokens: 111948,
            reasoning_tokens: 22640,
            total_tokens: 33101952,
          },
        });
        await onEvent({
          kind: "goal",
          eventType: "thread.goal.updated",
          turnId: "turn-1",
          goal: {
            thread_id: "goal-v2-thread",
            objective: `Reply with exactly ${token}.`,
            status: "complete",
            token_budget: 100000,
            tokens_used: 37119,
            time_used_seconds: 42,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1006,
      message_thread_id: 250,
    },
  });
  assert.equal(started.ok, true);
  t.mock.timers.setTime(finishedAt.getTime());
  finishRun.resolve();
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Time: 3263s/u);
  assert.match(reloaded.last_agent_reply, /Tokens: total=834048/u);
  assert.match(
    reloaded.last_agent_reply,
    /Tokens \(raw\): total=33101952, input=32990004, cached=32267904, output=111948, reasoning=22640/u,
  );
  assert.doesNotMatch(reloaded.last_agent_reply, /Time: 42s/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /Tokens: total=33101952/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /37119/u);
  assert.deepEqual(reloaded.last_token_usage, {
    input_tokens: 1100,
    cached_input_tokens: 1000,
    output_tokens: 200,
    reasoning_tokens: 100,
    total_tokens: 1300,
  });
});

test("CodexWorkerPool goal footer falls back to native goal tokens without run usage", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-native-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 252,
    topicName: "Goal native token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });
  const token = "APP_SERVER_V2_GOAL_NATIVE_TOKEN_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "goal",
          eventType: "thread.goal.updated",
          goal: {
            thread_id: "goal-v2-thread",
            objective: `Reply with exactly ${token}.`,
            status: "complete",
            tokens_used: 37119,
            time_used_seconds: 42,
          },
        });
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1008,
      message_thread_id: 252,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Time: \d+s/u);
  assert.match(reloaded.last_agent_reply, /Tokens: total=37119/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /Tokens \(raw\)/u);
});

test("CodexWorkerPool goal footer does not reuse stale token usage", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-stale-token-footer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 247,
    topicName: "Goal stale token footer",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
    last_token_usage: {
      input_tokens: 999,
      cached_input_tokens: 888,
      output_tokens: 77,
      reasoning_tokens: 66,
      total_tokens: 1076,
    },
  });
  const sentMessages = [];
  const token = "APP_SERVER_V2_GOAL_STALE_TOKEN_RESULT";

  const workerPool = new CodexWorkerPool({
    api: {
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
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "agent_message",
          text: token,
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: `Reply with exactly ${token}.`,
    rawPrompt: `/goal Reply with exactly ${token}.`,
    goalStart: {
      objective: `Reply with exactly ${token}.`,
      status: "active",
    },
    message: {
      message_id: 1004,
      message_thread_id: 247,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.match(reloaded.last_agent_reply, /Tokens: unavailable/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /999/u);
  assert.equal(
    sentMessages.some((payload) => (
      typeof payload.text === "string"
      && payload.text.includes(token)
      && payload.text.includes("Tokens: unavailable")
      && !payload.text.includes("999")
    )),
    true,
  );
  assert.deepEqual(reloaded.last_token_usage, resumedSession.last_token_usage);
});

test("CodexWorkerPool uses goal ack as initial progress and holds neutral spinner", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-initial-ack-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 248,
    topicName: "Goal initial ack",
    createdVia: "command/new",
    uiLanguage: "eng",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "goal-v2-thread",
  });
  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const finishRun = createDeferred();
  const ackText = [
    "Goal accepted; started app-server-v2 continuation.",
    "",
    "Goal: verify acknowledgement order.",
    "Status: active",
  ].join("\n");

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await finishRun.promise;
        await onEvent({
          kind: "agent_message",
          text: "GOAL_INITIAL_ACK_DONE",
          messagePhase: "final_answer",
        });
        return {
          backend: "app-server-v2",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "goal-v2-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "verify acknowledgement order",
    rawPrompt: "/goal verify acknowledgement order",
    initialProgressText: ackText,
    initialProgressReplyToMessageId: 1005,
    holdInitialProgressUntilNaturalUpdate: true,
    goalStart: {
      objective: "verify acknowledgement order",
      status: "active",
    },
    message: {
      message_id: 1005,
      message_thread_id: 248,
    },
  });
  assert.equal(started.ok, true);

  await sleep(50);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, ackText);
  assert.equal(sentMessages[0].reply_to_message_id, 1005);
  assert.equal(editedMessages.length, 0);
  assert.equal(deletedMessages.length, 0);
  assert.equal(sentMessages.some((payload) => payload.text === INITIAL_PROGRESS_TEXT), false);

  finishRun.resolve();
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);
});

test("CodexWorkerPool clears stale provider session metadata when a fresh thread starts without a new provider id yet", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-thread-switch-provider-clear-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 146,
    topicName: "Fresh thread without provider session",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "stale-thread",
    provider_session_id: "stale-provider-session",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "stale-thread",
      session_id: "stale-provider-session",
      rollout_path: "/tmp/stale-rollout.jsonl",
    },
  });

  const runCalls = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        return { message_id: payload.reply_to_message_id ?? 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ knownRolloutPath, providerSessionId, onRuntimeState, onEvent }) => {
      runCalls.push({ knownRolloutPath, providerSessionId });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({
            threadId: "fresh-thread",
          });
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Fresh thread finished.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Fresh thread finished.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "fresh-thread",
            warnings: [],
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue after a fresh thread switch.",
    message: {
      message_id: 101,
      message_thread_id: 146,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.deepEqual(runCalls, [
    {
      knownRolloutPath: null,
      providerSessionId: null,
    },
  ]);
  assert.equal(reloaded.codex_thread_id, "fresh-thread");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
});

test("CodexWorkerPool clears legacy app-server metadata when exec-json runTask throws", async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-exec-json-throw-cleanup-"),
  );
  t.after(async () => {
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  });
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 246,
    topicName: "Exec-json thrown cleanup",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const staleSession = await sessionStore.patch(session, {
    codex_backend: "exec-json",
    last_run_backend: "exec-json",
    codex_thread_id: "stale-thread",
    codex_thread_model: "gpt-5.4",
    codex_thread_reasoning_effort: "medium",
    provider_session_id: "stale-provider-session",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "stale-thread",
      session_id: "stale-provider-session",
      rollout_path: "/tmp/stale-rollout.jsonl",
    },
  });
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask() {
      throw new Error("spawn exploded before exec-json emitted state");
    },
  });

  await withSuppressedConsole("error", async () => {
    const started = await workerPool.startPromptRun({
      session: staleSession,
      prompt: "Trigger thrown exec-json failure.",
      message: {
        message_id: 246,
        message_thread_id: 246,
      },
    });
    assert.equal(started.ok, true);
    await waitFor(() => workerPool.getActiveRun(staleSession.session_key) === null);
  });

  const reloaded = await sessionStore.load(staleSession.chat_id, staleSession.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.equal(reloaded.codex_backend, "exec-json");
  assert.equal(reloaded.last_run_backend, "exec-json");
  assert.equal(reloaded.codex_thread_id, null);
  assert.equal(reloaded.codex_thread_model, null);
  assert.equal(reloaded.codex_thread_reasoning_effort, null);
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
});

test("CodexWorkerPool keeps app-server-v2 thread continuity across transport loss", async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-app-server-v2-continuity-"),
  );
  t.after(async () => {
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  });
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 247,
    topicName: "App-server-v2 transport continuity",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const staleSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    codex_thread_id: "previous-v2-thread",
    codex_thread_model: "gpt-5.5",
    codex_thread_reasoning_effort: "high",
    provider_session_id: "legacy-provider-session",
    codex_rollout_path: "/tmp/legacy-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "previous-v2-thread",
      session_id: "legacy-provider-session",
      rollout_path: "/tmp/legacy-rollout.jsonl",
    },
  });
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
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
    runTask({ onRuntimeState }) {
      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({
            backend: "app-server-v2",
            threadId: "live-v2-thread",
            rolloutPath: "/tmp/live-v2-rollout.jsonl",
            model: "gpt-5.5",
            reasoningEffort: "high",
          });
          return {
            backend: "app-server-v2",
            ok: false,
            exitCode: null,
            signal: null,
            threadId: "live-v2-thread",
            rolloutPath: "/tmp/live-v2-rollout.jsonl",
            warnings: ["transport dropped after thread creation"],
            resumeReplacement: null,
            abortReason: "transport_lost",
            preserveContinuity: true,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: staleSession,
    prompt: "Trigger an app-server-v2 transport failure after thread creation.",
    message: {
      message_id: 247,
      message_thread_id: 247,
    },
  });
  await waitFor(() => workerPool.getActiveRun(staleSession.session_key) === null);

  const reloaded = await sessionStore.load(staleSession.chat_id, staleSession.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.equal(reloaded.codex_backend, "app-server-v2");
  assert.equal(reloaded.last_run_backend, "app-server-v2");
  assert.equal(reloaded.codex_thread_id, "live-v2-thread");
  assert.equal(reloaded.codex_thread_model, "gpt-5.5");
  assert.equal(reloaded.codex_thread_reasoning_effort, "xhigh");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, "/tmp/live-v2-rollout.jsonl");
  assert.equal(reloaded.last_context_snapshot, null);
});

test("CodexWorkerPool suppresses stale final replies after a newer owner takes over", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-stale-final-suppression-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 147,
    topicName: "Stale final suppression",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const deletedMessages = [];
  const deferred = createDeferred();
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    serviceGenerationId: "gen-old",
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "Stale final should stay hidden.",
            messagePhase: "final_answer",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Stale final should stay hidden.",
            },
          },
        );
        await deferred.promise;
        return {
          exitCode: 0,
          signal: null,
          threadId: "old-thread",
          warnings: [],
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Old prompt",
    message: {
      message_id: 1200,
      message_thread_id: 147,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) !== null);
  const activeRun = workerPool.getActiveRun(session.session_key);
  await sessionStore.patch(activeRun.session, {
    session_owner_generation_id: "gen-new",
    session_owner_mode: "active",
    last_run_status: "running",
    last_run_started_at: new Date(Date.parse(activeRun.startedAt) + 1000).toISOString(),
    last_user_prompt: "Newer prompt",
    last_agent_reply: "Newer reply",
  });

  await withSuppressedConsole("warn", async () => {
    deferred.resolve();
    await waitFor(() => workerPool.getActiveRun(session.session_key) === null);
  });

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.session_owner_generation_id, "gen-new");
  assert.equal(reloaded.agent_run_owner_generation_id, "gen-new");
  assert.equal(reloaded.last_run_status, "running");
  assert.equal(reloaded.last_user_prompt, "Newer prompt");
  assert.equal(reloaded.last_agent_reply, "Newer reply");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(deletedMessages.length, 1);

  const exchangeLog = await sessionStore.loadExchangeLog(session);
  assert.equal(exchangeLog.length, 0);
});



test("CodexWorkerPool keeps commentary progress visible even after later command and turn events", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 189,
    topicName: "Progress rewrite test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const editedMessages = [];
  const chatActions = [];
  const deferred = createDeferred();
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: 1 };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
      async sendChatAction(payload) {
        chatActions.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "command",
            text: "Running command: rg --files src",
            command: "rg --files src",
          },
          {
            type: "item.started",
            item: {
              type: "command_execution",
              command: "rg --files src",
            },
          },
        );
        await deferred.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "Checking the structure first.",
            messagePhase: "commentary",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Checking the structure first.",
              phase: "commentary",
            },
          },
        );
        await onEvent(
          {
            kind: "command",
            text: "Completed command: rg --files src",
            command: "rg --files src",
            aggregatedOutput: "src/a.js\n",
          },
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "rg --files src",
              aggregated_output: "src/a.js\n",
              exit_code: 0,
            },
          },
        );
        await onEvent(
          {
            kind: "turn",
            text: "Codex turn completed",
            eventType: "turn.completed",
            turnId: "progress-turn",
          },
          {
            type: "turn.completed",
            turn_id: "progress-turn",
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "progress-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "show progress",
    message: {
      message_id: 19,
      message_thread_id: 189,
    },
  });

  await sleep(80);
  assert.equal(editedMessages.length, 0);

  deferred.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(
    editedMessages.some(
      (payload) =>
        /Checking the structure first/u.test(payload.text) &&
        !/Completed command: rg --files src/u.test(payload.text) &&
        !/src\/a\.js/u.test(payload.text) &&
        /\n\n\.{3}$/u.test(payload.text),
    ),
    true,
  );
  assert.equal(
    chatActions.some((payload) => payload.action === "typing"),
    true,
  );
});

test("CodexWorkerPool surfaces legacy DeepSeek HTTP shell stream deltas as progress", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-state-"),
  );
  await fs.mkdir(path.join(stateRoot, "settings"), { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, "settings", "runtime-profiles.json"),
    JSON.stringify({
      profiles: [{
        id: "legacy-deepseek-http",
        backend: "deepseek-http",
        model: "deepseek-v4-pro",
        api_url: "http://127.0.0.1:7891",
      }],
    }),
    "utf8",
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 190,
    topicName: "DeepSeek command progress",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    codex_runtime_profile_id: "legacy-deepseek-http",
  });

  const sentMessages = [];
  const editedMessages = [];
  let observedRuntimeBackend = null;
  const finishGate = createDeferred();
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: 1 };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
      async sendChatAction() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      deepSeekRuntimeApiUrl: "http://127.0.0.1:7891",
      maxParallelSessions: 1,
      stateRoot,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ onEvent, runtimeBackend }) => ({
      child: { kill() {} },
      finished: (async () => {
        observedRuntimeBackend = runtimeBackend;
        await onEvent({
          kind: "turn",
          text: "Codex turn started",
          eventType: "turn.started",
          turnId: "deepseek-turn",
        });
        await onEvent({
          kind: "command",
          text: "Completed command: shell_97336061",
          command: "shell_97336061",
          eventType: "item.completed",
          aggregatedOutput: "Round 13/20: render=730/500, activity=0/1200\n",
          streamDelta: true,
        });
        await finishGate.promise;
        await onEvent({
          kind: "turn",
          text: "Codex turn completed",
          eventType: "turn.completed",
          turnId: "deepseek-turn",
        });
        return {
          exitCode: 0,
          signal: null,
          threadId: "deepseek-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "show deepseek shell progress",
    message: {
      message_id: 20,
      message_thread_id: 190,
    },
  });

  await waitFor(() =>
    editedMessages.some((payload) => /Round 13\/20/u.test(payload.text)),
  );
  const notes = await sessionStore.loadProgressNotes(session);
  assert.equal(
    notes.some((entry) =>
      entry.source === "command_execution" && /Round 13\/20/u.test(entry.text)
    ),
    true,
  );
  finishGate.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(observedRuntimeBackend, "deepseek-http");
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
});



test("CodexWorkerPool steers an active run through the live controller without starting a second turn", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 202,
    topicName: "Steer queue",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const finishGate = createDeferred();
  const runCalls = [];
  const steerCalls = [];
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, baseInstructions, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, baseInstructions, sessionThreadId });
      return {
        child: { kill() {} },
        steer({ input }) {
          steerCalls.push(input);
          return Promise.resolve({
            ok: true,
            reason: "steered",
            inputCount: input.length,
          });
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: steer-thread",
              threadId: "steer-thread",
            },
            {
              type: "thread.started",
              thread_id: "steer-thread",
            },
          );
          await onEvent(
            {
              kind: "turn",
              eventType: "turn.started",
              text: "Codex turn started",
              threadId: "steer-thread",
              turnId: "turn-live",
            },
            {
              type: "turn.started",
              turn_id: "turn-live",
            },
          );
          await finishGate.promise;
          await onEvent(
            {
              kind: "agent_message",
              text: "Applied live steer.",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Applied live steer.",
              },
            },
          );
          await onEvent(
            {
              kind: "turn",
              eventType: "turn.completed",
              text: "Codex turn completed",
              threadId: "steer-thread",
              turnId: "turn-live",
            },
            {
              type: "turn.completed",
              turn_id: "turn-live",
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "steer-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Complete the main task.",
    message: {
      message_id: 500,
      message_thread_id: 202,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) !== null);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key)?.state.activeTurnId === "turn-live",
  );

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Also include this follow-up.",
    message: {
      message_id: 501,
      message_thread_id: 202,
    },
    attachments: [
      {
        file_path: "/tmp/steer-note.txt",
        is_image: false,
        mime_type: "text/plain",
        size_bytes: 42,
      },
    ],
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steered");
  assert.equal(steerCalls.length, 1);
  assert.equal(runCalls.length, 1);
  assert.equal(steerCalls[0][0].type, "text");
  assert.match(steerCalls[0][0].text, /Also include this follow-up\./u);
  assert.match(steerCalls[0][0].text, /Telegram attachments are included with this message/u);
  assert.doesNotMatch(steerCalls[0][0].text, /Context:/u);

  finishGate.resolve();

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.doesNotMatch(runCalls[0].prompt, /Context:/u);
  assert.match(runCalls[0].baseInstructions, /Context:/u);
  assert.match(runCalls[0].prompt, /Complete the main task\./u);
  assert.equal(sentMessages.at(-1).text, "Applied live steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 501);
});

test("CodexWorkerPool recovers exec-json live steer after the interrupted child exits with code 1", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 203,
    topicName: "Exec steer recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const firstAttemptFinished = createDeferred();
  const runCalls = [];
  const steerCalls = [];
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, baseInstructions, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, baseInstructions, sessionThreadId });
      const attempt = runCalls.length;
      const child = { kill() {} };
      if (attempt === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            firstAttemptFinished.resolve();
            return Promise.resolve({ ok: true, reason: "steered" });
          },
          finished: (async () => {
            await onEvent(
              {
                kind: "thread",
                eventType: "thread.started",
                text: "Codex thread started: steer-thread",
                threadId: "steer-thread",
              },
              {
                type: "thread.started",
                thread_id: "steer-thread",
              },
            );
            await onEvent(
              {
                kind: "turn",
                eventType: "turn.started",
                text: "Codex turn started",
                threadId: "steer-thread",
                turnId: "turn-live",
              },
              {
                type: "turn.started",
                turn_id: "turn-live",
              },
            );
            await firstAttemptFinished.promise;
            return {
              backend: "exec-json",
              ok: false,
              exitCode: 1,
              signal: null,
              interrupted: true,
              interruptReason: "upstream",
              preserveContinuity: true,
              threadId: "steer-thread",
              warnings: [],
              resumeReplacement: null,
              abortReason: "interrupted",
            };
          })(),
        };
      }

      if (attempt === 2) {
        return {
          child,
          finished: (async () => {
            await onEvent(
              {
                kind: "agent_message",
                text: "Done with live steer included.",
              },
              {
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: "Done with live steer included.",
                },
              },
            );
            await onEvent(
              {
                kind: "turn",
                eventType: "turn.completed",
                text: "Codex turn completed",
                threadId: "steer-thread",
                turnId: "turn-live-2",
              },
              {
                type: "turn.completed",
                turn_id: "turn-live-2",
              },
            );

            return {
              backend: "exec-json",
              ok: true,
              exitCode: 0,
              signal: null,
              threadId: "steer-thread",
              warnings: [],
              resumeReplacement: null,
              abortReason: null,
            };
          })(),
        };
      }

      throw new Error(`unexpected extra run attempt #${attempt}`);
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Complete the main task.",
    message: {
      message_id: 600,
      message_thread_id: 203,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) !== null);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key)?.state.activeTurnId === "turn-live",
  );

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Also check remote hosts.",
    message: {
      message_id: 601,
      message_thread_id: 203,
    },
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steered");
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(steerCalls.length, 1);
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "steer-thread");
  assert.match(runCalls[1].prompt, /Complete the main task\./u);
  assert.match(runCalls[1].prompt, /Also check remote hosts\./u);
  assert.equal(sentMessages.at(-1).text, "Done with live steer included.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 601);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "steer-thread");
  assert.doesNotMatch(reloaded.last_agent_reply, /stream ended before turn\.completed/u);
});



test("CodexWorkerPool restarts exec-json live steer even if the old child exits cleanly", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-clean-steer-restart-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 205,
    topicName: "Exec clean steer restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const steerAccepted = createDeferred();
  const runCalls = [];
  const steerCalls = [];
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, sessionThreadId });
      const attempt = runCalls.length;
      const child = { kill() {} };
      if (attempt === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            steerAccepted.resolve();
            return Promise.resolve({ ok: true, reason: "steered" });
          },
          finished: (async () => {
            await onEvent({
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: clean-steer-thread",
              threadId: "clean-steer-thread",
            });
            await steerAccepted.promise;
            await onEvent({
              kind: "agent_message",
              eventType: "turn.completed",
              text: "Stale answer before steer was applied.",
              messagePhase: "final_answer",
            });
            return {
              backend: "exec-json",
              ok: true,
              exitCode: 0,
              signal: null,
              threadId: "clean-steer-thread",
              warnings: [],
              resumeReplacement: null,
              abortReason: null,
            };
          })(),
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent({
            kind: "agent_message",
            eventType: "turn.completed",
            text: "Fresh answer after live steer.",
            messagePhase: "final_answer",
          });
          return {
            backend: "exec-json",
            ok: true,
            exitCode: 0,
            signal: null,
            threadId: "clean-steer-thread",
            warnings: [],
            resumeReplacement: null,
            abortReason: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Original task.",
    message: {
      message_id: 800,
      message_thread_id: 205,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Apply this follow-up before final.",
    message: {
      message_id: 801,
      message_thread_id: 205,
    },
  });

  assert.equal(steered.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(steerCalls.length, 1);
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[1].sessionThreadId, "clean-steer-thread");
  assert.match(runCalls[1].prompt, /Original task\./u);
  assert.match(runCalls[1].prompt, /Apply this follow-up before final\./u);
  assert.equal(sentMessages.at(-1).text, "Fresh answer after live steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 801);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_agent_reply, "Fresh answer after live steer.");
});

test("CodexWorkerPool shutdown waits for interrupted runs to finish teardown", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 204,
    topicName: "Shutdown test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const deferred = createDeferred();
  const killSignals = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: () => ({
      child: {
        kill(signal) {
          killSignals.push(signal);
          if (signal === "SIGINT") {
            setTimeout(() => {
              deferred.resolve({
                exitCode: null,
                signal: "SIGINT",
                threadId: "shutdown-thread",
                warnings: [],
                resumeReplacement: null,
              });
            }, 20);
          }
        },
      },
      finished: deferred.promise,
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "shutdown me",
    message: {
      message_id: 21,
      message_thread_id: 204,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 1);

  let settled = false;
  const shutdownPromise = workerPool.shutdown().then(() => {
    settled = true;
  });

  await sleep(5);
  assert.equal(settled, false);

  await shutdownPromise;

  assert.deepEqual(killSignals, ["SIGINT"]);
  assert.equal(serviceState.activeRunCount, 0);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.codex_thread_id, "shutdown-thread");
});

test("CodexWorkerPool interrupt falls back to SIGINT immediately when native interrupt is not ready", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2041,
    topicName: "Interrupt fallback test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const deferred = createDeferred();
  const killSignals = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: () => ({
      child: {
        kill(signal) {
          killSignals.push(signal);
        },
      },
      steer() {
        return Promise.resolve({ ok: false });
      },
      interrupt() {
        return Promise.resolve(false);
      },
      finished: deferred.promise,
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "interrupt me",
    message: {
      message_id: 31,
      message_thread_id: 2041,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 1);
  assert.equal(workerPool.interrupt(session.session_key), true);
  await waitFor(() => killSignals.length > 0);
  assert.deepEqual(killSignals, ["SIGINT"]);

  deferred.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: "interrupt-thread",
    warnings: [],
    resumeReplacement: null,
  });
  await waitFor(() => serviceState.activeRunCount === 0);
});

test("CodexWorkerPool shutdown can drain an active run before sending interrupts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 205,
    topicName: "Shutdown drain test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const deferred = createDeferred();
  const killSignals = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: ({ onEvent }) => ({
      child: {
        kill(signal) {
          killSignals.push(signal);
        },
      },
      finished: (async () => {
        await deferred.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "Drained cleanly.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Drained cleanly.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "drained-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "drain me",
    message: {
      message_id: 22,
      message_thread_id: 205,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 1);

  let settled = false;
  const shutdownPromise = workerPool.shutdown({
    drainTimeoutMs: 200,
    interruptActiveRuns: true,
  }).then(() => {
    settled = true;
  });

  await sleep(20);
  assert.equal(settled, false);
  assert.deepEqual(killSignals, []);

  deferred.resolve();

  await shutdownPromise;

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "drained-thread");
  assert.equal(reloaded.last_agent_reply, "Drained cleanly.");
  assert.deepEqual(killSignals, []);
});

test("CodexWorkerPool hard shutdown stays bounded even if a lifecycle promise never settles", async () => {
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 1,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async patch(session) {
        return session;
      },
      async appendExchangeLogEntry(session) {
        return { session };
      },
    },
    serviceState,
  });

  const lifecycle = createDeferred();
  const sessionKey = "-1000000:2051";
  workerPool.activeRuns.set(sessionKey, {
    sessionKey,
    session: {
      session_key: sessionKey,
      ui_language: "eng",
    },
    child: null,
    controller: null,
    lifecyclePromise: lifecycle.promise,
    exchangePrompt: "pending",
    includeTopicContext: true,
    state: {
      status: "starting",
      interruptRequested: false,
      latestSummary: null,
      latestSummaryKind: null,
      progress: {
        queueUpdate() {},
      },
    },
    startedAt: new Date().toISOString(),
    progressMessageId: null,
    progressTimer: null,
    runtimeProfileInputs: {},
  });

  let settled = false;
  const shutdownPromise = workerPool.shutdown({
    drainTimeoutMs: 50,
    interruptActiveRuns: true,
  }).then(() => {
    settled = true;
  });

  await sleep(200);

  assert.equal(settled, true);
  assert.equal(workerPool.activeRuns.get(sessionKey)?.state.interruptRequested, true);

  lifecycle.resolve();
  workerPool.activeRuns.clear();
  await shutdownPromise;
});

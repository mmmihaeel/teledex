import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import {
  createDeferred,
  sleep,
  waitFor,
} from "../test-support/worker-pool-fixtures.js";

const INITIAL_PROGRESS_TEXT = "...";

test("CodexWorkerPool buffers live steer input while the run is still starting and flushes it into the same run", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 203,
    topicName: "Steer buffer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const progressGate = createDeferred();
  const finishGate = createDeferred();
  const steerCalls = [];
  const sentMessages = [];
  let firstSend = true;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        if (firstSend) {
          firstSend = false;
          await progressGate.promise;
        }
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      steer({ input }) {
        steerCalls.push(input);
        return Promise.resolve({
          ok: true,
          reason: "steer-buffered",
          inputCount: input.length,
        });
      },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: buffered-thread",
            threadId: "buffered-thread",
          },
          {
            type: "thread.started",
            thread_id: "buffered-thread",
          },
        );
        await finishGate.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "Applied buffered steer.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Applied buffered steer.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "buffered-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const startPromise = workerPool.startPromptRun({
    session,
    prompt: "Start the main task.",
    message: {
      message_id: 600,
      message_thread_id: 203,
    },
  });

  const buffered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Also remember this.",
    message: {
      message_id: 601,
      message_thread_id: 203,
    },
  });

  assert.equal(buffered.ok, true);
  assert.equal(buffered.reason, "steer-buffered");

  progressGate.resolve();

  const started = await startPromise;
  assert.equal(started.ok, true);
  await waitFor(() => steerCalls.length === 1);
  assert.equal(steerCalls[0][0].type, "text");
  assert.match(steerCalls[0][0].text, /Also remember this\./u);

  finishGate.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentMessages.at(-1).text, "Applied buffered steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 601);
});

test("CodexWorkerPool buffers live steer for the exec-json backend while the run starts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-exec-no-steer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 204,
    topicName: "Exec buffered steer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const workerPool = new CodexWorkerPool({
    api: {},
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
    runTask: () => {
      throw new Error("not used");
    },
  });

  workerPool.startingRuns.add(session.session_key);
  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "queue me instead",
    message: {
      message_id: 602,
      message_thread_id: 204,
    },
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steer-buffered");
  assert.equal(workerPool.pendingLiveSteers.has(session.session_key), true);
});

test("CodexWorkerPool restarts the run after an upstream interrupt that happens after accepted live steer", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-live-steer-restart-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2033,
    topicName: "Live steer restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const steerCalls = [];
  const firstAttemptFinished = createDeferred();
  const restartImagePath = "/tmp/live-steer-restart.png";
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
    runTask: ({
      prompt,
      developerInstructions,
      baseInstructions,
      imagePaths,
      sessionThreadId,
      onEvent,
    }) => {
      runCalls.push({
        prompt,
        developerInstructions,
        baseInstructions,
        imagePaths,
        sessionThreadId,
      });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            return Promise.resolve({
              ok: true,
              reason: "steered",
            });
          },
          finished: firstAttemptFinished.promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: aborted-thread",
              threadId: "aborted-thread",
            },
            {
              type: "thread.started",
              thread_id: "aborted-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Applied the follow-up and continued the run.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Applied the follow-up and continued the run.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "aborted-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check the topic and keep running.",
    message: {
      message_id: 700,
      message_thread_id: 2033,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Also apply the follow-up after live steer.",
    message: {
      message_id: 701,
      message_thread_id: 2033,
    },
    attachments: [
      {
        file_path: restartImagePath,
        is_image: true,
        mime_type: "image/png",
        size_bytes: 1234,
      },
    ],
  });
  assert.equal(steered.ok, true);
  assert.equal(steerCalls.length, 1);
  assert.equal(steerCalls[0][1].type, "localImage");
  assert.equal(steerCalls[0][1].path, restartImagePath);

  firstAttemptFinished.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: "aborted-thread",
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "aborted-thread");
  assert.match(runCalls[1].prompt, /Also apply the follow-up after live steer\./u);
  assert.doesNotMatch(runCalls[1].prompt, /Context:/u);
  assert.match(runCalls[1].developerInstructions, /^Context:/u);
  assert.match(runCalls[1].developerInstructions, /Telegram topic 2033/u);
  assert.equal(runCalls[1].baseInstructions, runCalls[1].developerInstructions);
  assert.deepEqual(runCalls[1].imagePaths, [restartImagePath]);

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Applied the follow-up and continued the run.");
  assert.equal(sentMessages.at(-1)?.reply_to_message_id, 701);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "aborted-thread");
  assert.equal(reloaded.last_agent_reply, "Applied the follow-up and continued the run.");
});

test("CodexWorkerPool live-steers DeepSeek Codex-provider runs through same-thread exec recovery", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-deepseek-live-steer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 20332,
    topicName: "DeepSeek live steer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
    runtimeProvider: "deepseek",
    runtimeModel: "deepseek-v4-pro",
  });

  const sentMessages = [];
  const runCalls = [];
  const steerCalls = [];
  const runtimeEvents = [];
  const firstAttemptFinished = createDeferred();
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
      codexAutoCompactTokenLimit: 248400,
      codexGatewayBackend: "exec-json",
      deepSeekCodexProviderId: "deepseek_main",
      deepSeekCodexProviderBaseUrl: "https://api.deepseek.com/v1",
      deepSeekCodexProviderEnvKey: "DEEPSEEK_API_KEY",
      deepSeekContextWindow: 1000000,
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
    runTask: ({
      model,
      modelProvider,
      modelProviderConfig,
      prompt,
      reasoningEffort,
      contextWindow,
      autoCompactTokenLimit,
      configOverrides,
      runtimeBackend,
      sessionThreadId,
      onEvent,
    }) => {
      runCalls.push({
        model,
        modelProvider,
        modelProviderConfig,
        prompt,
        reasoningEffort,
        contextWindow,
        autoCompactTokenLimit,
        configOverrides,
        runtimeBackend,
        sessionThreadId,
      });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            return Promise.resolve({
              ok: true,
              reason: "steered",
            });
          },
          finished: (async () => {
            await onEvent(
              {
                kind: "thread",
                eventType: "thread.started",
                text: "Codex thread started: deepseek-provider-thread",
                threadId: "deepseek-provider-thread",
              },
              {
                type: "thread.started",
                thread_id: "deepseek-provider-thread",
              },
            );
            return firstAttemptFinished.promise;
          })(),
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread resumed: deepseek-provider-thread",
              threadId: "deepseek-provider-thread",
            },
            {
              type: "thread.started",
              thread_id: "deepseek-provider-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "DeepSeek applied live steer.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "DeepSeek applied live steer.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "deepseek-provider-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Start the DeepSeek provider task.",
    message: {
      message_id: 730,
      message_thread_id: 20332,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key)?.state?.threadId
      === "deepseek-provider-thread",
  );
  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Live steer: add this detail to the current run.",
    message: {
      message_id: 731,
      message_thread_id: 20332,
    },
  });
  assert.equal(steered.ok, true);
  assert.equal(steerCalls.length, 1);

  firstAttemptFinished.resolve({
    backend: "exec-json",
    exitCode: null,
    signal: "SIGINT",
    threadId: "deepseek-provider-thread",
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].runtimeBackend, "codex");
  assert.equal(runCalls[0].model, "deepseek-v4-pro");
  assert.equal(runCalls[0].reasoningEffort, "xhigh");
  assert.equal(runCalls[0].contextWindow, 1000000);
  assert.equal(runCalls[0].autoCompactTokenLimit, null);
  assert.deepEqual(runCalls[0].configOverrides, {
    "features.tool_search_always_defer_mcp_tools": true,
  });
  assert.equal(runCalls[0].modelProvider, "deepseek_main");
  assert.deepEqual(runCalls[0].modelProviderConfig, {
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    env_key: "DEEPSEEK_API_KEY",
    wire_api: "deepseek_chat",
    requires_openai_auth: false,
    request_max_retries: 6,
    stream_max_retries: 8,
    stream_idle_timeout_ms: 300000,
  });
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "deepseek-provider-thread");
  assert.match(runCalls[1].prompt, /Live steer: add this detail/u);
  assert.equal(runtimeEvents[2]?.details.recovery_kind, "live-steer-restart");
  assert.equal(sentMessages.at(-1)?.text, "DeepSeek applied live steer.");
  assert.equal(sentMessages.at(-1)?.reply_to_message_id, 731);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "deepseek-provider-thread");
  assert.equal(reloaded.last_run_backend, "codex");
  assert.equal(reloaded.last_run_runtime_profile_id, "deepseek:deepseek-v4-pro");
});

test("CodexWorkerPool keeps recovering after each newly accepted live steer", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-live-steer-repeat-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 20331,
    topicName: "Repeated live steer restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const steerCalls = [];
  const runtimeEvents = [];
  const interruptedAttempts = [
    createDeferred(),
    createDeferred(),
    createDeferred(),
  ];
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ prompt, sessionThreadId, onEvent }) => {
      const attempt = runCalls.length + 1;
      runCalls.push({ prompt, sessionThreadId });
      const child = { kill() {} };
      if (attempt <= interruptedAttempts.length) {
        return {
          child,
          steer({ input }) {
            steerCalls.push({ attempt, input });
            return Promise.resolve({
              ok: true,
              reason: "steered",
            });
          },
          finished: interruptedAttempts[attempt - 1].promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread resumed: repeated-live-thread",
              threadId: "repeated-live-thread",
            },
            {
              type: "thread.started",
              thread_id: "repeated-live-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Applied all live steers and continued the run.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Applied all live steers and continued the run.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "repeated-live-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Start the task.",
    message: {
      message_id: 720,
      message_thread_id: 20331,
    },
  });

  for (let index = 0; index < interruptedAttempts.length; index += 1) {
    await waitFor(() => runCalls.length === index + 1);
    await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);
    const steered = await workerPool.steerActiveRun({
      session,
      rawPrompt: `Live steer ${index + 1}.`,
      message: {
        message_id: 721 + index,
        message_thread_id: 20331,
      },
    });
    assert.equal(steered.ok, true);
    interruptedAttempts[index].resolve({
      exitCode: null,
      signal: "SIGINT",
      threadId: "repeated-live-thread",
      warnings: [],
      interrupted: true,
      interruptReason: "upstream",
      abortReason: "interrupted",
      resumeReplacement: null,
    });
  }

  await waitFor(() => runCalls.length === 4, 5000);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(steerCalls.length, 3);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "repeated-live-thread");
  assert.equal(runCalls[2].sessionThreadId, "repeated-live-thread");
  assert.equal(runCalls[3].sessionThreadId, "repeated-live-thread");
  assert.match(runCalls[3].prompt, /Live steer 1\./u);
  assert.match(runCalls[3].prompt, /Live steer 2\./u);
  assert.match(runCalls[3].prompt, /Live steer 3\./u);
  assert.deepEqual(
    runtimeEvents
      .filter((event) => event.type === "run.recovery")
      .map((event) => event.details.recovery_kind),
    [
      "live-steer-restart",
      "live-steer-restart",
      "live-steer-restart",
    ],
  );
  assert.equal(runtimeEvents.at(-1)?.details.status, "completed");
  assert.equal(sentMessages.at(-1)?.text, "Applied all live steers and continued the run.");
  assert.equal(sentMessages.at(-1)?.reply_to_message_id, 723);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "repeated-live-thread");
});

test("CodexWorkerPool keeps the previous progress bubble while live steer rebuilds", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-live-steer-progress-hold-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2035,
    topicName: "Live steer progress hold",
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
  const runCalls = [];
  const steerCalls = [];
  const firstAttemptFinished = createDeferred();
  const secondProgressGate = createDeferred();
  const secondAttemptFinished = createDeferred();
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
    runTask: ({ sessionThreadId, onEvent }) => {
      runCalls.push({ sessionThreadId });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            return Promise.resolve({
              ok: true,
              reason: "steered",
            });
          },
          finished: (async () => {
            await onEvent(
              {
                kind: "thread",
                eventType: "thread.started",
                text: "Codex thread started: progress-hold-thread",
                threadId: "progress-hold-thread",
              },
              {
                type: "thread.started",
                thread_id: "progress-hold-thread",
              },
            );
            await onEvent(
              {
                kind: "agent_message",
                eventType: "item.completed",
                text: "Last update before live steer.",
                messagePhase: "commentary",
              },
              {
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: "Last update before live steer.",
                },
              },
            );
            await firstAttemptFinished.promise;
            return {
              exitCode: null,
              signal: "SIGINT",
              threadId: "progress-hold-thread",
              warnings: [],
              interrupted: true,
              interruptReason: "upstream",
              abortReason: "interrupted",
              resumeReplacement: null,
            };
          })(),
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread resumed: progress-hold-thread",
              threadId: "progress-hold-thread",
            },
            {
              type: "thread.started",
              thread_id: "progress-hold-thread",
            },
          );
          await secondProgressGate.promise;
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "New update after live steer.",
              messagePhase: "commentary",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "New update after live steer.",
              },
            },
          );
          await secondAttemptFinished.promise;
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Final answer after live steer.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Final answer after live steer.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "progress-hold-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Start the task with progress.",
    message: {
      message_id: 710,
      message_thread_id: 2035,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);
  await waitFor(() => editedMessages.some(
    (message) => /Last update before live steer/u.test(message.text),
  ));

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Live steer follow-up.",
    message: {
      message_id: 711,
      message_thread_id: 2035,
    },
  });
  assert.equal(steered.ok, true);
  assert.equal(steerCalls.length, 1);

  firstAttemptFinished.resolve();
  await waitFor(() => runCalls.length === 2);
  await sleep(1100);

  assert.doesNotMatch(
    editedMessages.map((message) => message.text).join("\n"),
    /Continuing the same Codex thread|Continuing the same Codex thread|Working|Working/u,
  );

  secondProgressGate.resolve();
  await waitFor(() => editedMessages.some(
    (message) => /New update after live steer/u.test(message.text),
  ));
  secondAttemptFinished.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(sentMessages.at(-1)?.text, "Final answer after live steer.");
  assert.equal(sentMessages.at(-1)?.reply_to_message_id, 711);
});

test("CodexWorkerPool restarts a normal run after an upstream interrupt before the final answer", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-upstream-restart-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2034,
    topicName: "Upstream restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const runtimeEvents = [];
  const firstAttemptFinished = createDeferred();
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ prompt, imagePaths, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, imagePaths, sessionThreadId });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          finished: firstAttemptFinished.promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: aborted-upstream-thread",
              threadId: "aborted-upstream-thread",
            },
            {
              type: "thread.started",
              thread_id: "aborted-upstream-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Continued after the upstream abort.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Continued after the upstream abort.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "aborted-upstream-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check for more leftovers on the new device.",
    message: {
      message_id: 702,
      message_thread_id: 2034,
    },
  });

  firstAttemptFinished.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: "aborted-upstream-thread",
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "aborted-upstream-thread");
  assert.match(runCalls[1].prompt, /Check for more leftovers on the new device\./u);
  assert.deepEqual(runCalls[1].imagePaths, []);
  assert.deepEqual(runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.attempt",
    "run.recovery",
    "run.attempt",
    "run.finished",
  ]);
  assert.equal(runtimeEvents[1].details.final_answer_seen, false);
  assert.equal(runtimeEvents[2].details.recovery_kind, "upstream-restart");
  assert.equal(runtimeEvents[2].details.same_thread_resume, true);
  assert.equal(runtimeEvents[3].details.requested_thread_id, "aborted-upstream-thread");
  assert.equal(runtimeEvents[3].details.final_answer_seen, true);
  assert.equal(runtimeEvents[4].details.status, "completed");
  assert.equal(runtimeEvents[4].details.thread_id, "aborted-upstream-thread");

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Continued after the upstream abort.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "aborted-upstream-thread");
  assert.equal(reloaded.last_agent_reply, "Continued after the upstream abort.");
});

test("CodexWorkerPool survives two upstream interrupts before a later same-thread retry succeeds", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-upstream-restart-twice-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2035,
    topicName: "Upstream restart twice",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const runtimeEvents = [];
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ prompt, imagePaths, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, imagePaths, sessionThreadId });
      const attempt = runCalls.length;
      const child = { kill() {} };
      if (attempt < 3) {
        return {
          child,
          finished: Promise.resolve({
            exitCode: null,
            signal: "SIGINT",
            threadId: "sticky-upstream-thread",
            warnings: [],
            interrupted: true,
            interruptReason: "upstream",
            abortReason: "interrupted",
            resumeReplacement: null,
          }),
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: sticky-upstream-thread",
              threadId: "sticky-upstream-thread",
            },
            {
              type: "thread.started",
              thread_id: "sticky-upstream-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Recovered from two upstream aborts.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Recovered from two upstream aborts.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "sticky-upstream-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Finish after two consecutive upstream aborts.",
    message: {
      message_id: 703,
      message_thread_id: 2035,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 3);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "sticky-upstream-thread");
  assert.equal(runCalls[2].sessionThreadId, "sticky-upstream-thread");
  assert.deepEqual(runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.attempt",
    "run.recovery",
    "run.attempt",
    "run.recovery",
    "run.attempt",
    "run.finished",
  ]);
  assert.equal(runtimeEvents[1].details.attempt, 1);
  assert.equal(runtimeEvents[2].details.attempt, 1);
  assert.equal(runtimeEvents[3].details.attempt, 2);
  assert.equal(runtimeEvents[4].details.attempt, 2);
  assert.equal(runtimeEvents[5].details.attempt, 3);
  assert.equal(runtimeEvents[3].details.requested_thread_id, "sticky-upstream-thread");
  assert.equal(runtimeEvents[5].details.requested_thread_id, "sticky-upstream-thread");
  assert.equal(runtimeEvents[6].details.status, "completed");
  assert.equal(runtimeEvents[6].details.thread_id, "sticky-upstream-thread");

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Recovered from two upstream aborts.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "sticky-upstream-thread");
});

test("CodexWorkerPool clears stale continuity hints before a fresh rebuild without a prior thread", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-fresh-rebuild-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 20355,
    topicName: "Fresh rebuild",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const continuitySeed = await sessionStore.patch(session, {
    provider_session_id: "stale-provider-session",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "stale-thread",
      session_id: "stale-provider-session",
    },
  });

  const runCalls = [];
  const firstAttemptFinished = createDeferred();
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
    runTask: ({ sessionThreadId, skipThreadHistoryLookup, onEvent }) => {
      runCalls.push({ sessionThreadId, skipThreadHistoryLookup });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          finished: firstAttemptFinished.promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: fresh-rebuild-thread",
              threadId: "fresh-rebuild-thread",
            },
            {
              type: "thread.started",
              thread_id: "fresh-rebuild-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Fresh rebuild reached completion.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Fresh rebuild reached completion.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "fresh-rebuild-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: continuitySeed,
    prompt: "Run a fresh rebuild without the old thread id.",
    message: {
      message_id: 703,
      message_thread_id: 20355,
    },
  });

  firstAttemptFinished.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: null,
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(continuitySeed.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[0].skipThreadHistoryLookup, false);
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);

  const reloaded = await sessionStore.load(continuitySeed.chat_id, continuitySeed.topic_id);
  assert.equal(reloaded.codex_thread_id, "fresh-rebuild-thread");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_agent_reply, "Fresh rebuild reached completion.");
});

test("CodexWorkerPool keeps a captured final answer when upstream aborts after the final message", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-upstream-final-answer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2036,
    topicName: "Upstream final answer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  const runtimeEvents = [];
  let attemptCount = 0;
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ onEvent }) => {
      attemptCount += 1;
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: interrupted-after-final-thread",
              threadId: "interrupted-after-final-thread",
            },
            {
              type: "thread.started",
              thread_id: "interrupted-after-final-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "The final answer was already available.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "The final answer was already available.",
              },
            },
          );

          return {
            exitCode: null,
            signal: "SIGINT",
            threadId: "interrupted-after-final-thread",
            warnings: [],
            interrupted: true,
            interruptReason: "upstream",
            abortReason: "interrupted",
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Keep the final answer even if upstream fails afterward.",
    message: {
      message_id: 704,
      message_thread_id: 2036,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(attemptCount, 1);
  assert.deepEqual(runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.attempt",
    "run.finished",
  ]);
  assert.equal(runtimeEvents[1].details.final_answer_seen, true);
  assert.equal(runtimeEvents[2].details.status, "completed");

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "The final answer was already available.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "interrupted-after-final-thread");
});

test("CodexWorkerPool keeps pending live steer buffered when flush fails", async () => {
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.pendingLiveSteers.set("session-1", {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    replyToMessageId: 123,
  });

  const flushed = await workerPool.flushPendingLiveSteer("session-1", {
    controller: {
      steer() {
        return Promise.resolve({
          ok: false,
          reason: "transport-recovering",
        });
      },
    },
    exchangePrompt: "base",
    state: {
      replyToMessageId: null,
    },
  });

  assert.equal(flushed, false);
  assert.deepEqual(workerPool.pendingLiveSteers.get("session-1"), {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    replyToMessageId: 123,
  });
});

test("CodexWorkerPool requeues pending live steer after a run exits before flush", async () => {
  const session = {
    chat_id: "-1000000",
    topic_id: "77",
    session_key: "session-1",
  };
  const enqueued = [];
  const workerPool = new CodexWorkerPool({
    api: {},
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async load() {
        return session;
      },
    },
    promptQueueStore: {
      async enqueue(currentSession, payload) {
        enqueued.push({ currentSession, payload });
        return { position: 1, size: 1, entry: payload };
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.pendingLiveSteers.set("session-1", {
    attachments: [{ file_path: "/tmp/follow-up.png", is_image: true }],
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    rawPrompt: "follow-up",
    replyToMessageId: 123,
  });

  const requeued = await workerPool.requeuePendingLiveSteer("session-1", {
    session,
  });

  assert.equal(requeued, true);
  assert.equal(workerPool.pendingLiveSteers.has("session-1"), false);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].currentSession, session);
  assert.deepEqual(enqueued[0].payload, {
    rawPrompt: "follow-up",
    prompt: "follow-up",
    attachments: [{ file_path: "/tmp/follow-up.png", is_image: true }],
    replyToMessageId: 123,
  });
});

test("CodexWorkerPool keeps pending live steer when durable requeue is unavailable", async () => {
  const session = {
    chat_id: "-1000000",
    topic_id: "77",
    session_key: "session-1",
  };
  const workerPool = new CodexWorkerPool({
    api: {},
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async load() {
        return session;
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });
  const pending = {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    rawPrompt: "follow-up",
    replyToMessageId: 123,
  };
  workerPool.pendingLiveSteers.set("session-1", pending);

  const requeued = await workerPool.requeuePendingLiveSteer("session-1", {
    session,
  });

  assert.equal(requeued, false);
  assert.equal(workerPool.pendingLiveSteers.get("session-1"), pending);
});

test("CodexWorkerPool keeps pending live steer when durable requeue throws", async () => {
  const session = {
    chat_id: "-1000000",
    topic_id: "77",
    session_key: "session-1",
  };
  const workerPool = new CodexWorkerPool({
    api: {},
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async load() {
        return session;
      },
    },
    promptQueueStore: {
      async enqueue() {
        throw new Error("queue unavailable");
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });
  const pending = {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    rawPrompt: "follow-up",
    replyToMessageId: 123,
  };
  workerPool.pendingLiveSteers.set("session-1", pending);

  await assert.rejects(
    workerPool.requeuePendingLiveSteer("session-1", {
      session,
    }),
    /queue unavailable/u,
  );
  assert.equal(workerPool.pendingLiveSteers.get("session-1"), pending);
});

test("CodexWorkerPool buffers live steer while an active run is between attempts", async () => {
  const session = {
    session_key: "session-1",
    chat_id: "-1000000",
    topic_id: "77",
  };
  const workerPool = new CodexWorkerPool({
    api: {},
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {},
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });
  workerPool.activeRuns.set("session-1", {
    session,
    exchangePrompt: "base",
    state: {
      status: "rebuilding",
      finalizing: false,
    },
  });

  const result = workerPool.steerActiveRun({
    session,
    rawPrompt: "second follow-up",
    message: { message_id: 321 },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "steer-buffered");
  assert.equal(workerPool.pendingLiveSteers.get("session-1").rawPrompt, "second follow-up");
});

test("CodexWorkerPool retries buffered live steer flush across a transient transport recovery", async () => {
  const steerCalls = [];
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.pendingLiveSteers.set("session-1", {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    replyToMessageId: 123,
  });

  const run = {
    controller: {
      steer({ input }) {
        steerCalls.push(input);
        if (steerCalls.length === 1) {
          return Promise.resolve({
            ok: false,
            reason: "transport-recovering",
          });
        }

        return Promise.resolve({
          ok: true,
          reason: "steered",
        });
      },
    },
    exchangePrompt: "base",
    state: {
      finalizing: false,
      replyToMessageId: null,
    },
  };
  workerPool.activeRuns.set("session-1", run);

  const flushed = await workerPool.flushPendingLiveSteer("session-1", run);

  assert.equal(flushed, true);
  assert.equal(steerCalls.length, 2);
  assert.equal(workerPool.pendingLiveSteers.has("session-1"), false);
  assert.equal(run.exchangePrompt, "base\n\nfollow-up");
  assert.equal(run.state.replyToMessageId, 123);
});

test("CodexWorkerPool refuses to buffer live steer after the run is already finalizing", async () => {
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  const session = {
    session_key: "session-2",
  };
  workerPool.activeRuns.set("session-2", {
    controller: null,
    state: {
      finalizing: true,
    },
  });

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "late follow-up",
    message: {
      message_id: 55,
    },
  });

  assert.equal(steered.ok, false);
  assert.equal(steered.reason, "finalizing");
  assert.equal(workerPool.pendingLiveSteers.has("session-2"), false);
});

test("CodexWorkerPool retries transient live steer failures while the run is still active", async () => {
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  const session = {
    session_key: "session-3",
    ui_language: "eng",
  };
  const steerCalls = [];
  const run = {
    exchangePrompt: "base",
    controller: {
      async steer({ input }) {
        steerCalls.push(input);
        if (steerCalls.length < 3) {
          return { ok: false, reason: "steer-failed" };
        }
        return {
          ok: true,
          reason: "steered",
          inputCount: input.length,
        };
      },
    },
    state: {
      finalizing: false,
      replyToMessageId: null,
    },
  };
  workerPool.activeRuns.set(session.session_key, run);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Retry steer after a transient failure.",
    message: {
      message_id: 321,
    },
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steered");
  assert.equal(steerCalls.length, 3);
  assert.match(run.exchangePrompt, /Retry steer after a transient failure\./u);
  assert.equal(run.state.replyToMessageId, 321);
});

test("CodexWorkerPool keeps root thread state when foreign subagent events arrive", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2032,
    topicName: "Foreign thread isolation",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: root-thread",
            threadId: "root-thread",
            isPrimaryThreadEvent: true,
          },
          {
            method: "thread/started",
            params: {
              threadId: "root-thread",
            },
          },
        );
        await onEvent(
          {
            kind: "turn",
            eventType: "turn.started",
            text: "Codex turn started",
            threadId: "root-thread",
            turnId: "root-turn",
            isPrimaryThreadEvent: true,
          },
          {
            method: "turn/started",
            params: {
              threadId: "root-thread",
              turn: { id: "root-turn" },
            },
          },
        );
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: foreign-thread",
            threadId: "foreign-thread",
            isPrimaryThreadEvent: false,
          },
          {
            method: "thread/started",
            params: {
              threadId: "foreign-thread",
            },
          },
        );
        await onEvent(
          {
            kind: "turn",
            eventType: "turn.started",
            text: "Codex turn started",
            threadId: "foreign-thread",
            turnId: "foreign-turn",
            isPrimaryThreadEvent: false,
          },
          {
            method: "turn/started",
            params: {
              threadId: "foreign-thread",
              turn: { id: "foreign-turn" },
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Hint from a subagent.",
            messagePhase: "commentary",
            threadId: "foreign-thread",
            isPrimaryThreadEvent: false,
          },
          {
            method: "item/completed",
            params: {
              threadId: "foreign-thread",
              item: {
                type: "agentMessage",
                text: "Hint from a subagent.",
                phase: "commentary",
              },
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Incorrect subagent final.",
            messagePhase: "final_answer",
            threadId: "foreign-thread",
            isPrimaryThreadEvent: false,
          },
          {
            method: "item/completed",
            params: {
              threadId: "foreign-thread",
              item: {
                type: "agentMessage",
                text: "Incorrect subagent final.",
                phase: "final_answer",
              },
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Root final.",
            messagePhase: "final_answer",
            threadId: "root-thread",
            isPrimaryThreadEvent: true,
          },
          {
            method: "item/completed",
            params: {
              threadId: "root-thread",
              item: {
                type: "agentMessage",
                text: "Root final.",
                phase: "final_answer",
              },
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "root-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Verify foreign thread isolation.",
    message: {
      message_id: 610,
      message_thread_id: 2032,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.codex_thread_id, "root-thread");
  assert.equal(reloaded.last_agent_reply, "Root final.");
  assert.equal(sentMessages.at(-1).text, "Root final.");
  assert.equal(
    editedMessages.some((payload) => /subagent/u.test(payload.text)),
    false,
  );
});

test("CodexWorkerPool keeps main-thread progress visible while hiding internal orchestration noise", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-progress-thought-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2036,
    topicName: "Progress thought",
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            threadId: "thought-thread",
          },
          {
            type: "thread.started",
            thread_id: "thought-thread",
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            messagePhase: "commentary",
            text: "First I will verify the real lifecycle run, then resolve the targeted race.",
            threadId: "thought-thread",
            isPrimaryThreadEvent: true,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              phase: "commentary",
              text: "First I will verify the real lifecycle run, then resolve the targeted race.",
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            messagePhase: "commentary",
            text: "Spawning a subagent to inspect the repo before I continue.",
            threadId: "thought-thread",
            isPrimaryThreadEvent: true,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              phase: "commentary",
              text: "Spawning a subagent to inspect the repo before I continue.",
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            messagePhase: "commentary",
            text: "Reviewing the code and current state.",
            threadId: "thought-thread",
            isPrimaryThreadEvent: true,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              phase: "commentary",
              text: "Reviewing the code and current state.",
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            messagePhase: "final_answer",
            text: "Final answer without leakage.",
            threadId: "thought-thread",
            isPrimaryThreadEvent: true,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              phase: "final_answer",
              text: "Final answer without leakage.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "thought-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Show a normal update without exposing orchestration.",
    message: {
      message_id: 611,
      message_thread_id: 2036,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(
    editedMessages.some((payload) => /subagent|inspect the repo/u.test(payload.text)),
    false,
  );
  assert.equal(
    editedMessages.some((payload) => /Reviewing the code and current state/u.test(payload.text)),
    true,
  );
  assert.equal(sentMessages.at(-1)?.text, "Final answer without leakage.");
  const progressNotes = await sessionStore.loadProgressNotes(session);
  assert.deepEqual(progressNotes, []);
});

test("CodexWorkerPool does not let late live events clobber a completed run back to running", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2031,
    topicName: "Late event race",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "BASE_REPLY",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "BASE_REPLY",
            },
          },
        );

        setTimeout(() => {
          void onEvent(
            {
              kind: "agent_message",
              text: "LATE_REPLY",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "LATE_REPLY",
              },
            },
          );
        }, 0);

        return {
          exitCode: 0,
          signal: null,
          threadId: "late-event-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  workerPool.deliverRunDocuments = async (nextSession) => {
    await sleep(20);
    return {
      successes: [],
      failures: [],
      parked: false,
      session: nextSession,
    };
  };

  await workerPool.startPromptRun({
    session,
    prompt: "Verify the late-event race.",
    message: {
      message_id: 602,
      message_thread_id: 2031,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  const meta = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(meta.last_run_status, "completed");
  assert.equal(
    ["BASE_REPLY", "LATE_REPLY"].includes(meta.last_agent_reply),
    true,
  );
  assert.doesNotMatch(meta.last_agent_reply, /Could not finish the run\./u);

  const exchangeLog = await sessionStore.loadExchangeLog(meta);
  assert.equal(exchangeLog.at(-1).status, "completed");
  assert.equal(exchangeLog.at(-1).assistant_reply, meta.last_agent_reply);
  assert.equal(sentMessages.at(-1).text, meta.last_agent_reply);
});

test("CodexWorkerPool surfaces non-interrupt run failures instead of interrupted text", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 203,
    topicName: "Failure reply",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

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
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.resolve({
        exitCode: 2,
        signal: null,
        threadId: "failed-thread",
        warnings: ["error: unexpected argument '--session-source' found"],
        resumeReplacement: null,
      }),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Error-path check.",
    message: {
      message_id: 602,
      message_thread_id: 203,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.match(finalReply, /Could not finish the run\./u);
  assert.match(finalReply, /unexpected argument '--session-source'/u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /Could not finish the run\./u);
});

test("CodexWorkerPool keeps repeated upstream SIGINT runs as interrupted after two automatic restarts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2032,
    topicName: "Upstream interrupt reply",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const sentMessages = [];
  let attemptCount = 0;
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
    runTask: () => {
      attemptCount += 1;
      return {
        child: { kill() {} },
        finished: Promise.resolve({
          exitCode: null,
          signal: "SIGINT",
          threadId: `upstream-interrupted-thread-${attemptCount}`,
          warnings: [],
          interrupted: true,
          interruptReason: "upstream",
          abortReason: "interrupted",
          resumeReplacement: null,
        }),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Verify neutral interrupt.",
    message: {
      message_id: 603,
      message_thread_id: 2032,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(attemptCount, 3);
  const finalReply = sentMessages.at(-1)?.text || "";
  assert.doesNotMatch(finalReply, /Could not finish the run\./u);
  assert.match(finalReply, /The run was interrupted before a final answer\./u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.codex_thread_id, "upstream-interrupted-thread-3");
  assert.match(reloaded.last_agent_reply, /The run was interrupted before a final answer\./u);
});

test("CodexWorkerPool localizes failure replies to English when the session UI language is ENG", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2031,
    topicName: "English failure",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    ui_language: "eng",
  });

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
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.resolve({
        exitCode: 2,
        signal: null,
        threadId: "failed-thread-eng",
        warnings: ["boom"],
        resumeReplacement: null,
      }),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check the failure path.",
    message: {
      message_id: 603,
      message_thread_id: 2031,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.match(finalReply, /Could not finish the run\./u);
  assert.match(finalReply, /Error: boom/u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /Could not finish the run\./u);
});

test("CodexWorkerPool treats a starting run as busy before progress delivery completes", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 204,
    topicName: "Starting busy guard",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const progressDeferred = createDeferred();
  let runStarted = false;
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          await progressDeferred.promise;
        }

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
    runTask: ({ onEvent }) => {
      runStarted = true;
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "Codex thread started: guard-thread",
              threadId: "guard-thread",
            },
            {
              type: "thread.started",
              thread_id: "guard-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "guard complete",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "guard complete",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "guard-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const firstStart = workerPool.startPromptRun({
    session,
    prompt: "guard-first",
    message: {
      message_thread_id: 204,
    },
  });

  await waitFor(() => sentMessages.some((payload) => payload.text === INITIAL_PROGRESS_TEXT));
  const secondStart = await workerPool.startPromptRun({
    session,
    prompt: "guard-second",
    message: {
      message_thread_id: 204,
    },
  });

  assert.deepEqual(secondStart, { ok: false, reason: "busy" });
  assert.equal(runStarted, false);

  progressDeferred.resolve();
  await firstStart;
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runStarted, true);
});

test("CodexWorkerPool shutdown waits for a reserved start to become interruptible", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 205,
    topicName: "Shutdown reserved start",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const progressDeferred = createDeferred();
  const runDeferred = createDeferred();
  const sentMessages = [];
  let runStarted = false;
  let killSignals = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          await progressDeferred.promise;
        }

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
    runTask: () => {
      runStarted = true;
      return {
        child: {
          kill(signal) {
            killSignals.push(signal);
            runDeferred.resolve({
              exitCode: null,
              signal,
              threadId: null,
              warnings: [],
              resumeReplacement: null,
            });
          },
        },
        finished: runDeferred.promise,
      };
    },
  });

  const startPromise = workerPool.startPromptRun({
    session,
    prompt: "guard-shutdown",
    message: {
      message_thread_id: 205,
    },
  });

  await waitFor(() => sentMessages.some((payload) => payload.text === INITIAL_PROGRESS_TEXT));
  const shutdownPromise = workerPool.shutdown();
  let shutdownFinished = false;
  shutdownPromise.then(() => {
    shutdownFinished = true;
  });

  await sleep(30);
  assert.equal(shutdownFinished, false);
  assert.equal(runStarted, false);

  progressDeferred.resolve();
  await shutdownPromise;
  await startPromise;

  assert.equal(runStarted, false);
  assert.deepEqual(killSignals, []);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "interrupted");
});

test("CodexWorkerPool does not interrupt runs that already finished finalization work", async () => {
  const workerPool = new CodexWorkerPool({
    api: {},
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {},
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.activeRuns.set("finished-session", {
    state: {
      status: "completed",
      interruptRequested: false,
      progress: { queueUpdate() {} },
    },
    child: {
      kill() {
        throw new Error("should not kill a completed run");
      },
    },
  });

  assert.equal(workerPool.interrupt("finished-session"), false);
});

test("CodexWorkerPool keeps a completed final answer even if interrupt lands late", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2041,
    topicName: "Late interrupt",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  const deferred = createDeferred();
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "Completed final answer.",
            messagePhase: "final_answer",
            isPrimaryThreadEvent: true,
          },
          null,
        );
        deferred.resolve();
        await sleep(20);
        return {
          exitCode: 0,
          signal: null,
          threadId: "late-interrupt-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "late-interrupt",
    message: {
      message_id: 31,
      message_thread_id: 2041,
    },
  });

  await deferred.promise;
  assert.equal(workerPool.interrupt(session.session_key), true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_agent_reply, "Completed final answer.");
  assert.equal(sentMessages.at(-1).text, "Completed final answer.");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import {
  waitFor,
} from "../test-support/worker-pool-fixtures.js";

const INITIAL_PROGRESS_TEXT = "...";

test("CodexWorkerPool defaults to host-aware exec-json backend selection when no runner is injected", () => {
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

  assert.equal(workerPool.runTask.name, "hostAwareRunTask");
});

test("CodexWorkerPool rejects managed goal starts outside app-server-v2 backend", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-goal-backend-guard-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 176,
    topicName: "Goal backend guard",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        throw new Error("must not send progress for rejected goalStart");
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask() {
      throw new Error("must not dispatch goalStart through exec-json");
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "ship safely",
    rawPrompt: "/goal ship safely",
    goalStart: {
      objective: "ship safely",
      status: "active",
    },
    message: {
      message_id: 1760,
      message_thread_id: 176,
    },
  });

  assert.equal(started.ok, false);
  assert.equal(started.reason, "goal-backend-not-app-server-v2");
  assert.equal(serviceState.acceptedPrompts, 0);
  assert.equal(workerPool.getActiveRun(session.session_key), null);
});

test("CodexWorkerPool passes resolved Agent model and reasoning into runTask", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 177,
    topicName: "Runtime profile test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    agent_model_override: "gpt-5.4-mini",
    agent_reasoning_effort_override: "high",
  });

  const runCalls = [];
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
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    globalCodexSettingsStore: {
      async load() {
        return {
          agent_model: "gpt-5.2",
          agent_reasoning_effort: "low",
        };
      },
    },
    runTask({ model, reasoningEffort, onEvent }) {
      runCalls.push({ model, reasoningEffort });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "thread started",
              threadId: "runtime-thread",
            },
            {
              type: "thread.started",
              thread_id: "runtime-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "runtime ok",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "runtime ok",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "runtime-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check runtime profile.",
    message: {
      message_id: 44,
      message_thread_id: 177,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    },
  ]);
});

test("CodexWorkerPool refreshes app-server-v2 threads after skill inventory changes", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-developer-context-refresh-"),
  );
  const hostRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-workflow-skills-"),
  );
  await fs.mkdir(path.join(hostRoot, ".teledex", "workflow-skills", "goal-prompt-writer"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(hostRoot, ".teledex", "workflow-skills", "goal-prompt-writer", "SKILL.md"),
    [
      "---",
      "name: goal-prompt-writer",
      "description: Use this skill for /goal prompts.",
      "---",
      "# Goal Prompt Writer",
      "",
    ].join("\n"),
    "utf8",
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 1772,
    topicName: "Developer context refresh",
    createdVia: "test",
    workspaceBinding: {
      repo_root: "/path/to/worker-workspace",
      cwd: "/path/to/worker-workspace",
      branch: "main",
      worktree_path: "/path/to/worker-workspace",
    },
  });
  session = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    codex_thread_id: "old-thread",
    codex_rollout_path: "/tmp/old-rollout.jsonl",
    codex_thread_developer_context_hash: "sha256:old",
    last_compacted_at: "2026-05-13T00:00:00.000Z",
    last_compaction_reason: "context-window-recovery",
  });
  await sessionStore.writeSessionText(
    session,
    "active-brief.md",
    "# Active brief\n\nSENTINEL_SKILL_REFRESH\n",
  );

  const runCalls = [];
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
      workspaceRootPath: hostRoot,
      codexBinPath: "codex",
      codexGatewayBackend: "app-server-v2",
      codexModel: "gpt-5.4",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask({ prompt, sessionThreadId, skipThreadHistoryLookup, onRuntimeState, onEvent }) {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onRuntimeState({ threadId: "new-thread" });
          await onEvent({
            kind: "agent_message",
            text: "refreshed",
          });
          return {
            ok: true,
            exitCode: 0,
            signal: null,
            threadId: "new-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Recreate it once more using the skill guidance.",
    message: {
      message_id: 17720,
      message_thread_id: 1772,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[0].skipThreadHistoryLookup, true);
  assert.match(runCalls[0].prompt, /older developer context or skill inventory/u);
  assert.match(runCalls[0].prompt, /SENTINEL_SKILL_REFRESH/u);
  const saved = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(saved.codex_thread_id, "new-thread");
  assert.match(saved.codex_thread_developer_context_hash, /^sha256:/u);
  assert.notEqual(saved.codex_thread_developer_context_hash, "sha256:old");
});

test("CodexWorkerPool supports programmatic starts without a Telegram message object", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-programmatic-start-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 1771,
    topicName: "Programmatic start",
    createdVia: "test",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
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
          text: "Programmatic run finished.",
          messagePhase: "final_answer",
        });
        return {
          backend: "exec-json",
          ok: true,
          exitCode: 0,
          signal: null,
          threadId: "programmatic-thread",
          warnings: [],
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Run without a Telegram message object.",
  });
  assert.equal(started.ok, true);
  assert.equal(started.topicId, session.topic_id);

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);
  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
});

test("CodexWorkerPool rotates thread continuity when stored runtime profile differs", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexConfigRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-config-"),
  );
  const codexConfigPath = path.join(codexConfigRoot, "config.toml");
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(codexConfigRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          visibility: "list",
          priority: 0,
          default_reasoning_level: "xhigh",
          supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
        },
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          visibility: "list",
          priority: 1,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
        },
      ],
    })}\n`,
    "utf8",
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 178,
    topicName: "Runtime profile rotation test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    provider_session_id: "old-provider",
    codex_thread_id: "old-thread",
    codex_thread_model: "gpt-5.4",
    codex_thread_reasoning_effort: "medium",
    codex_rollout_path: "/tmp/old-rollout.jsonl",
    last_context_snapshot: {
      session_id: "old-provider",
      thread_id: "old-thread",
      rollout_path: "/tmp/old-rollout.jsonl",
    },
  });

  const runCalls = [];
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
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    globalCodexSettingsStore: {
      async load() {
        return {
          agent_model: "gpt-5.5",
          agent_reasoning_effort: "xhigh",
        };
      },
    },
    runTask({
      model,
      reasoningEffort,
      sessionThreadId,
      providerSessionId,
      knownRolloutPath,
      skipThreadHistoryLookup,
      onEvent,
    }) {
      runCalls.push({
        model,
        reasoningEffort,
        sessionThreadId,
        providerSessionId,
        knownRolloutPath,
        skipThreadHistoryLookup,
      });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent({
            kind: "thread",
            eventType: "thread.started",
            text: "thread started",
            threadId: "new-thread",
          });
          await onEvent({
            kind: "agent_message",
            text: "rotated ok",
          });
          return {
            exitCode: 0,
            signal: null,
            threadId: "new-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check runtime profile rotation.",
    message: {
      message_id: 45,
      message_thread_id: 178,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sessionThreadId: null,
      providerSessionId: null,
      knownRolloutPath: null,
      skipThreadHistoryLookup: true,
    },
  ]);

  const stored = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(stored.codex_thread_id, "new-thread");
  assert.equal(stored.provider_session_id, null);
  assert.equal(stored.codex_rollout_path, null);
  assert.equal(stored.last_context_snapshot, null);
  assert.equal(stored.codex_thread_model, "gpt-5.5");
  assert.equal(stored.codex_thread_reasoning_effort, "xhigh");
  assert.equal(stored.last_run_model, "gpt-5.5");
  assert.equal(stored.last_run_reasoning_effort, "xhigh");
});

test("CodexWorkerPool rotates unprofiled legacy threads when an explicit model override is active", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexConfigRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-config-"),
  );
  const codexConfigPath = path.join(codexConfigRoot, "config.toml");
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(codexConfigRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 0 },
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 1 },
      ],
    })}\n`,
    "utf8",
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 179,
    topicName: "Legacy runtime profile rotation test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    provider_session_id: "legacy-provider",
    codex_thread_id: "legacy-thread",
    codex_rollout_path: "/tmp/legacy-rollout.jsonl",
    last_context_snapshot: {
      session_id: "legacy-provider",
      thread_id: "legacy-thread",
      rollout_path: "/tmp/legacy-rollout.jsonl",
    },
  });

  const runCalls = [];
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
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    globalCodexSettingsStore: {
      async load() {
        return { agent_model: "gpt-5.5" };
      },
    },
    runTask({ model, sessionThreadId, skipThreadHistoryLookup, onEvent }) {
      runCalls.push({ model, sessionThreadId, skipThreadHistoryLookup });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent({
            kind: "thread",
            eventType: "thread.started",
            text: "thread started",
            threadId: "legacy-new-thread",
          });
          await onEvent({
            kind: "agent_message",
            text: "legacy rotated ok",
          });
          return {
            exitCode: 0,
            signal: null,
            threadId: "legacy-new-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check legacy runtime profile rotation.",
    message: {
      message_id: 46,
      message_thread_id: 179,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.5",
      sessionThreadId: null,
      skipThreadHistoryLookup: true,
    },
  ]);
});

test("CodexWorkerPool clears the active run slot when startup persistence fails", async () => {
  const deleteCalls = [];
  const session = {
    session_key: "-1000000:1701",
    chat_id: "-1000000",
    topic_id: "1701",
    ui_language: "eng",
    workspace_binding: {
      cwd: "/path/to/workspace",
    },
  };
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
      async deleteMessage(payload) {
        deleteCalls.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async patch() {
        throw new Error("session meta write failed");
      },
    },
    serviceState,
    runTask() {
      throw new Error("runTask should not start when startup persistence fails");
    },
  });

  await assert.rejects(
    workerPool.startPromptRun({
      session,
      prompt: "Verify early-start cleanup.",
      message: {
        message_id: 91,
        message_thread_id: 1701,
      },
    }),
    /session meta write failed/u,
  );

  assert.equal(workerPool.getActiveRun(session.session_key), null);
  assert.equal(workerPool.getActiveOrStartingRunCount(), 0);
  assert.deepEqual(workerPool.canStart(session.session_key), { ok: true });
  assert.equal(serviceState.activeRunCount, 0);
  assert.equal(deleteCalls.length, 1);

  await workerPool.shutdown();
});

test("CodexWorkerPool returns busy before resolving an unavailable host", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 1702,
    topicName: "Busy before host resolution",
    createdVia: "command/new",
    executionHostId: "workerz",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  let hostResolutionCount = 0;
  const workerPool = new CodexWorkerPool({
    api: {},
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
    hostRegistryService: {
      async resolveSessionExecution() {
        hostResolutionCount += 1;
        return {
          ok: false,
          hostId: "workerz",
          hostLabel: "workerz",
          failureReason: "host-unavailable",
        };
      },
    },
    runTask() {
      throw new Error("runTask should not start for a busy session");
    },
  });
  workerPool.activeRuns.set(session.session_key, { sessionKey: session.session_key });

  const result = await workerPool.startPromptRun({
    session,
    prompt: "follow-up while active",
    message: {
      message_id: 92,
      message_thread_id: 1702,
    },
  });

  assert.deepEqual(result, { ok: false, reason: "busy" });
  assert.equal(hostResolutionCount, 0);
});

test("CodexWorkerPool reserves a session before async host resolution", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 1703,
    topicName: "Concurrent start reservation",
    createdVia: "command/new",
    executionHostId: "workerz",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });

  let resolveHost;
  let hostResolutionCount = 0;
  const hostResolution = new Promise((resolve) => {
    resolveHost = resolve;
  });
  const workerPool = new CodexWorkerPool({
    api: {},
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
    hostRegistryService: {
      async resolveSessionExecution() {
        hostResolutionCount += 1;
        return hostResolution;
      },
    },
    runTask() {
      throw new Error("runTask should not start for unavailable host");
    },
  });

  const firstStart = workerPool.startPromptRun({
    session,
    prompt: "first concurrent start",
    message: {
      message_id: 93,
      message_thread_id: 1703,
    },
  });
  await waitFor(() => hostResolutionCount === 1);
  assert.equal(workerPool.startingRuns.has(session.session_key), true);

  const secondStart = await workerPool.startPromptRun({
    session,
    prompt: "second concurrent start",
    message: {
      message_id: 94,
      message_thread_id: 1703,
    },
  });

  assert.deepEqual(secondStart, { ok: false, reason: "busy" });
  assert.equal(hostResolutionCount, 1);

  resolveHost({
    ok: false,
    hostId: "workerz",
    hostLabel: "workerz",
    failureReason: "host-unavailable",
  });

  assert.deepEqual(await firstStart, {
    ok: false,
    reason: "host-unavailable",
    hostId: "workerz",
    hostLabel: "workerz",
    failureReason: "host-unavailable",
  });
  assert.equal(workerPool.getActiveOrStartingRunCount(), 0);
  assert.deepEqual(workerPool.canStart(session.session_key), { ok: true });
});

test("CodexWorkerPool launches Codex with a reasoning level supported by the resolved model", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexConfigRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-config-"),
  );
  const codexConfigPath = path.join(codexConfigRoot, "config.toml");
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(codexConfigRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "gpt-5.4-mini",
          display_name: "GPT-5.4-Mini",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium" },
            { effort: "high" },
          ],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 178,
    topicName: "Runtime profile compatibility",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    agent_model_override: "gpt-5.4-mini",
  });

  const runCalls = [];
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
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    globalCodexSettingsStore: {
      async load() {
        return {
          agent_model: null,
          agent_reasoning_effort: "xhigh",
        };
      },
    },
    runTask({ model, reasoningEffort, onEvent }) {
      runCalls.push({ model, reasoningEffort });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "thread started",
              threadId: "runtime-thread-2",
            },
            {
              type: "thread.started",
              thread_id: "runtime-thread-2",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "runtime ok",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "runtime ok",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "runtime-thread-2",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check runtime profile compatibility.",
    message: {
      message_id: 45,
      message_thread_id: 178,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    },
  ]);
});

test("CodexWorkerPool uses the bound host Codex catalog when choosing the runtime model", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const localCodexRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-local-config-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-state-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry-state.toml");
  const remoteModelsCachePath = path.join(
    stateRoot,
    "teledex-context",
    "hosts",
    "workera",
    "rendered",
    "models_cache.json",
  );
  const localCodexConfigPath = path.join(localCodexRoot, "config.toml");
  await fs.writeFile(localCodexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(localCodexRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 1 },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await fs.mkdir(path.dirname(remoteModelsCachePath), { recursive: true });
  await fs.writeFile(
    remoteModelsCachePath,
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list", priority: 1 },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 179,
    topicName: "Runtime profile remote host",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
    executionHostId: "workera",
    executionHostLabel: "workera",
  });

  const runCalls = [];
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
      codexConfigPath: localCodexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    hostRegistryService: {
      currentHostId: "local",
      registryPath,
      async getHost(hostId) {
        return hostId === "workera"
          ? {
            host_id: "workera",
            codex_config_path: "/home/workera/.codex/config.toml",
          }
          : null;
      },
    },
    runTask({ model, onEvent }) {
      runCalls.push({ model });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "thread started",
              threadId: "runtime-thread-remote",
            },
            {
              type: "thread.started",
              thread_id: "runtime-thread-remote",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "runtime ok",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "runtime ok",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "runtime-thread-remote",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check remote runtime profile catalog.",
    message: {
      message_id: 46,
      message_thread_id: 179,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.4-mini",
    },
  ]);
});

test("CodexWorkerPool bootstraps a fresh run from active brief after compaction", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 244,
    topicName: "Fresh brief bootstrap test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const compactedSession = await sessionStore.patch(session, {
    last_compacted_at: "2026-04-01T15:30:00.000Z",
    last_compaction_reason: "command/compact",
    exchange_log_entries: 4,
    last_user_prompt: "Please continue the compact work on the Telegram gateway.",
    last_agent_reply: "I fixed the stale thread reset and we can continue.",
    last_run_status: "completed",
    provider_session_id: "legacy-provider-after-compact",
    codex_rollout_path: "/tmp/legacy-rollout-after-compact.jsonl",
    last_context_snapshot: {
      session_id: "legacy-provider-after-compact",
      rollout_path: "/tmp/legacy-rollout-after-compact.jsonl",
    },
  });
  await sessionStore.writeSessionText(
    compactedSession,
    "active-brief.md",
    [
      "# Active brief",
      "",
      "updated_from_reason: command/compact",
      "session_key: -1000000:244",
      "topic_name: Fresh brief bootstrap test",
      "cwd: /path/to/workspace",
      "",
      "## Workspace context",
      "- repo_root: /path/to/workspace",
      "- focus: teledex compact flow",
      "",
      "## Current state",
      "- Manual compact just refreshed the recovery brief.",
      "",
      "## Open work",
      "- Make the next fresh run continue cleanly from this brief.",
      "",
      "## Latest exchange",
      "- User wants stronger continuity after /compact.",
    ].join("\n"),
  );

  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const runCalls = [];
  const runTask = ({
    prompt,
    baseInstructions,
    sessionThreadId,
    skipThreadHistoryLookup,
    onEvent,
  }) => {
    runCalls.push({ prompt, baseInstructions, sessionThreadId, skipThreadHistoryLookup });
    return {
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            text: "Codex thread started: fresh-brief-thread",
            threadId: "fresh-brief-thread",
          },
          {
            type: "thread.started",
            thread_id: "fresh-brief-thread",
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Continued from the refreshed brief.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Continued from the refreshed brief.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "fresh-brief-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    };
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
    sessionCompactor: null,
    runTask,
  });

  await workerPool.startPromptRun({
    session: compactedSession,
    prompt: "Continue the compact improvements.",
    message: {
      message_id: 199,
      message_thread_id: 244,
    },
  });

  await waitFor(() => workerPool.getActiveRun(compactedSession.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[0].skipThreadHistoryLookup, true);
  assert.doesNotMatch(runCalls[0].prompt, /Context:/u);
  assert.match(runCalls[0].baseInstructions, /Context:/u);
  assert.match(
    runCalls[0].prompt,
    /This Telegram topic has no live Codex thread, but it does have a stored active brief\./u,
  );
  assert.match(runCalls[0].prompt, /last_compaction_reason: command\/compact/u);
  assert.match(runCalls[0].prompt, /exchange_log_entries: 4/u);
  assert.match(runCalls[0].prompt, /## Active brief/u);
  assert.match(runCalls[0].prompt, /focus: teledex compact flow/u);
  assert.match(runCalls[0].prompt, /## Latest user request/u);
  assert.match(runCalls[0].prompt, /Continue the compact improvements\./u);

  const meta = await sessionStore.load(compactedSession.chat_id, compactedSession.topic_id);
  assert.equal(meta.codex_thread_id, "fresh-brief-thread");
  assert.equal(meta.provider_session_id, null);
  assert.equal(meta.codex_rollout_path, null);
  assert.equal(meta.last_context_snapshot, null);
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.last_agent_reply, "Continued from the refreshed brief.");

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(sentMessages.at(-1).text, "Continued from the refreshed brief.");
  assert.equal(deletedMessages.length, 1);
  assert.ok(editedMessages.length >= 0);
});

test("CodexWorkerPool keeps fresh-brief bootstrap for managed goal runs", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 245,
    topicName: "Fresh brief goal bootstrap test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const compactedSession = await sessionStore.patch(session, {
    codex_backend: "app-server-v2",
    last_run_backend: "app-server-v2",
    last_compacted_at: "2026-05-12T22:36:44.522Z",
    last_compaction_reason: "context-window-recovery",
    exchange_log_entries: 683,
    codex_thread_id: null,
    codex_rollout_path: null,
    provider_session_id: null,
  });
  await sessionStore.writeSessionText(
    compactedSession,
    "active-brief.md",
    [
      "# Active brief",
      "",
      "updated_from_reason: context-window-recovery",
      "session_key: -1000000:245",
      "topic_name: Fresh brief goal bootstrap test",
      "",
      "## Current state",
      "- The previous materialized thread was cleared after compaction.",
    ].join("\n"),
  );

  const runCalls = [];
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
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask({
      prompt,
      sessionThreadId,
      skipThreadHistoryLookup,
      goalStart,
      onEvent,
    }) {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup, goalStart });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "Codex thread started: fresh-goal-thread",
              threadId: "fresh-goal-thread",
            },
            {
              type: "thread.started",
              thread_id: "fresh-goal-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "Started managed goal from the active brief.",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Started managed goal from the active brief.",
              },
            },
          );
          return {
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

  await workerPool.startPromptRun({
    session: compactedSession,
    prompt: "Refactor the gateway modules.",
    rawPrompt: "/goal Refactor the gateway modules.",
    message: {
      message_id: 200,
      message_thread_id: 245,
    },
    goalStart: {
      objective: "Refactor the gateway modules.",
      status: "active",
      tokenBudget: undefined,
    },
  });

  await waitFor(() => workerPool.getActiveRun(compactedSession.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[0].skipThreadHistoryLookup, true);
  assert.deepEqual(runCalls[0].goalStart, {
    objective: "Refactor the gateway modules.",
    status: "active",
    tokenBudget: undefined,
  });
  assert.match(
    runCalls[0].prompt,
    /This Telegram topic has no live Codex thread, but it does have a stored active brief\./u,
  );
  assert.match(runCalls[0].prompt, /updated_from_reason: context-window-recovery/u);
  assert.match(runCalls[0].prompt, /Refactor the gateway modules\./u);

  const meta = await sessionStore.load(compactedSession.chat_id, compactedSession.topic_id);
  assert.equal(meta.codex_thread_id, "fresh-goal-thread");
  assert.equal(meta.last_run_status, "completed");
});

test("CodexWorkerPool compacts and retries once after exec-json context-window failure", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-context-window-recovery-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 245,
    topicName: "Context window recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "oversized-thread",
    last_user_prompt: "old huge prompt",
    last_agent_reply: "old huge reply",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-04-24T12:00:00.000Z",
    status: "completed",
    user_prompt: "old huge prompt",
    assistant_reply: "old huge reply",
  });

  const sentMessages = [];
  const runCalls = [];
  const compactCalls = [];
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
    sessionCompactor: {
      async compact(meta, { reason }) {
        compactCalls.push({ sessionKey: meta.session_key, reason });
        await sessionStore.writeSessionText(
          meta,
          "active-brief.md",
          "# Active brief\n\nRecovered after context window pressure.\n",
        );
        const compacted = await sessionStore.patch(meta, {
          last_compacted_at: "2026-04-24T12:01:00.000Z",
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
    runTask: ({
      prompt,
      sessionThreadId,
      skipThreadHistoryLookup,
      onRuntimeState,
      onEvent,
    }) => {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup });
      if (runCalls.length === 1) {
        return {
          child: { kill() {} },
          finished: Promise.resolve({
            ok: false,
            backend: "exec-json",
            exitCode: 1,
            signal: null,
            threadId: "oversized-thread",
            warnings: [
              "Codex exec failed: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            ],
            abortReason: "exec_stream_error",
          }),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({ threadId: "fresh-after-compact" });
          await onEvent({
            kind: "agent_message",
            eventType: "turn.completed",
            text: "Recovered answer.",
            messagePhase: "final_answer",
          });
          return {
            ok: true,
            backend: "exec-json",
            exitCode: 0,
            signal: null,
            threadId: "fresh-after-compact",
            warnings: [],
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue after oversized context.",
    message: {
      message_id: 245,
      message_thread_id: 245,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].reason, "context-window-recovery");
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "oversized-thread");
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);
  assert.match(runCalls[1].prompt, /stored active brief/u);
  assert.match(runCalls[1].prompt, /Recovered after context window pressure/u);
  assert.match(runCalls[1].prompt, /Continue after oversized context/u);

  const meta = await sessionStore.load(
    resumedSession.chat_id,
    resumedSession.topic_id,
  );
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.codex_thread_id, "fresh-after-compact");
  assert.equal(meta.last_compaction_reason, "context-window-recovery");
  assert.equal(meta.last_agent_reply, "Recovered answer.");
  assert.equal(sentMessages.at(-1).text, "Recovered answer.");
});

test("CodexWorkerPool compacts and retries after exec-json orphan tool-output corruption", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-thread-corruption-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 247,
    topicName: "Thread corruption recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "corrupt-thread",
    last_user_prompt: "previous prompt",
    last_agent_reply: "previous reply",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-04-26T23:20:00.000Z",
    status: "completed",
    user_prompt: "previous prompt",
    assistant_reply: "previous reply",
  });

  const sentMessages = [];
  const runCalls = [];
  const compactCalls = [];
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
    sessionCompactor: {
      async compact(meta, { reason }) {
        compactCalls.push({ sessionKey: meta.session_key, reason });
        await sessionStore.writeSessionText(
          meta,
          "active-brief.md",
          "# Active brief\n\nRecovered after Codex thread corruption.\n",
        );
        const compacted = await sessionStore.patch(meta, {
          last_compacted_at: "2026-04-26T23:21:00.000Z",
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
    runTask: ({
      prompt,
      sessionThreadId,
      skipThreadHistoryLookup,
      onRuntimeState,
      onEvent,
    }) => {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup });
      if (runCalls.length === 1) {
        return {
          child: { kill() {} },
          finished: Promise.resolve({
            ok: false,
            backend: "exec-json",
            exitCode: 1,
            signal: null,
            threadId: "corrupt-thread",
            warnings: [
              `Codex exec failed: {
                "type": "error",
                "error": {
                  "type": "invalid_request_error",
                  "message": "No tool call found for function call output with call_id call_UiILq3mzXeeZwpxPOzSMZ64z.",
                  "param": "input"
                },
                "status": 400
              }`,
            ],
            abortReason: "exec_stream_error",
          }),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({ threadId: "fresh-after-corruption" });
          await onEvent({
            kind: "agent_message",
            eventType: "turn.completed",
            text: "Recovered from thread corruption.",
            messagePhase: "final_answer",
          });
          return {
            ok: true,
            backend: "exec-json",
            exitCode: 0,
            signal: null,
            threadId: "fresh-after-corruption",
            warnings: [],
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue after orphan tool output.",
    message: {
      message_id: 247,
      message_thread_id: 247,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].reason, "thread-corruption-recovery");
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "corrupt-thread");
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);
  assert.match(runCalls[1].prompt, /stored active brief/u);
  assert.match(runCalls[1].prompt, /Recovered after Codex thread corruption/u);
  assert.match(runCalls[1].prompt, /Continue after orphan tool output/u);

  const meta = await sessionStore.load(
    resumedSession.chat_id,
    resumedSession.topic_id,
  );
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.codex_thread_id, "fresh-after-corruption");
  assert.equal(meta.last_compaction_reason, "thread-corruption-recovery");
  assert.equal(meta.last_agent_reply, "Recovered from thread corruption.");
  assert.equal(sentMessages.at(-1).text, "Recovered from thread corruption.");
});

test("CodexWorkerPool compacts and retries after resumed exec-json websocket stream failure", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-resume-stream-failure-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 248,
    topicName: "Resume stream recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "bloated-thread",
    last_user_prompt: "previous prompt",
    last_agent_reply: "previous reply",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-04-30T12:46:19.000Z",
    status: "completed",
    user_prompt: "previous prompt",
    assistant_reply: "previous reply",
  });

  const sentMessages = [];
  const runCalls = [];
  const compactCalls = [];
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
    sessionCompactor: {
      async compact(meta, { reason }) {
        compactCalls.push({ sessionKey: meta.session_key, reason });
        await sessionStore.writeSessionText(
          meta,
          "active-brief.md",
          "# Active brief\n\nRecovered after Codex resume stream failure.\n",
        );
        const compacted = await sessionStore.patch(meta, {
          last_compacted_at: "2026-04-30T13:23:00.000Z",
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
    runTask: ({
      prompt,
      sessionThreadId,
      skipThreadHistoryLookup,
      onRuntimeState,
      onEvent,
    }) => {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup });
      if (runCalls.length === 1) {
        return {
          child: { kill() {} },
          finished: Promise.resolve({
            ok: false,
            backend: "exec-json",
            exitCode: 1,
            signal: null,
            threadId: "bloated-thread",
            warnings: [
              "Codex exec failed: Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)",
            ],
            abortReason: "exec_stream_error",
          }),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({ threadId: "fresh-after-resume-stream-failure" });
          await onEvent({
            kind: "agent_message",
            eventType: "turn.completed",
            text: "Recovered from resume stream failure.",
            messagePhase: "final_answer",
          });
          return {
            ok: true,
            backend: "exec-json",
            exitCode: 0,
            signal: null,
            threadId: "fresh-after-resume-stream-failure",
            warnings: [],
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue after resume stream failure.",
    message: {
      message_id: 248,
      message_thread_id: 248,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].reason, "thread-corruption-recovery");
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "bloated-thread");
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);
  assert.match(runCalls[1].prompt, /stored active brief/u);
  assert.match(runCalls[1].prompt, /Recovered after Codex resume stream failure/u);
  assert.match(runCalls[1].prompt, /Continue after resume stream failure/u);

  const meta = await sessionStore.load(
    resumedSession.chat_id,
    resumedSession.topic_id,
  );
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.codex_thread_id, "fresh-after-resume-stream-failure");
  assert.equal(meta.last_compaction_reason, "thread-corruption-recovery");
  assert.equal(meta.last_agent_reply, "Recovered from resume stream failure.");
  assert.equal(sentMessages.at(-1).text, "Recovered from resume stream failure.");
});

test("CodexWorkerPool compacts and retries when exec-json throws context-window failure", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-context-window-throw-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 989,
    topicName: "Thrown context recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "throwing-oversized-thread",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-04-24T12:00:00.000Z",
    status: "completed",
    user_prompt: "old prompt",
    assistant_reply: "old reply",
  });

  const sentMessages = [];
  const runCalls = [];
  const compactCalls = [];
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
    sessionCompactor: {
      async compact(meta, { reason }) {
        compactCalls.push({ sessionKey: meta.session_key, reason });
        await sessionStore.writeSessionText(
          meta,
          "active-brief.md",
          "# Active brief\n\nRecovered from thrown context-window error.\n",
        );
        const compacted = await sessionStore.patch(meta, {
          last_compacted_at: "2026-04-24T12:02:00.000Z",
          last_compaction_reason: reason,
          codex_thread_id: null,
          provider_session_id: null,
          codex_rollout_path: null,
          last_context_snapshot: null,
        });
        return { session: compacted };
      },
    },
    runTask({ prompt, sessionThreadId, skipThreadHistoryLookup, onRuntimeState, onEvent }) {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup });
      if (runCalls.length === 1) {
        throw new Error("context_length_exceeded: input exceeds the model context window");
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({ threadId: "fresh-after-thrown-compact" });
          await onEvent({
            kind: "agent_message",
            eventType: "turn.completed",
            text: "Recovered from thrown context.",
            messagePhase: "final_answer",
          });
          return {
            ok: true,
            backend: "exec-json",
            exitCode: 0,
            signal: null,
            threadId: "fresh-after-thrown-compact",
            warnings: [],
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue after thrown context window.",
    message: {
      message_id: 246,
      message_thread_id: 246,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].reason, "context-window-recovery");
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "throwing-oversized-thread");
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);
  assert.match(runCalls[1].prompt, /Recovered from thrown context-window error/u);
  assert.match(runCalls[1].prompt, /Continue after thrown context window/u);

  const meta = await sessionStore.load(
    resumedSession.chat_id,
    resumedSession.topic_id,
  );
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.codex_thread_id, "fresh-after-thrown-compact");
  assert.equal(meta.last_compaction_reason, "context-window-recovery");
  assert.equal(meta.last_agent_reply, "Recovered from thrown context.");
  assert.equal(sentMessages.at(-1).text, "Recovered from thrown context.");
});

test("CodexWorkerPool preserves fresh-brief bootstrap after a host-unavailable post-compact attempt", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 2441,
    topicName: "Fresh brief host retry test",
    createdVia: "command/new",
    executionHostId: "workerz",
    executionHostLabel: "workerz",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  const compactedSession = await sessionStore.patch(session, {
    last_compacted_at: "2026-04-01T15:30:00.000Z",
    last_compaction_reason: "command/compact",
    exchange_log_entries: 4,
    last_user_prompt: "Please continue once workerz is back.",
    last_agent_reply: "Waiting for the compacted fresh start on workerz.",
    last_run_status: null,
    last_run_started_at: null,
    last_run_finished_at: null,
    codex_thread_id: null,
    provider_session_id: null,
    codex_rollout_path: null,
    last_context_snapshot: null,
  });
  await sessionStore.writeSessionText(
    compactedSession,
    "active-brief.md",
    [
      "# Active brief",
      "",
      "updated_from_reason: command/compact",
      "session_key: -1000000:2441",
      "topic_name: Fresh brief host retry test (workerz)",
      "cwd: /path/to/workspace",
      "",
      "## Current state",
      "- The replacement run must start on workerz after compact.",
      "",
      "## Open work",
      "- Preserve the fresh-brief bootstrap even if workerz is briefly offline.",
    ].join("\n"),
  );

  let hostResolutionCount = 0;
  const runCalls = [];
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
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    hostRegistryService: {
      async resolveSessionExecution() {
        hostResolutionCount += 1;
        if (hostResolutionCount === 1) {
          return {
            ok: false,
            hostId: "workerz",
            hostLabel: "workerz",
            failureReason: "host-unavailable",
          };
        }
        return {
          ok: true,
          hostId: "workerz",
          hostLabel: "workerz",
          lastReadyAt: "2026-04-01T16:00:00.000Z",
          host: {
            id: "workerz",
            label: "workerz",
            workspace_root: "/path/to/worker-workspace",
            worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
          },
        };
      },
    },
    runTask({ prompt, baseInstructions, sessionThreadId, skipThreadHistoryLookup, onEvent }) {
      runCalls.push({ prompt, baseInstructions, sessionThreadId, skipThreadHistoryLookup });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "Codex thread started: fresh-brief-retry-thread",
              threadId: "fresh-brief-retry-thread",
            },
            {
              type: "thread.started",
              thread_id: "fresh-brief-retry-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "Started cleanly from the compact brief after workerz returned.",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Started cleanly from the compact brief after workerz returned.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "fresh-brief-retry-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const firstAttempt = await workerPool.startPromptRun({
    session: compactedSession,
    prompt: "Continue once workerz is back.",
    message: {
      message_id: 301,
      message_thread_id: 2441,
    },
  });

  assert.deepEqual(firstAttempt, {
    ok: false,
    reason: "host-unavailable",
    hostId: "workerz",
    hostLabel: "workerz",
    failureReason: "host-unavailable",
  });
  assert.equal(runCalls.length, 0);

  const afterFailedAttempt = await sessionStore.load(
    compactedSession.chat_id,
    compactedSession.topic_id,
  );
  assert.equal(afterFailedAttempt.last_compacted_at, "2026-04-01T15:30:00.000Z");
  assert.equal(afterFailedAttempt.last_compaction_reason, "command/compact");
  assert.equal(afterFailedAttempt.last_run_started_at, null);
  assert.equal(afterFailedAttempt.codex_thread_id, null);

  const secondAttempt = await workerPool.startPromptRun({
    session: afterFailedAttempt,
    prompt: "Continue now that workerz is back.",
    message: {
      message_id: 302,
      message_thread_id: 2441,
    },
  });

  assert.equal(secondAttempt.ok, true);
  await waitFor(() => workerPool.getActiveRun(compactedSession.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[0].skipThreadHistoryLookup, true);
  assert.match(
    runCalls[0].prompt,
    /This Telegram topic has no live Codex thread, but it does have a stored active brief\./u,
  );
  assert.match(runCalls[0].prompt, /Continue now that workerz is back\./u);

  const finalMeta = await sessionStore.load(
    compactedSession.chat_id,
    compactedSession.topic_id,
  );
  assert.equal(finalMeta.codex_thread_id, "fresh-brief-retry-thread");
  assert.equal(finalMeta.last_run_status, "completed");
  assert.equal(
    finalMeta.last_agent_reply,
    "Started cleanly from the compact brief after workerz returned.",
  );
});

test("CodexWorkerPool does not force fresh-brief bootstrap when continuity ids are lost after a later run", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 245,
    topicName: "History repair startup test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    last_compacted_at: "2026-04-01T15:30:00.000Z",
    last_compaction_reason: "command/compact",
    last_run_started_at: "2026-04-02T11:00:00.000Z",
    exchange_log_entries: 4,
    last_user_prompt: "Please continue normally after the compacted run.",
    last_agent_reply: "The last real run already happened after compact.",
    last_run_status: "completed",
    codex_thread_id: null,
    provider_session_id: null,
    codex_rollout_path: null,
    last_context_snapshot: null,
  });
  await sessionStore.writeSessionText(
    session,
    "active-brief.md",
    [
      "# Active brief",
      "",
      "updated_from_reason: command/compact",
      "session_key: -1000000:245",
      "",
      "## Latest exchange",
      "- This brief should not be injected unless the run is a deliberate fresh start.",
    ].join("\n"),
  );

  const runCalls = [];
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
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    sessionCompactor: null,
    runTask({ prompt, sessionThreadId, skipThreadHistoryLookup, onEvent }) {
      runCalls.push({ prompt, sessionThreadId, skipThreadHistoryLookup });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "Codex thread started: repaired-thread",
              threadId: "repaired-thread",
            },
            {
              type: "thread.started",
              thread_id: "repaired-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "History repair path used.",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "History repair path used.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "repaired-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Continue without pretending this is a fresh compact bootstrap.",
    message: {
      message_id: 200,
      message_thread_id: 245,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[0].skipThreadHistoryLookup, false);
  assert.doesNotMatch(
    runCalls[0].prompt,
    /This Telegram topic has no live Codex thread, but it does have a stored active brief\./u,
  );
  assert.doesNotMatch(runCalls[0].prompt, /## Active brief/u);
  assert.match(
    runCalls[0].prompt,
    /Continue without pretending this is a fresh compact bootstrap\./u,
  );

  const meta = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(meta.codex_thread_id, "repaired-thread");
  assert.equal(meta.last_run_status, "completed");
});

test("CodexWorkerPool retries thread resume once before succeeding without compact rebuild", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 145,
    topicName: "Resume retry success test",
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
    last_user_prompt: "Remember sentinel SENTINEL_WOLF",
    last_agent_reply: "SENTINEL_WOLF",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-03-22T12:00:00.000Z",
    status: "completed",
    user_prompt: "Remember sentinel SENTINEL_WOLF",
    assistant_reply: "SENTINEL_WOLF",
  });

  await sessionStore.writeSessionText(
    resumedSession,
    "active-brief.md",
    "# Active brief\n\nSentinel: SENTINEL_WOLF\n",
  );

  const sentMessages = [];
  const runCalls = [];
  const runTask = ({ prompt, baseInstructions, sessionThreadId, onEvent }) => {
    runCalls.push({ prompt, baseInstructions, sessionThreadId });
    const child = {
      kill() {},
    };

    if (runCalls.length === 1) {
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

    return {
      child,
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            text: "Codex thread started: replacement-thread",
            threadId: "replacement-thread",
          },
          {
            type: "thread.started",
            thread_id: "replacement-thread",
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Recovered sentinel after retry: SENTINEL_WOLF",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Recovered sentinel after retry: SENTINEL_WOLF",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "replacement-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    };
  };

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
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask,
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "What sentinel did we agree on after retry?",
    message: {
      message_id: 100,
      message_thread_id: 145,
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
    /Telegram topic 145 \(-1000000:145\)/u,
  );
  assert.match(
    runCalls[1].prompt,
    /What sentinel did we agree on after retry\?/u,
  );
  assert.doesNotMatch(runCalls[1].prompt, /Pinned facts/u);

  const meta = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(meta.codex_thread_id, "replacement-thread");
  assert.equal(meta.last_run_status, "completed");
  assert.equal(
    meta.last_agent_reply,
    "Recovered sentinel after retry: SENTINEL_WOLF",
  );

  const exchangeLog = await sessionStore.loadExchangeLog(resumedSession);
  assert.equal(exchangeLog.length, 2);
  assert.equal(
    exchangeLog.at(-1).assistant_reply,
    "Recovered sentinel after retry: SENTINEL_WOLF",
  );

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(
    sentMessages.at(-1).text,
    "Recovered sentinel after retry: SENTINEL_WOLF",
  );
});

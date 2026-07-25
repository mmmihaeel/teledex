import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GlobalCodexSettingsStore } from "../src/session-manager/global-codex-settings-store.js";
import { HostRegistryService } from "../src/hosts/host-registry-service.js";
import { GlobalPromptSuffixStore } from "../src/session-manager/global-prompt-suffix-store.js";
import { SessionService } from "../src/session-manager/session-service.js";
import { SessionStore } from "../src/session-manager/session-store.js";

const TEST_WORKSPACE_ROOT = os.tmpdir();

function buildBinding() {
  return {
    repo_root: TEST_WORKSPACE_ROOT,
    cwd: TEST_WORKSPACE_ROOT,
    branch: "main",
    worktree_path: TEST_WORKSPACE_ROOT,
  };
}

test("SessionService createTopicSession binds the current host and appends a topic suffix", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ host_id: "local" }, { host_id: "workera" }, { host_id: "workerz" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:00:00.000Z",
        };
      },
    },
  });
  const apiCalls = [];

  const created = await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        apiCalls.push(payload);
        return {
          name: payload.name,
          message_thread_id: 777,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    title: "Infrastructure move",
    workspaceBinding: buildBinding(),
  });

  assert.deepEqual(apiCalls, [
    {
      chat_id: -1000000,
      name: "Infrastructure move (workera)",
    },
  ]);
  assert.equal(created.session.execution_host_id, "workera");
  assert.equal(created.session.execution_host_label, "workera");
  assert.equal(
    created.session.execution_host_last_ready_at,
    "2026-04-21T14:00:00.000Z",
  );
  assert.match(created.session.topic_name, /\(workera\)$/u);
});

test("SessionService createTopicSession adds a random forum topic icon when Telegram exposes icons", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ host_id: "local" }, { host_id: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:00:00.000Z",
        };
      },
    },
  });
  const apiCalls = [];

  await service.createTopicSession({
    api: {
      async getForumTopicIconStickers() {
        return [
          { custom_emoji_id: "5434144690511290129" },
        ];
      },
      async createForumTopic(payload) {
        apiCalls.push(payload);
        return {
          name: payload.name,
          message_thread_id: 778,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    title: "Icon topic",
    workspaceBinding: buildBinding(),
  });

  assert.deepEqual(apiCalls, [
    {
      chat_id: -1000000,
      name: "Icon topic (workera)",
      icon_custom_emoji_id: "5434144690511290129",
    },
  ]);
});

test("SessionService createTopicSession can target an explicit execution host", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const requestedHosts = [];
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "local" }, { hostId: "workera" }, { hostId: "workerz" }];
      },
      async resolveTopicCreationHost(hostId) {
        requestedHosts.push(hostId);
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  const created = await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        return {
          name: payload.name,
          message_thread_id: 778,
        };
      },
    },
    executionHostId: "workera",
    message: {
      chat: { id: -1000000 },
    },
    title: "Explicit host topic",
    workspaceBinding: buildBinding(),
  });

  assert.deepEqual(requestedHosts, ["workera"]);
  assert.equal(created.session.execution_host_id, "workera");
  assert.match(created.session.topic_name, /\(workera\)$/u);
});

test("SessionService createTopicSession infers DeepSeek provider from model selector", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  const created = await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        return {
          name: payload.name,
          message_thread_id: 779,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    runtimeModel: "pro",
    title: "DeepSeek topic",
    workspaceBinding: buildBinding(),
  });

  assert.equal(created.session.session_runtime_provider, "deepseek");
  assert.equal(created.session.session_runtime_model, "deepseek-v4-pro");
  assert.equal(created.session.codex_runtime_profile_id, null);
});

test("SessionService createTopicSession accepts OpenRouter provider and custom model ids", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
      openRouterRuntimeHostIds: ["workera"],
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  const created = await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        return {
          name: payload.name,
          message_thread_id: 781,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    runtimeModel: "openai/gpt-5.5",
    runtimeProvider: "openrouter",
    title: "OpenRouter topic",
    workspaceBinding: buildBinding(),
  });

  assert.equal(created.session.session_runtime_provider, "openrouter");
  assert.equal(created.session.session_runtime_model, "openai/gpt-5.5");
  assert.equal(created.session.codex_runtime_profile_id, null);
});

test("SessionService createTopicSession defaults OpenRouter provider to Kimi", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
      openRouterRuntimeHostIds: ["workera"],
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  const created = await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        return {
          name: payload.name,
          message_thread_id: 782,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    runtimeProvider: "or",
    title: "OpenRouter default topic",
    workspaceBinding: buildBinding(),
  });

  assert.equal(created.session.session_runtime_provider, "openrouter");
  assert.equal(created.session.session_runtime_model, "moonshotai/kimi-k2.6");
  assert.equal(created.session.codex_runtime_profile_id, null);
});

test("SessionService createTopicSession keeps legacy runtime profiles when provider is omitted", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  const created = await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        return {
          name: payload.name,
          message_thread_id: 780,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    runtimeProfileId: "deepseek-native",
    title: "Legacy profile topic",
    workspaceBinding: buildBinding(),
  });

  assert.equal(created.session.session_runtime_provider, null);
  assert.equal(created.session.session_runtime_model, null);
  assert.equal(created.session.codex_runtime_profile_id, "deepseek-native");
});

test("SessionService createTopicSession rejects conflicting provider selectors before topic creation", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let createForumTopicCalls = 0;
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    service.createTopicSession({
      api: {
        async createForumTopic() {
          createForumTopicCalls += 1;
          throw new Error("should not create topic");
        },
      },
      message: {
        chat: { id: -1000000 },
      },
      runtimeModel: "pro",
      runtimeProvider: "codex",
      title: "Bad runtime topic",
      workspaceBinding: buildBinding(),
    }),
    (error) => error?.code === "RUNTIME_SELECTION_INVALID",
  );
  assert.equal(createForumTopicCalls, 0);
});

test("SessionService createTopicSession rejects DeepSeek on hosts without configured runtime", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let createForumTopicCalls = 0;
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
      deepSeekRuntimeHostIds: ["workera"],
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "local" }, { hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "local",
          hostLabel: "local",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    service.createTopicSession({
      api: {
        async createForumTopic() {
          createForumTopicCalls += 1;
          throw new Error("should not create topic");
        },
      },
      message: {
        chat: { id: -1000000 },
      },
      runtimeModel: "flash",
      runtimeProvider: "deepseek",
      title: "Bad DeepSeek host",
      workspaceBinding: buildBinding(),
    }),
    (error) =>
      error?.code === "RUNTIME_SELECTION_INVALID"
      && /not configured for host: local/u.test(error.message),
  );
  assert.equal(createForumTopicCalls, 0);
});

test("SessionService createTopicSession rejects OpenRouter on hosts without configured runtime", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let createForumTopicCalls = 0;
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
      openRouterRuntimeHostIds: ["workera"],
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "local" }, { hostId: "workera" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "local",
          hostLabel: "local",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    service.createTopicSession({
      api: {
        async createForumTopic() {
          createForumTopicCalls += 1;
          throw new Error("should not create topic");
        },
      },
      message: {
        chat: { id: -1000000 },
      },
      runtimeModel: "kimi",
      runtimeProvider: "openrouter",
      title: "Bad OpenRouter host",
      workspaceBinding: buildBinding(),
    }),
    (error) =>
      error?.code === "RUNTIME_SELECTION_INVALID"
      && /not configured for host: local/u.test(error.message),
  );
  assert.equal(createForumTopicCalls, 0);
});

test("SessionService createTopicSession rejects OpenRouter profile conflicts before topic creation", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let createForumTopicCalls = 0;
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    service.createTopicSession({
      api: {
        async createForumTopic() {
          createForumTopicCalls += 1;
          throw new Error("should not create topic");
        },
      },
      message: {
        chat: { id: -1000000 },
      },
      runtimeModel: "kimi",
      runtimeProfileId: "legacy-profile",
      runtimeProvider: "openrouter",
      title: "Bad OpenRouter profile topic",
      workspaceBinding: buildBinding(),
    }),
    (error) =>
      error?.code === "RUNTIME_SELECTION_INVALID"
      && /uses model=<provider\/model>, not profile/u.test(error.message),
  );
  assert.equal(createForumTopicCalls, 0);
});

test("SessionService createTopicSession rejects invalid OpenRouter model before topic creation", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let createForumTopicCalls = 0;
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:10:00.000Z",
        };
      },
    },
  });

  await assert.rejects(
    service.createTopicSession({
      api: {
        async createForumTopic() {
          createForumTopicCalls += 1;
          throw new Error("should not create topic");
        },
      },
      message: {
        chat: { id: -1000000 },
      },
      runtimeModel: "gpt-5.5",
      runtimeProvider: "openrouter",
      title: "Bad OpenRouter model",
      workspaceBinding: buildBinding(),
    }),
    (error) =>
      error?.code === "RUNTIME_SELECTION_INVALID"
      && /Unsupported OpenRouter model/u.test(error.message),
  );
  assert.equal(createForumTopicCalls, 0);
});

test("SessionService createTopicSession replaces a stale host suffix with the selected host", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const apiCalls = [];
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async listHosts() {
        return [{ hostId: "local" }, { hostId: "workera" }, { hostId: "workerz" }];
      },
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "workera",
          hostLabel: "workera",
          lastReadyAt: "2026-04-21T14:20:00.000Z",
        };
      },
    },
  });

  await service.createTopicSession({
    api: {
      async createForumTopic(payload) {
        apiCalls.push(payload);
        return {
          name: payload.name,
          message_thread_id: 779,
        };
      },
    },
    message: {
      chat: { id: -1000000 },
    },
    title: "Infrastructure move (workerz)",
    workspaceBinding: buildBinding(),
  });

  assert.deepEqual(apiCalls, [
    {
      chat_id: -1000000,
      name: "Infrastructure move (workera)",
    },
  ]);
});

test("SessionService createTopicSession fails closed when the resolved host is unavailable", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async resolveTopicCreationHost() {
        return {
          ok: false,
          hostId: "local",
          hostLabel: "local",
          failureReason: "host-disabled",
        };
      },
    },
  });

  await assert.rejects(
    service.createTopicSession({
      api: {
        async createForumTopic() {
          throw new Error("should not reach Telegram topic creation");
        },
      },
      message: {
        chat: { id: -1000000 },
      },
      title: "Blocked topic",
      workspaceBinding: buildBinding(),
    }),
    (error) =>
      error?.code === "EXECUTION_HOST_UNAVAILABLE"
      && error?.hostId === "local"
      && error?.failureReason === "host-disabled",
  );
});

test("SessionService backfills execution host metadata for a legacy topic session", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "local",
          hostLabel: "local",
          lastReadyAt: "2026-04-21T16:00:00.000Z",
        };
      },
    },
  });

  const legacy = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 304,
    topicName: "Legacy topic",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const ensured = await service.ensureSessionForMessage({
    chat: { id: -1000000 },
    message_thread_id: 304,
  });

  assert.equal(ensured.execution_host_id, "local");
  assert.equal(ensured.execution_host_label, "local");
  assert.equal(
    ensured.execution_host_last_ready_at,
    "2026-04-21T16:00:00.000Z",
  );
  assert.equal(legacy.execution_host_id, null);
});

test("SessionService keeps missing topic bindings empty for implicitly attached topics", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      currentHostId: "local",
    },
    hostRegistryService: {
      async resolveTopicCreationHost() {
        return {
          ok: true,
          hostId: "local",
          hostLabel: "local",
          lastReadyAt: "2026-04-21T16:30:00.000Z",
        };
      },
    },
  });

  const first = await service.ensureSessionForMessage({
    chat: { id: -1000000 },
    message_thread_id: 404,
  });
  const second = await service.ensureRunnableSessionForMessage({
    chat: { id: -1000000 },
    message_thread_id: 404,
  });

  assert.equal(first.created_via, "topic/implicit-attach");
  assert.equal(first.execution_host_id, null);
  assert.equal(first.execution_host_last_failure, "binding-missing");
  assert.equal(second.execution_host_id, null);
  assert.equal(second.execution_host_last_failure, "binding-missing");
});

test("SessionService purgeSession emits runtime lifecycle audit", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const lifecycleEvents = [];
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 301,
    topicName: "Purge audit",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const purged = await service.purgeSession(session);
  assert.equal(purged.lifecycle_state, "purged");
  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0].action, "purged");
  assert.equal(lifecycleEvents[0].reason, "command/purge");
});

test("SessionService purgeSession does not mutate owner-held sessions before rejecting", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 303,
    topicName: "Owned purge reject",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const owned = await sessionStore.patch(session, {
    session_owner_generation_id: "agent-gen-1",
    session_owner_mode: "active",
  });

  await assert.rejects(
    service.purgeSession(owned),
    /still active and not purge-eligible/u,
  );

  const reloaded = await sessionStore.load(owned.chat_id, owned.topic_id);
  assert.equal(reloaded.lifecycle_state, "active");
  assert.equal(reloaded.session_owner_generation_id, "agent-gen-1");
});

test("SessionService resolveContextSnapshot backfills rollout snapshot into session metadata", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-rollouts-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexGatewayBackend: "app-server",
      codexContextWindow: 290000,
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 302,
    topicName: "Context snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const threadedSession = await sessionStore.patch(session, {
    codex_backend: "app-server",
    last_run_backend: "app-server",
    provider_session_id: "session-context-1",
    codex_thread_id: "thread-context-1",
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "23");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-23T23-14-18-session-context-1.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-23T23:14:17.500Z",
        type: "session_meta",
        payload: {
          id: "session-context-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T23:14:18.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          model_context_window: 275500,
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T23:14:19.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 18220,
              cached_input_tokens: 5504,
              output_tokens: 42,
              reasoning_output_tokens: 30,
              total_tokens: 18262,
            },
            last_token_usage: {
              input_tokens: 18220,
              cached_input_tokens: 5504,
              output_tokens: 42,
              reasoning_output_tokens: 30,
              total_tokens: 18262,
            },
            model_context_window: 275500,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const resolved = await service.resolveContextSnapshot(threadedSession);
  assert.equal(resolved.snapshot.model_context_window, 275500);
  assert.deepEqual(resolved.snapshot.last_token_usage, {
    input_tokens: 18220,
    cached_input_tokens: 5504,
    output_tokens: 42,
    reasoning_tokens: 30,
    total_tokens: 18262,
  });

  const reloaded = await sessionStore.load(
    threadedSession.chat_id,
    threadedSession.topic_id,
  );
  assert.equal(reloaded.provider_session_id, "session-context-1");
  assert.equal(reloaded.codex_rollout_path, rolloutPath);
  assert.deepEqual(reloaded.last_token_usage, {
    input_tokens: 18220,
    cached_input_tokens: 5504,
    output_tokens: 42,
    reasoning_tokens: 30,
    total_tokens: 18262,
  });
  assert.deepEqual(reloaded.last_context_snapshot, {
    captured_at: "2026-03-23T23:14:19.000Z",
    session_id: "session-context-1",
    thread_id: "thread-context-1",
    model_context_window: 275500,
    last_token_usage: {
      input_tokens: 18220,
      cached_input_tokens: 5504,
      output_tokens: 42,
      reasoning_tokens: 30,
      total_tokens: 18262,
    },
    rollout_path: rolloutPath,
  });
});

test("SessionService resolveContextSnapshot resolves rollout state from provider session id without stored thread id", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-rollouts-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexGatewayBackend: "app-server",
      codexContextWindow: 290000,
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3021,
    topicName: "Provider-only context snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const providerSession = await sessionStore.patch(session, {
    codex_backend: "app-server",
    last_run_backend: "app-server",
    provider_session_id: "session-context-provider-only",
    codex_thread_id: null,
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "24");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-24T10-00-00-session-context-provider-only.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-24T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-context-provider-only",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          model_context_window: 199999,
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 11,
              cached_input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 14,
            },
            model_context_window: 199999,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const resolved = await service.resolveContextSnapshot(providerSession);
  assert.equal(resolved.snapshot.session_id, "session-context-provider-only");
  assert.equal(resolved.snapshot.thread_id, null);
  assert.equal(resolved.snapshot.model_context_window, 199999);

  const reloaded = await sessionStore.load(
    providerSession.chat_id,
    providerSession.topic_id,
  );
  assert.equal(reloaded.codex_rollout_path, rolloutPath);
  assert.deepEqual(reloaded.last_context_snapshot, {
    captured_at: "2026-03-24T10:00:02.000Z",
    session_id: "session-context-provider-only",
    thread_id: null,
    model_context_window: 199999,
    last_token_usage: {
      input_tokens: 11,
      cached_input_tokens: 2,
      output_tokens: 3,
      reasoning_tokens: 1,
      total_tokens: 14,
    },
    rollout_path: rolloutPath,
  });
});

test("SessionService resolveContextSnapshot clears legacy rollout metadata for exec-json sessions", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-rollouts-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexContextWindow: 290000,
      codexGatewayBackend: "exec-json",
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3022,
    topicName: "Exec context snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const execSession = await sessionStore.patch(session, {
    codex_backend: "exec-json",
    last_run_backend: "exec-json",
    provider_session_id: "stale-provider",
    codex_thread_id: "exec-thread",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      session_id: "stale-provider",
      thread_id: "exec-thread",
      rollout_path: "/tmp/stale-rollout.jsonl",
      model_context_window: 111111,
    },
  });

  const resolved = await service.resolveContextSnapshot(execSession);
  assert.equal(resolved.snapshot.model_context_window, 290000);

  const reloaded = await sessionStore.load(execSession.chat_id, execSession.topic_id);
  assert.equal(reloaded.codex_thread_id, "exec-thread");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
});

test("SessionService resolveContextSnapshot keeps exec-json snapshots free of provider rollout metadata", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-exec-snapshots-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexContextWindow: 290000,
      codexGatewayBackend: "exec-json",
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3023,
    topicName: "Exec snapshot sanitize",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const execSession = await sessionStore.patch(session, {
    codex_backend: "exec-json",
    last_run_backend: "exec-json",
    codex_thread_id: "exec-thread-snapshot",
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "25");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-25T10-00-00-exec-thread-snapshot.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-25T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "provider-should-not-leak",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-25T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 33,
              cached_input_tokens: 3,
              output_tokens: 4,
              reasoning_output_tokens: 2,
              total_tokens: 37,
            },
            model_context_window: 321000,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const resolved = await service.resolveContextSnapshot(execSession);
  assert.equal(resolved.snapshot.session_id, null);
  assert.equal(resolved.snapshot.rollout_path, null);
  assert.equal(resolved.snapshot.thread_id, "exec-thread-snapshot");
  assert.equal(resolved.snapshot.model_context_window, 321000);

  const reloaded = await sessionStore.load(execSession.chat_id, execSession.topic_id);
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.context_snapshot_rollout_path, rolloutPath);
  assert.deepEqual(reloaded.last_context_snapshot, {
    captured_at: "2026-03-25T10:00:01.000Z",
    session_id: null,
    thread_id: "exec-thread-snapshot",
    model_context_window: 321000,
    last_token_usage: {
      input_tokens: 33,
      cached_input_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 2,
      total_tokens: 37,
    },
    rollout_path: null,
  });

  const newerRolloutDir = path.join(codexSessionsRoot, "2026", "03", "26");
  await fs.mkdir(newerRolloutDir, { recursive: true });
  await fs.writeFile(
    path.join(
      newerRolloutDir,
      "rollout-2026-03-26T10-00-00-exec-thread-snapshot.jsonl",
    ),
    [
      JSON.stringify({
        timestamp: "2026-03-26T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 999,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
              total_tokens: 1000,
            },
            model_context_window: 999000,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const terminalSession = await sessionStore.patch(reloaded, {
    last_context_snapshot: null,
  });
  const resolvedAgain = await service.resolveContextSnapshot(terminalSession);
  assert.equal(resolvedAgain.snapshot.model_context_window, 321000);
});

test("SessionService resolveContextSnapshot reads large rollout token counts from the tail", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-exec-large-snapshots-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexContextWindow: 290000,
      codexGatewayBackend: "exec-json",
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3024,
    topicName: "Large exec snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const execSession = await sessionStore.patch(session, {
    codex_backend: "exec-json",
    last_run_backend: "exec-json",
    codex_thread_id: "exec-tail-large",
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "26");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-26T10-00-00-exec-tail-large.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-26T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "provider-should-not-leak-from-tail",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-26T10:00:01.000Z",
        type: "compacted",
        payload: {
          message: "",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-26T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 22100,
              cached_input_tokens: 21000,
              output_tokens: 43,
              reasoning_output_tokens: 3,
              total_tokens: 22143,
            },
            model_context_window: 248400,
          },
        },
      }),
      "x".repeat(4 * 1024 * 1024 + 1024),
      JSON.stringify({
        timestamp: "2026-03-26T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 190000,
              cached_input_tokens: 170000,
              output_tokens: 900,
              reasoning_output_tokens: 400,
              total_tokens: 190900,
            },
            model_context_window: 248400,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const resolved = await service.resolveContextSnapshot(execSession);
  assert.equal(resolved.snapshot.session_id, null);
  assert.equal(resolved.snapshot.rollout_path, null);
  assert.equal(resolved.snapshot.thread_id, "exec-tail-large");
  assert.equal(resolved.snapshot.model_context_window, 248400);
  assert.deepEqual(resolved.snapshot.last_token_usage, {
    input_tokens: 190000,
    cached_input_tokens: 170000,
    output_tokens: 900,
    reasoning_tokens: 400,
    total_tokens: 190900,
  });
  assert.equal(resolved.snapshot.last_compact_at, "2026-03-26T10:00:01.000Z");
  assert.equal(
    resolved.snapshot.last_post_compact_at,
    "2026-03-26T10:00:02.000Z",
  );
  assert.deepEqual(resolved.snapshot.last_post_compact_token_usage, {
    input_tokens: 22100,
    cached_input_tokens: 21000,
    output_tokens: 43,
    reasoning_tokens: 3,
    total_tokens: 22143,
  });
});

test("SessionService updatePromptSuffix and clearPromptSuffix persist topic-level prompt suffix state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 303,
    topicName: "Prompt suffix",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const updated = await service.updatePromptSuffix(session, {
    text: "P.S.\nKeep it short.",
    enabled: true,
  });
  assert.equal(updated.prompt_suffix_enabled, true);
  assert.equal(updated.prompt_suffix_text, "P.S.\nKeep it short.");

  const cleared = await service.clearPromptSuffix(updated);
  assert.equal(cleared.prompt_suffix_enabled, false);
  assert.equal(cleared.prompt_suffix_text, null);
});

test("SessionService updatePromptSuffixTopicState persists topic suffix routing state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 304,
    topicName: "Prompt suffix routing",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const disabled = await service.updatePromptSuffixTopicState(session, {
    enabled: false,
  });
  assert.equal(disabled.prompt_suffix_topic_enabled, false);

  const enabled = await service.updatePromptSuffixTopicState(disabled, {
    enabled: true,
  });
  assert.equal(enabled.prompt_suffix_topic_enabled, true);
});

test("SessionService updateGlobalPromptSuffix and clearGlobalPromptSuffix persist global prompt suffix state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const globalPromptSuffixStore = new GlobalPromptSuffixStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
    globalPromptSuffixStore,
  });

  const updated = await service.updateGlobalPromptSuffix({
    text: "P.S.\nKeep it short everywhere.",
    enabled: true,
  });
  assert.equal(updated.prompt_suffix_enabled, true);
  assert.equal(updated.prompt_suffix_text, "P.S.\nKeep it short everywhere.");

  const reloaded = await globalPromptSuffixStore.load({ force: true });
  assert.equal(reloaded.prompt_suffix_enabled, true);
  assert.equal(reloaded.prompt_suffix_text, "P.S.\nKeep it short everywhere.");

  const cleared = await service.clearGlobalPromptSuffix();
  assert.equal(cleared.prompt_suffix_enabled, false);
  assert.equal(cleared.prompt_suffix_text, null);
});

test("SessionService persists global and topic Codex runtime settings with topic precedence", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 306,
    topicName: "Codex runtime settings",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("agent", "model", "gpt-5.4-mini");
  await service.updateGlobalCodexSetting("agent", "reasoning", "high");
  let profile = await service.resolveCodexRuntimeProfile(session, {
    target: "agent",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "global");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");

  const overridden = await service.updateSessionCodexSetting(
    session,
    "agent",
    "model",
    "gpt-5.2",
  );
  profile = await service.resolveCodexRuntimeProfile(overridden, {
    target: "agent",
  });
  assert.equal(profile.model, "gpt-5.2");
  assert.equal(profile.modelSource, "topic");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");

  const cleared = await service.clearSessionCodexSetting(
    overridden,
    "agent",
    "model",
  );
  profile = await service.resolveCodexRuntimeProfile(cleared, {
    target: "agent",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "global");
});

test("SessionService resolves compact runtime settings from global defaults", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3061,
    topicName: "Compact runtime settings",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("compact", "model", "gpt-5.4-mini");
  await service.updateGlobalCodexSetting("compact", "reasoning", "high");

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "compact",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "global");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");
});

test("SessionService clamps inherited reasoning to a value supported by the resolved model", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
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
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 307,
    topicName: "Codex runtime compatibility",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  await service.updateGlobalCodexSetting("agent", "reasoning", "xhigh");
  session = await service.updateSessionCodexSetting(
    session,
    "agent",
    "model",
    "gpt-5.4-mini",
  );

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "agent",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "topic");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "default");
});

test("SessionService falls back from unavailable stored models to an available default", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
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
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3071,
    topicName: "Unavailable model fallback",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("compact", "model", "gpt-ghost");
  await service.updateGlobalCodexSetting("compact", "reasoning", "high");

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "compact",
  });
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.modelSource, "default");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");
});

test("SessionService clears stale global reasoning when the global model changes", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
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
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 308,
    topicName: "Compact runtime cleanup",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("compact", "reasoning", "xhigh");
  const cleanedSettings = await service.updateGlobalCodexSetting(
    "compact",
    "model",
    "gpt-5.4-mini",
  );
  assert.equal(cleanedSettings.compact_model, "gpt-5.4-mini");
  assert.equal(cleanedSettings.compact_reasoning_effort, null);

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "compact",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.reasoningEffort, "medium");
  assert.equal(profile.reasoningSource, "default");
});

test("SessionService clears stale topic reasoning when the topic model changes", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
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
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 309,
    topicName: "Topic runtime cleanup",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  session = await service.updateSessionCodexSetting(
    session,
    "agent",
    "reasoning",
    "xhigh",
  );
  session = await service.updateSessionCodexSetting(
    session,
    "agent",
    "model",
    "gpt-5.4-mini",
  );
  assert.equal(session.agent_model_override, "gpt-5.4-mini");
  assert.equal(session.agent_reasoning_effort_override, null);

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "agent",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.reasoningEffort, "medium");
  assert.equal(profile.reasoningSource, "default");
});

test("SessionService resolves available models from the bound host config when the topic is host-bound", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
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
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      codexConfigPath: localCodexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
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
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3091,
    topicName: "Remote host catalog",
    createdVia: "test",
    workspaceBinding: buildBinding(),
    executionHostId: "workera",
    executionHostLabel: "workera",
  });

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "agent",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "default");
});

test("SessionService expands tilde host config paths for current-host topic model catalogs", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-state-"),
  );
  const homeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-home-"),
  );
  const codexRoot = path.join(homeRoot, ".codex");
  const codexConfigPath = path.join(codexRoot, "config.toml");
  const registryPath = path.join(stateRoot, "hosts", "registry-state.toml");
  const previousHome = process.env.HOME;

  await fs.mkdir(codexRoot, { recursive: true });
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(codexRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 0 },
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", priority: 1 },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  process.env.HOME = homeRoot;
  try {
    const sessionStore = new SessionStore(sessionsRoot);
    const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
    const hostRegistryService = new HostRegistryService({
      registryPath,
      currentHostId: "local",
    });
    await hostRegistryService.upsertHost({
      host_id: "local",
      label: "local",
      codex_config_path: "~/.codex/config.toml",
    });

    const service = new SessionService({
      sessionStore,
      config: {
        workspaceRootPath: TEST_WORKSPACE_ROOT,
        defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
        stateRoot,
        codexConfigPath,
        codexModel: "gpt-5.4",
        codexReasoningEffort: "medium",
      },
      globalCodexSettingsStore,
      hostRegistryService,
    });

    await service.updateGlobalCodexSetting("agent", "model", "gpt-5.5");
    const session = await sessionStore.ensure({
      chatId: -1000000,
      topicId: 3092,
      topicName: "Local host catalog",
      createdVia: "test",
      workspaceBinding: buildBinding(),
      executionHostId: "local",
      executionHostLabel: "local",
    });

    const visible = await service.loadVisibleCodexModels(session);
    const profile = await service.resolveCodexRuntimeProfile(session, {
      target: "agent",
    });

    assert.deepEqual(
      visible.map((entry) => entry.slug),
      ["gpt-5.5", "gpt-5.4"],
    );
    assert.equal(profile.model, "gpt-5.5");
    assert.equal(profile.modelSource, "global");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("SessionService uses mirrored remote host model catalogs when registry paths stay remote-local", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-settings-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-state-"),
  );
  const localCodexRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-local-config-"),
  );
  const localCodexConfigPath = path.join(localCodexRoot, "config.toml");
  const mirrorPath = path.join(
    stateRoot,
    "teledex-context",
    "hosts",
    "workera",
    "rendered",
    "models_cache.json",
  );
  const registryPath = path.join(stateRoot, "hosts", "registry-state.toml");

  await fs.writeFile(localCodexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
  await fs.writeFile(
    mirrorPath,
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 0 },
        { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list", priority: 1 },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const sessionStore = new SessionStore(sessionsRoot);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const hostRegistryService = new HostRegistryService({
    registryPath,
    currentHostId: "local",
  });
  await hostRegistryService.upsertHost({
    host_id: "workera",
    label: "workera",
    codex_config_path: "~/.codex/config.toml",
  });

  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
      stateRoot,
      codexConfigPath: localCodexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
    hostRegistryService,
  });

  await service.updateGlobalCodexSetting("agent", "model", "gpt-5.5");
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 3093,
    topicName: "Mirrored remote host catalog",
    createdVia: "test",
    workspaceBinding: buildBinding(),
    executionHostId: "workera",
    executionHostLabel: "workera",
  });

  const visible = await service.loadVisibleCodexModels(session);
  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "agent",
  });

  assert.deepEqual(
    visible.map((entry) => entry.slug),
    ["gpt-5.5", "gpt-5.4-mini"],
  );
  assert.equal(profile.model, "gpt-5.5");
  assert.equal(profile.modelSource, "global");
});

test("SessionService buffers and clears pending prompt attachments", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 305,
    topicName: "Pending attachments",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const buffered = await service.bufferPendingPromptAttachments(
    session,
    [
      {
        file_path: "/tmp/doc.txt",
        relative_path: "incoming/doc.txt",
        mime_type: "text/plain",
        size_bytes: 12,
        is_image: false,
      },
    ],
  );
  assert.equal(buffered.pending_prompt_attachments.length, 1);
  assert.ok(buffered.pending_prompt_attachments_expires_at);

  const pending = await service.getPendingPromptAttachments(buffered);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].file_path, "/tmp/doc.txt");

  const cleared = await service.clearPendingPromptAttachments(buffered);
  assert.deepEqual(cleared.pending_prompt_attachments, []);
  assert.equal(cleared.pending_prompt_attachments_expires_at, null);
});

test("SessionService removes expired pending attachment files inside incoming", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 308,
    topicName: "Expired pending attachments",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const attachmentPath = path.join(
    sessionStore.getSessionDir(session.chat_id, session.topic_id),
    "incoming",
    "expired.txt",
  );
  await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
  await fs.writeFile(attachmentPath, "expired\n", "utf8");

  const buffered = await service.bufferPendingPromptAttachments(
    session,
    [{
      file_path: attachmentPath,
      relative_path: "incoming/expired.txt",
      mime_type: "text/plain",
      size_bytes: 8,
      is_image: false,
    }],
    { ttlMs: -1 },
  );

  const pending = await service.getPendingPromptAttachments(buffered);
  assert.deepEqual(pending, []);
  await assert.rejects(() => fs.stat(attachmentPath), { code: "ENOENT" });
  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.deepEqual(reloaded.pending_prompt_attachments, []);
  assert.equal(reloaded.pending_prompt_attachments_expires_at, null);
});

test("SessionService retries default binding resolution after a transient failure", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const validRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-workspace-"),
  );
  const canonicalValidRoot = await fs.realpath(validRoot);
  const service = new SessionService({
    sessionStore: new SessionStore(sessionsRoot),
    config: {
      workspaceRootPath: validRoot,
      defaultSessionBindingPath: "missing-dir",
    },
  });

  await assert.rejects(
    service.getDefaultBinding(),
    /ENOENT/u,
  );

  service.config.defaultSessionBindingPath = ".";
  const binding = await service.getDefaultBinding();
  assert.equal(binding.cwd, canonicalValidRoot);
  assert.equal(binding.repo_root, canonicalValidRoot);
});

test("SessionService preserves overlapping pending attachment buffers", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 307,
    topicName: "Attachment overlap",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const originalPatchWithCurrent = sessionStore.patchWithCurrent.bind(sessionStore);
  let firstPatchHeld = false;
  let enteredFirstPatch;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    enteredFirstPatch = resolve;
  });
  let releaseFirstPatch;
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  sessionStore.patchWithCurrent = async (meta, patch) => {
    if (firstPatchHeld) {
      return originalPatchWithCurrent(meta, patch);
    }

    firstPatchHeld = true;
    return originalPatchWithCurrent(meta, async (current) => {
      enteredFirstPatch();
      await releaseFirstPatchPromise;
      return typeof patch === "function"
        ? patch(current)
        : patch;
    });
  };

  try {
    const firstBuffer = service.bufferPendingPromptAttachments(
      session,
      [{ file_path: "/tmp/first.txt", is_image: false }],
    );
    await firstPatchEnteredPromise;

    let secondFinished = false;
    const secondBuffer = service.bufferPendingPromptAttachments(
      session,
      [{ file_path: "/tmp/second.txt", is_image: false }],
    ).then((value) => {
      secondFinished = true;
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(secondFinished, false);

    releaseFirstPatch();
    await Promise.all([firstBuffer, secondBuffer]);
  } finally {
    sessionStore.patchWithCurrent = originalPatchWithCurrent;
  }

  const pending = await service.getPendingPromptAttachments(session);
  assert.deepEqual(
    pending.map((entry) => entry.file_path),
    ["/tmp/first.txt", "/tmp/second.txt"],
  );
});

test("SessionService keeps queued attachments separate from direct prompt attachments", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRootPath: TEST_WORKSPACE_ROOT,
      defaultSessionBindingPath: TEST_WORKSPACE_ROOT,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 306,
    topicName: "Scoped pending attachments",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const withPromptAttachment = await service.bufferPendingPromptAttachments(
    session,
    [{ file_path: "/tmp/direct.txt", is_image: false }],
  );
  const withQueuedAttachment = await service.bufferPendingPromptAttachments(
    withPromptAttachment,
    [{ file_path: "/tmp/queued.txt", is_image: false }],
    { scope: "queue" },
  );

  const promptPending = await service.getPendingPromptAttachments(withQueuedAttachment);
  const queuePending = await service.getPendingPromptAttachments(withQueuedAttachment, {
    scope: "queue",
  });
  assert.deepEqual(
    promptPending.map((entry) => entry.file_path),
    ["/tmp/direct.txt"],
  );
  assert.deepEqual(
    queuePending.map((entry) => entry.file_path),
    ["/tmp/queued.txt"],
  );

  const clearedQueue = await service.clearPendingPromptAttachments(withQueuedAttachment, {
    scope: "queue",
  });
  assert.equal(clearedQueue.pending_queue_attachments.length, 0);
  assert.equal(clearedQueue.pending_prompt_attachments.length, 1);
});

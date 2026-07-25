import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { handleGlobalControlCallbackQuery } from "../src/telegram/global-control-panel.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import {
  buildIdleWorkerPool,
  buildUnlimitedLimitsSummary,
  config,
  createGlobalControlPanelStore,
  createGlobalControlSessionService,
  createTopicControlPanelStore,
} from "../test-support/control-panel-fixtures.js";

test("handleIncomingMessage opens the persistent global control panel in General", async () => {
  const sent = [];
  const limitsRequests = [];
  const store = createGlobalControlPanelStore();
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 901 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "/global",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState,
    sessionService: createGlobalControlSessionService({
      async getCodexLimitsSummary(options) {
        limitsRequests.push(options ?? {});
        return buildUnlimitedLimitsSummary();
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "global");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Global control panel/u);
  assert.doesNotMatch(sent[0].text, /Pin this message/u);
  assert.match(sent[0].text, /interface language: ENG/u);
  assert.match(sent[0].text, /topic hosts: 2 ready \/ 3/u);
  assert.match(sent[0].text, /not-ready hosts: workerz \(codex-auth\)/u);
  assert.doesNotMatch(sent[0].text, /offline hosts/u);
  assert.match(sent[0].text, /limits: unlimited/u);
  assert.match(sent[0].text, /agent: .+ \([a-z]+\)/u);
  assert.doesNotMatch(sent[0].text, /agent reasoning:/u);
  assert.equal(Array.isArray(sent[0].reply_markup.inline_keyboard), true);
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[0].map((button) => button.text),
    ["New Topic", "Hosts"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[1].map((button) => button.text),
    ["Bot Settings", "Language"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[2].map((button) => button.text),
    ["Guide", "Help"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[3].map((button) => button.text),
    ["Wait", "Suffix"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[4].map((button) => button.text),
    ["Project Catalog", "Clear"],
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Bot Settings"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Agent model"),
    ),
    false,
  );
  assert.deepEqual(limitsRequests, [{ allowStale: true }]);
  assert.equal(store.getState().menu_message_id, 901);
});

test("handleIncomingMessage opens the persistent global control panel when General uses thread id 0", async () => {
  const sent = [];
  const store = createGlobalControlPanelStore();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 901 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "/global",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 0,
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "global");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Global control panel/u);
});

test("handleIncomingCallbackQuery opens the new-topic host picker inside the global menu", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic",
      data: "gcfg:n:nt",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
  assert.match(edited[0].text, /- workera: ready/u);
  assert.equal(
    edited[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "workera"),
    ),
    true,
  );
  assert.equal(
    edited[0].reply_markup.inline_keyboard.flat().some((button) =>
      /Codex|DS Flash|DS Pro/u.test(button.text),
    ),
    false,
  );
});

test("handleIncomingCallbackQuery opens runtime choices after a host is selected", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic-deepseek-hosts",
      data: "gcfg:n:nt",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config: {
      ...config,
      deepSeekRuntimeHostIds: ["workera"],
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  const labels = edited[0].reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.equal(labels.includes("local"), true);
  assert.equal(labels.includes("workera"), true);
  assert.equal(labels.includes("DS Flash"), false);

  const runtimeResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic-runtime-workera",
      data: "gcfg:nh:workera",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config: {
      ...config,
      deepSeekRuntimeHostIds: ["workera"],
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(runtimeResult.reason, "global-control-runtime-picker-opened");
  assert.equal(store.getState().active_screen, "new_topic_runtime");
  assert.deepEqual(
    edited.at(-1).reply_markup.inline_keyboard
      .flat()
      .filter((button) => [
        "Codex",
        "DS Flash",
        "DS Pro",
        "OR Kimi",
        "OR MiniMax",
        "OR GLM",
        "OR Qwen",
      ].includes(button.text))
      .map((button) => button.text),
    ["Codex", "DS Flash", "DS Pro", "OR Kimi", "OR MiniMax", "OR GLM", "OR Qwen"],
  );

  const proResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic-runtime-workera-pro",
      data: "gcfg:nh:workera:deepseek:pro",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config: {
      ...config,
      deepSeekRuntimeHostIds: ["workera"],
      openRouterRuntimeHostIds: ["workera"],
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(proResult.reason, "global-control-pending-input-started");
  assert.equal(store.getState().pending_input?.requested_host_id, "workera");
  assert.equal(store.getState().pending_input?.requested_runtime_provider, "deepseek");
  assert.equal(store.getState().pending_input?.requested_runtime_model, "pro");

  const openRouterResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic-runtime-workera-openrouter",
      data: "gcfg:nh:workera:openrouter:moonshotai/kimi-k2.6",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config: {
      ...config,
      deepSeekRuntimeHostIds: ["workera"],
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(openRouterResult.reason, "global-control-pending-input-started");
  assert.equal(store.getState().pending_input?.requested_host_id, "workera");
  assert.equal(store.getState().pending_input?.requested_runtime_provider, "openrouter");
  assert.equal(
    store.getState().pending_input?.requested_runtime_model,
    "moonshotai/kimi-k2.6",
  );
});

test("handleIncomingCallbackQuery still shows OpenRouter after selecting a host without DeepSeek runtime", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "new_topic",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic-runtime-local",
      data: "gcfg:nh:local",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config: {
      ...config,
      deepSeekRuntimeHostIds: ["workera"],
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-runtime-picker-opened");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic runtime picker/u);
  assert.match(edited[0].text, /host: local/u);
  assert.deepEqual(
    edited[0].reply_markup.inline_keyboard
      .flat()
      .filter((button) => [
        "Codex",
        "DS Flash",
        "DS Pro",
        "OR Kimi",
        "OR MiniMax",
        "OR GLM",
        "OR Qwen",
      ].includes(button.text))
      .map((button) => button.text),
    ["Codex", "OR Kimi", "OR MiniMax", "OR GLM", "OR Qwen"],
  );
});

test("handleIncomingCallbackQuery hides OpenRouter when the selected host is not OpenRouter-enabled", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "new_topic",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic-runtime-local",
      data: "gcfg:nh:local",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config: {
      ...config,
      deepSeekRuntimeHostIds: ["workera"],
      openRouterRuntimeHostIds: ["workera"],
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-runtime-picker-opened");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.deepEqual(
    edited[0].reply_markup.inline_keyboard
      .flat()
      .filter((button) => [
        "Codex",
        "DS Flash",
        "DS Pro",
        "OR Kimi",
        "OR MiniMax",
        "OR GLM",
        "OR Qwen",
      ].includes(button.text))
      .map((button) => button.text),
    ["Codex"],
  );
});

test("handleIncomingCallbackQuery keeps the host picker with one configured host", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-single-host-new-topic",
      data: "gcfg:n:nt",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService({
      async listTopicCreationHosts() {
        return [
          {
            ok: true,
            hostId: "local",
            hostLabel: "local",
            lastReadyAt: "2026-04-21T19:00:00.000Z",
            failureReason: null,
          },
        ];
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
  assert.match(edited[0].text, /- local: ready/u);
  assert.equal(store.getState().active_screen, "new_topic");
  assert.equal(store.getState().pending_input, null);
  assert.deepEqual(
    edited[0].reply_markup.inline_keyboard
      .flat()
      .filter((button) => ["local", "Codex", "DS Flash", "DS Pro"].includes(button.text))
      .map((button) => button.text),
    ["local"],
  );
});

test("handleIncomingCallbackQuery keeps host picker when one of several hosts is ready", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-one-ready-new-topic",
      data: "gcfg:n:nt",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService({
      async listTopicCreationHosts() {
        return [
          {
            ok: true,
            hostId: "local",
            hostLabel: "local",
            lastReadyAt: "2026-04-21T19:00:00.000Z",
            failureReason: null,
          },
          {
            ok: false,
            hostId: "workera",
            hostLabel: "workera",
            lastReadyAt: null,
            failureReason: "host-not-ready",
          },
          {
            ok: false,
            hostId: "workerz",
            hostLabel: "workerz",
            lastReadyAt: null,
            failureReason: "codex-auth",
          },
        ];
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
  assert.match(edited[0].text, /- local: ready/u);
  assert.match(edited[0].text, /- workera: not-ready/u);
  assert.equal(store.getState().active_screen, "new_topic");
  assert.equal(store.getState().pending_input, null);
  assert.deepEqual(
    edited[0].reply_markup.inline_keyboard
      .flat()
      .filter((button) => ["local", "Codex", "DS Flash", "DS Pro"].includes(button.text))
      .map((button) => button.text),
    ["local"],
  );
});

test("handleIncomingCallbackQuery routes global callbacks before topic-only fallback", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-with-topic-store",
      data: "gcfg:n:nt",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    topicControlPanelStore: createTopicControlPanelStore(),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
});

test("handleGlobalControlCallbackQuery reports an unavailable stale host picker selection", async () => {
  const answered = [];
  const edited = [];
  const sent = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "new_topic",
    ui_language: "eng",
  });

  const result = await handleGlobalControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-global-new-topic-unavailable",
      data: "gcfg:nh:workerz",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    dispatchCommand() {
      throw new Error("should not dispatch /new for an unavailable host");
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-host-unavailable");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.match(edited[0].text, /Host workerz is unavailable right now/u);
});

test("handleIncomingMessage creates a host-bound topic from the global host picker reply", async () => {
  const edited = [];
  const sent = [];
  const createCalls = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const globalControlPanelStore = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "new_topic",
    ui_language: "eng",
    pending_input: {
      kind: "new_topic_title",
      requested_at: "2026-04-21T19:20:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "new_topic",
      requested_host_id: "workera",
      requested_host_label: "workera",
    },
  });
  const sessionService = createGlobalControlSessionService({
    async resolveInheritedBinding() {
      return {
        binding: {
          repo_root: "/path/to/workspace",
          cwd: "/path/to/workspace",
          branch: "main",
          worktree_path: "/path/to/workspace",
        },
        inheritedFromSessionKey: null,
      };
    },
    async createTopicSession(params) {
      createCalls.push(params);
      return {
        forumTopic: {
          name: "Remote bound topic (workera)",
          message_thread_id: 77,
        },
        session: {
          session_key: "-1000000:77",
          chat_id: "-1000000",
          topic_id: "77",
          topic_name: "Remote bound topic (workera)",
          lifecycle_state: "active",
          ui_language: "eng",
          execution_host_id: "workera",
          execution_host_label: "workera",
          workspace_binding: {
            repo_root: "/path/to/workspace",
            cwd: "/path/to/workspace",
            branch: "main",
            worktree_path: "/path/to/workspace",
          },
        },
      };
    },
    async recordHandledSession() {},
  });

  await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 950 + sent.length };
      },
      async pinChatMessage() {},
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore,
    message: {
      text: "Remote bound topic",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService,
    topicControlPanelStore: createTopicControlPanelStore(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].executionHostId, "workera");
  assert.equal(createCalls[0].title, "Remote bound topic");
  assert.equal(globalControlPanelStore.getState().pending_input, null);
  assert.equal(edited.length >= 1, true);
  assert.equal(sent.some((payload) => /Remote bound topic \(workera\)/u.test(payload.text)), true);
});

test("handleIncomingMessage keeps /menu General guidance in the selected General language", async () => {
  const sent = [];
  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    topicControlPanelStore: createTopicControlPanelStore(),
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.match(sent[0].text, /Use \/menu inside a topic\./u);
});

test("handleIncomingCallbackQuery applies a global wait preset from the control panel", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const callOrder = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "wait",
  });
  const promptFragmentAssembler = new PromptFragmentAssembler();

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        callOrder.push("ack");
        answered.push(payload);
      },
      async editMessageText(payload) {
        callOrder.push("edit");
        edited.push(payload);
      },
      async sendMessage(payload) {
        callOrder.push("send");
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-1",
      data: "gcfg:w:60",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1000000 },
    from: { id: 1001001001 },
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(waitState.global.active, true);
  assert.equal(waitState.global.flushDelayMs, 60000);
  assert.equal(callOrder[0], "ack");
  assert.equal(callOrder.includes("send"), false);
  assert.equal(callOrder.indexOf("ack") < callOrder.indexOf("edit"), true);
});

test("handleGlobalControlCallbackQuery reports unavailable global wait without throwing", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "wait",
  });

  const result = await handleGlobalControlCallbackQuery({
    applyGlobalWaitChange: async () => ({ available: false }),
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-wait-unavailable",
      data: "gcfg:w:60",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    dispatchCommand: async () => {
      throw new Error("dispatchCommand should not run for unavailable wait");
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.match(edited[0].text, /Manual collection window|Manual collection windows/u);
});

test("handleIncomingCallbackQuery updates the global panel language and refreshes the menu", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "language",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-language",
      data: "gcfg:l:eng",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService({
      async getCodexLimitsSummary() {
        return buildUnlimitedLimitsSummary();
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-language-updated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(store.getState().ui_language, "eng");
  assert.equal(store.getState().active_screen, "root");
  assert.match(edited[0].text, /Global control panel/u);
  assert.match(edited[0].text, /interface language: ENG/u);
  assert.match(edited[0].text, /limits: unlimited/u);
  assert.match(edited[0].text, /Interface language updated\./u);
});

test("handleIncomingCallbackQuery opens bot settings inside the global control menu", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-bots",
      data: "gcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Bot settings/u);
  assert.match(edited[0].text, /\/compact: gpt-5\.4 \(medium\)/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "Agent model");
  assert.equal(
    edited[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "/compact model"),
    ),
    true,
  );
  assert.equal(
    edited[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "/compact reasoning"),
    ),
    true,
  );
  assert.equal(edited[0].reply_markup.inline_keyboard.at(-1)[0].text, "Back");
  assert.equal(store.getState().active_screen, "bot_settings");
});

test("handleIncomingCallbackQuery applies compact model from the global control panel", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "compact_model",
  });
  const sessionService = createGlobalControlSessionService();

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-compact-model",
      data: "gcfg:m:c:gpt-5.4-mini",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(store.getState().active_screen, "compact_model");
  assert.match(edited[0].text, /Compact summarizer model/u);
  assert.match(edited[0].text, /configured: gpt-5\.4-mini/u);
  const settings = await sessionService.getGlobalCodexSettings();
  assert.equal(settings.compact_model, "gpt-5.4-mini");
});

test("handleIncomingCallbackQuery applies compact reasoning from the global control panel", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "compact_reasoning",
  });
  const sessionService = createGlobalControlSessionService();

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-compact-reasoning",
      data: "gcfg:r:c:high",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(store.getState().active_screen, "compact_reasoning");
  assert.match(edited[0].text, /Compact summarizer reasoning/u);
  assert.match(edited[0].text, /configured: High \(high\)/u);
  const settings = await sessionService.getGlobalCodexSettings();
  assert.equal(settings.compact_reasoning_effort, "high");
});

test("handleIncomingCallbackQuery rejects stale global menu callbacks", async () => {
  const answered = [];
  const edited = [];

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-stale",
      data: "gcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 900,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
      ui_language: "eng",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-expired");
  assert.equal(edited.length, 0);
  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /expired/u);
});

test("handleIncomingCallbackQuery shows the full global suffix text on the suffix screen", async () => {
  const edited = [];
  const longSuffix = [
    "Keep the solution practical, focused, and effective.",
    "You may use any available tools.",
    "Focus on efficiency, modularity, security, autonomy, and convenience.",
  ].join("\n");

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage() {
        throw new Error("suffix screen navigation should edit the menu in place");
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-suffix-full",
      data: "gcfg:n:s",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
      ui_language: "eng",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService({
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: longSuffix,
        };
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Keep the solution practical/u);
  assert.match(edited[0].text, /autonomy, and convenience\./u);
  assert.doesNotMatch(edited[0].text, /\.\.\./u);
});

test("handleIncomingCallbackQuery sends help cards in the selected global panel language", async () => {
  const documents = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async sendDocument(payload) {
        documents.push(payload);
      },
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-help",
      data: "gcfg:h:show",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-help-sent");
  assert.equal(answered.length, 1);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "teledex-operator-reference-1.png");
  assert.equal(documents[1].document.fileName, "teledex-operator-reference-2.png");
});

test("handleIncomingCallbackQuery sends the guidebook in the selected global panel language", async () => {
  const documents = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async sendDocument(payload) {
        documents.push(payload);
      },
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-guide",
      data: "gcfg:g:show",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-guide-sent");
  assert.equal(answered.length, 1);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].document.fileName, "teledex-guidebook-eng.pdf");
});

test("handleGlobalControlCallbackQuery dispatches /zoo from the global root menu", async () => {
  const answered = [];
  const dispatched = [];
  const chat = { id: Number(config.telegramForumChatId) };

  const result = await handleGlobalControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Project Catalog shortcut should not edit the global menu directly");
      },
      async sendMessage() {
        throw new Error("Project Catalog shortcut should route through dispatchCommand");
      },
    },
    callbackQuery: {
      id: "cbq-zoo-shortcut",
      data: "gcfg:z:show",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat,
      },
    },
    config,
    dispatchCommand: async (payload) => {
      dispatched.push(payload);
      return { handled: true, command: "zoo", reason: "zoo-topic-opened" };
    },
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-zoo-opened");
  assert.equal(answered.length, 1);
  assert.deepEqual(dispatched, [{
    actor: { id: 1001001001, is_bot: false },
    chat,
    commandText: "/zoo",
  }]);
});

test("handleIncomingCallbackQuery keeps zoo routing alive for the global Project Catalog button", async () => {
  const answered = [];
  const zooMessages = [];

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Project Catalog shortcut should route through zooService");
      },
      async sendMessage() {
        throw new Error("Project Catalog shortcut should not send a General no-session reply");
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-zoo-live-route",
      data: "gcfg:z:show",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
    zooService: {
      async handleCallbackQuery() {
        return { handled: false };
      },
      async maybeHandleIncomingMessage({ message }) {
        zooMessages.push(message);
        return { handled: true, command: "zoo", reason: "zoo-topic-opened" };
      },
    },
  });

  assert.equal(result.reason, "global-control-zoo-opened");
  assert.equal(answered.length, 1);
  assert.equal(zooMessages.length, 1);
  assert.equal(zooMessages[0].text, "/zoo");
  assert.equal(zooMessages[0].is_internal_global_control_dispatch, true);
});

test("handleGlobalControlCallbackQuery dispatches /clear from the global root menu", async () => {
  const answered = [];
  const dispatched = [];
  const chat = { id: Number(config.telegramForumChatId) };

  const result = await handleGlobalControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Clear shortcut should route through the General cleanup flow");
      },
      async sendMessage() {
        throw new Error("Clear shortcut should not send a side message here");
      },
    },
    callbackQuery: {
      id: "cbq-clear-shortcut",
      data: "gcfg:c:run",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat,
      },
    },
    config,
    dispatchCommand: async (payload) => {
      dispatched.push(payload);
      return { handled: true, command: "clear", reason: "clear-complete" };
    },
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-clear-run");
  assert.equal(answered.length, 1);
  assert.deepEqual(dispatched, [{
    actor: { id: 1001001001, is_bot: false },
    chat,
    commandText: "/clear",
  }]);
});

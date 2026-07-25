import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { handleTopicControlCallbackQuery } from "../src/telegram/topic-control-panel.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import {
  buildIdleWorkerPool,
  config,
  createServiceState,
  createTopicControlPanelStore,
  createTopicSession,
  createTopicSessionService,
} from "../test-support/control-panel-fixtures.js";

test("handleIncomingCallbackQuery applies a local wait preset from the topic control panel", async () => {
  const edited = [];
  const answered = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "wait",
  });
  const session = createTopicSession();

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
      id: "cbq-topic-1",
      data: "tcfg:w:300",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1000000 },
    from: { id: 1001001001 },
    message_thread_id: 55,
  });

  assert.equal(result.reason, "topic-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(waitState.local.active, true);
  assert.equal(waitState.local.flushDelayMs, 300000);
});

test("handleIncomingCallbackQuery renders status inside the topic control menu", async () => {
  const edited = [];
  const answered = [];
  const limitsRequests = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    lifecycle_state: "active",
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
      id: "cbq-topic-status",
      data: "tcfg:n:st",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session, {
      async getCodexLimitsSummary(options) {
        limitsRequests.push(options ?? {});
        return {
          available: true,
          capturedAt: "2026-04-04T13:00:00.000Z",
          source: "windows_worker",
          planType: "business",
          limitName: "codex",
          unlimited: true,
          windows: [],
          primary: null,
          secondary: null,
        };
      },
      async resolveContextSnapshot(current) {
        return {
          session: current,
          snapshot: null,
        };
      },
    }),
    topicControlPanelStore,
    workerPool: {
      getActiveRun() {
        return {
          state: {
            status: "running",
          },
        };
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /^Status/u);
  assert.match(edited[0].text, /run: running/u);
  assert.match(edited[0].text, /limits: unlimited/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "Refresh");
  assert.equal(edited[0].reply_markup.inline_keyboard[0][1].text, "Back");
  assert.deepEqual(limitsRequests, [{ allowStale: true }]);
  assert.equal(topicControlPanelStore.getState(session).active_screen, "status");
});

test("handleIncomingCallbackQuery parks topic menu callbacks on unavailable Telegram topics", async () => {
  const answered = [];
  const parked = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    lifecycle_state: "active",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Bad Request: message thread not found");
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-gone",
      data: "tcfg:n:st",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    lifecycleManager: {
      async handleTransportError(currentSession, error) {
        parked.push({ currentSession, error });
        return {
          handled: true,
          parked: true,
          session: {
            ...currentSession,
            lifecycle_state: "parked",
            parked_reason: "telegram/topic-unavailable",
          },
        };
      },
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-topic-unavailable");
  assert.equal(answered.length, 1);
  assert.equal(parked.length, 1);
  assert.match(parked[0].error.message, /message thread not found/u);
});

test("handleIncomingCallbackQuery dispatches topic-panel /compact immediately", async () => {
  const sent = [];
  const answered = [];
  const session = createTopicSession();

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-compact",
      data: "tcfg:cmd:compact",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore: createTopicControlPanelStore({
      menu_message_id: 91,
      active_screen: "root",
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-command-dispatched");
  assert.equal(answered.length, 1);
  assert.match(sent[0].text, /Compaction started/u);
});

test("handleIncomingMessage opens and pins the local topic control menu with /menu", async () => {
  const sent = [];
  const pinned = [];
  const deleted = [];
  const limitsRequests = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = createTopicSession({
    last_run_backend: "app-server-v2",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 777 };
      },
      async pinChatMessage(payload) {
        pinned.push(payload);
        return true;
      },
      async deleteMessage(payload) {
        deleted.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session, {
      async getCodexLimitsSummary(options) {
        limitsRequests.push(options ?? {});
        return {
          available: true,
          capturedAt: "2026-04-04T13:00:00.000Z",
          source: "windows_worker",
          planType: "business",
          limitName: "codex",
          unlimited: true,
          windows: [],
          primary: null,
          secondary: null,
        };
      },
    }),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 55);
  assert.match(sent[0].text, /Topic control panel/u);
  assert.match(sent[0].text, /global suffix routing: on/u);
  assert.match(sent[0].text, /limits: unlimited/u);
  assert.match(sent[0].text, /agent: .+ \([a-z]+\)/u);
  assert.doesNotMatch(sent[0].text, /agent reasoning:/u);
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Status"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Language"),
    ),
    false,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Help"),
    ),
    false,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Bot Settings"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Compact"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Interrupt"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Purge"),
    ),
    true,
  );
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].text, "Bot Settings");
  assert.equal(sent[0].reply_markup.inline_keyboard[0][1].text, "Status");
  assert.equal(sent[0].reply_markup.inline_keyboard[1][0].text, "Suffix");
  assert.equal(sent[0].reply_markup.inline_keyboard[1][1].text, "Wait");
  assert.equal(sent[0].reply_markup.inline_keyboard[2][0].text, "Purge");
  assert.equal(sent[0].reply_markup.inline_keyboard[3][0].text, "Goal");
  assert.equal(sent[0].reply_markup.inline_keyboard[3][1].text, "Compact");
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Agent model"),
    ),
    false,
  );
  assert.equal(pinned.length, 1);
  assert.equal(deleted.length, 0);
  assert.deepEqual(limitsRequests, [{ allowStale: true }]);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 777);
});

test("handleIncomingMessage shows DeepSeek model and reasoning in the topic control root", async () => {
  const sent = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = createTopicSession({
    session_runtime_provider: "deepseek",
    session_runtime_model: "deepseek-v4-pro",
    agent_reasoning_effort_override: "xhigh",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 779 };
      },
      async pinChatMessage() {
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /runtime: deepseek-v4-pro \(Max\)/u);
  assert.doesNotMatch(sent[0].text, /runtime: deepseek \(deepseek-v4-pro\)/u);
});

test("handleIncomingMessage shows OpenRouter model and reasoning in the topic control root", async () => {
  const sent = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = createTopicSession({
    session_runtime_provider: "openrouter",
    session_runtime_model: "moonshotai/kimi-k2.6",
    agent_reasoning_effort_override: "high",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 780 };
      },
      async pinChatMessage() {
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /runtime: moonshotai\/kimi-k2\.6 \(Max\)/u);
  assert.doesNotMatch(sent[0].text, /agent: /u);
});

test("handleIncomingMessage opens the local topic control menu from a suggested /menu@bot command without relying on entities", async () => {
  const sent = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = createTopicSession();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 778 };
      },
      async pinChatMessage() {
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu@gatewaybot",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Topic control panel/u);
});

test("handleIncomingMessage recreates the local topic control menu when an explicit /menu hits an unchanged panel", async () => {
  const sent = [];
  const edited = [];
  const pinned = [];
  const deleted = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 6871,
    active_screen: "root",
  });
  const session = createTopicSession({
    session_key: "-1000000:2203",
    topic_id: "2203",
    topic_name: "codex-telegram",
  });

  const result = await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
        throw new Error("Telegram API editMessageText failed: message is not modified");
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 6889 };
      },
      async pinChatMessage(payload) {
        pinned.push(payload);
        return true;
      },
      async deleteMessage(payload) {
        deleted.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu@gatewaybot",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 2203,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(edited.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 2203);
  assert.match(sent[0].text, /Topic control panel/u);
  assert.equal(pinned.length, 1);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].message_id, 6871);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 6889);
});

test("handleIncomingMessage recreates the local topic control menu even when the existing panel is editable", async () => {
  const sent = [];
  const edited = [];
  const pinned = [];
  const deleted = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 6950,
    active_screen: "root",
  });
  const session = createTopicSession({
    session_key: "-1000000:2203",
    topic_id: "2203",
    topic_name: "codex-telegram",
  });

  const result = await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
        return true;
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 12561 };
      },
      async pinChatMessage(payload) {
        pinned.push(payload);
        return true;
      },
      async deleteMessage(payload) {
        deleted.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 2203,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(edited.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 2203);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].message_id, 12561);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].message_id, 6950);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 12561);
});

test("handleIncomingCallbackQuery opens bot settings inside the topic control menu", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession();

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
      id: "cbq-topic-bots",
      data: "tcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Bot settings/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "Agent model");
  assert.equal(edited[0].reply_markup.inline_keyboard.at(-1)[0].text, "Back");
  assert.equal(topicControlPanelStore.getState(session).active_screen, "bot_settings");
});

test("handleIncomingCallbackQuery shows DeepSeek runtime settings inside DeepSeek topics", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    session_runtime_provider: "deepseek",
    session_runtime_model: "deepseek-v4-flash",
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
      id: "cbq-topic-deepseek-bots",
      data: "tcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Runtime settings/u);
  assert.match(edited[0].text, /model: deepseek-v4-flash/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "DeepSeek model");
  assert.equal(edited[0].reply_markup.inline_keyboard[1][0].text, "DeepSeek reasoning");
  assert.equal(
    edited[0].reply_markup.inline_keyboard.flat().some((button) =>
      button.text === "Agent reasoning"),
    false,
  );
});

test("handleIncomingCallbackQuery shows OpenRouter runtime settings inside OpenRouter topics", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    session_runtime_provider: "openrouter",
    session_runtime_model: "moonshotai/kimi-k2.6",
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
      id: "cbq-topic-openrouter-bots",
      data: "tcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Runtime settings/u);
  assert.match(edited[0].text, /runtime: openrouter/u);
  assert.match(edited[0].text, /model: moonshotai\/kimi-k2\.6/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "OpenRouter model");
  assert.equal(edited[0].reply_markup.inline_keyboard[1][0].text, "OpenRouter reasoning");
});

test("handleIncomingCallbackQuery applies DeepSeek model from topic control menu", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "agent_model",
  });
  const session = createTopicSession({
    session_runtime_provider: "deepseek",
    session_runtime_model: "deepseek-v4-flash",
  });
  const sessionService = createTopicSessionService(session);

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
      id: "cbq-topic-deepseek-model",
      data: "tcfg:m:s:deepseek-v4-pro",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sessionService.getCurrentSession().session_runtime_model, "deepseek-v4-pro");
  assert.match(edited[0].text, /DeepSeek topic model/u);
  assert.match(edited[0].text, /effective: deepseek-v4-pro/u);
  const buttonLabels = edited[0].reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.equal(buttonLabels.includes("DeepSeek-V4-Flash"), true);
  assert.equal(buttonLabels.includes("DeepSeek-V4-Pro"), true);
  assert.equal(buttonLabels.includes("undefined"), false);
});

test("handleIncomingCallbackQuery applies DeepSeek reasoning from topic control menu", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "agent_reasoning",
  });
  const session = createTopicSession({
    session_runtime_provider: "deepseek",
    session_runtime_model: "deepseek-v4-pro",
  });
  const sessionService = createTopicSessionService(session);

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
      id: "cbq-topic-deepseek-reasoning",
      data: "tcfg:r:s:xhigh",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(
    sessionService.getCurrentSession().agent_reasoning_effort_override,
    "xhigh",
  );
  assert.match(edited[0].text, /DeepSeek topic reasoning/u);
  assert.match(edited[0].text, /effective: Max \(xhigh\)/u);
});

test("handleIncomingCallbackQuery applies OpenRouter model and reasoning from topic control menu", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "agent_model",
  });
  const session = createTopicSession({
    session_runtime_provider: "openrouter",
    session_runtime_model: "moonshotai/kimi-k2.6",
  });
  const sessionService = createTopicSessionService(session);

  const modelResult = await handleIncomingCallbackQuery({
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
      id: "cbq-topic-openrouter-model",
      data: "tcfg:m:s:vendor/model:free",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(modelResult.reason, "topic-control-action-applied");
  assert.equal(sessionService.getCurrentSession().session_runtime_model, "vendor/model:free");
  assert.match(edited.at(-1).text, /OpenRouter topic model/u);
  assert.match(edited.at(-1).text, /effective: vendor\/model:free/u);

  const reasoningResult = await handleIncomingCallbackQuery({
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
      id: "cbq-topic-openrouter-reasoning",
      data: "tcfg:r:s:medium",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(reasoningResult.reason, "topic-control-action-applied");
  assert.equal(
    sessionService.getCurrentSession().agent_reasoning_effort_override,
    "medium",
  );
  assert.match(edited.at(-1).text, /OpenRouter topic reasoning/u);
  assert.match(edited.at(-1).text, /effective: Medium \(medium\)/u);
});

test("handleTopicControlCallbackQuery dispatches topic command buttons through the existing command surface", async () => {
  const answered = [];
  const dispatched = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession();

  const result = await handleTopicControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-topic-compact",
      data: "tcfg:cmd:compact",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    dispatchCommand: async (payload) => {
      dispatched.push(payload);
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-command-dispatched");
  assert.equal(answered.length, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].commandText, "/compact");
  assert.equal(dispatched[0].chat.message_thread_id, 55);
});

test("handleTopicControlCallbackQuery rejects stale topic menu callbacks", async () => {
  const answered = [];
  const edited = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession();

  const result = await handleTopicControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-topic-stale",
      data: "tcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 90,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    dispatchCommand: async () => {
      throw new Error("stale menu callback must not dispatch commands");
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-expired");
  assert.equal(edited.length, 0);
  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /expired/u);
});

test("handleTopicControlCallbackQuery refreshes stale status panel callbacks", async () => {
  const answered = [];
  const edited = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    lifecycle_state: "active",
    last_run_status: "running",
  });

  const result = await handleTopicControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-topic-stale-status",
      data: "tcfg:n:st",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 90,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    dispatchCommand: async () => {
      throw new Error("status refresh must not dispatch commands");
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createTopicSessionService(session, {
      async resolveContextSnapshot(current) {
        return {
          session: current,
          snapshot: {
            model_context_window: 320000,
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 100,
              output_tokens: 5,
              reasoning_tokens: 2,
              total_tokens: 125,
            },
          },
          source: "codex-sessions",
        };
      },
    }),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].message_id, 90);
  assert.match(edited[0].text, /^Status/u);
  assert.match(edited[0].text, /current native active tokens: 125 \/ 320000/u);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 90);
  assert.equal(topicControlPanelStore.getState(session).active_screen, "status");
});

test("handleTopicControlCallbackQuery rejects callbacks when menu state was purged", async () => {
  const answered = [];
  const edited = [];
  const session = createTopicSession();

  const result = await handleTopicControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-topic-purged-menu",
      data: "tcfg:n:b",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config,
    dispatchCommand: async () => {
      throw new Error("purged menu callback must not dispatch commands");
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore: createTopicControlPanelStore(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-expired");
  assert.equal(edited.length, 0);
  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /expired/u);
});

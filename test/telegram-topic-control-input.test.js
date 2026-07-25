import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import { buildTopicControlPanelPayload } from "../src/telegram/topic-control-panel-view.js";
import {
  buildIdleWorkerPool,
  config,
  createServiceState,
  createTopicControlPanelStore,
  createTopicSession,
  createTopicSessionService,
} from "../test-support/control-panel-fixtures.js";

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

function buildGoalWorkerPool(calls) {
  return {
    getActiveRun() {
      return {
        state: {
          backend: "app-server-v2",
        },
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
    interrupt() {
      return false;
    },
  };
}

function flattenKeyboardText(markup) {
  return (markup?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.text);
}

test("topic control panel suffix flow applies manual input without side prompts", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "suffix",
  });
  const session = createTopicSession();
  const sessionService = createTopicSessionService(session);
  const promptFragmentAssembler = new PromptFragmentAssembler();

  const callbackResult = await handleIncomingCallbackQuery({
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
      id: "cbq-topic-suffix",
      data: "tcfg:s:input",
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
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(callbackResult.reason, "topic-control-pending-input-started");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "suffix_text");
  assert.equal(sent.length, 0);
  assert.match(edited[0].text, /next text message/u);

  const replyResult = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "P.S.\nKeep it short in this topic.",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(replyResult.reason, "topic-control-pending-input-applied");
  assert.equal(topicControlPanelStore.getState(sessionService.getCurrentSession()).pending_input, null);
  assert.equal(sessionService.getCurrentSession().prompt_suffix_enabled, true);
  assert.equal(
    sessionService.getCurrentSession().prompt_suffix_text,
    "P.S.\nKeep it short in this topic.",
  );
  assert.equal(sent.length, 0);
  assert.equal(edited.length >= 2, true);
});

test("topic control panel goal button applies the next text message as app-server-v2 goal", async () => {
  const sent = [];
  const edited = [];
  const goalCalls = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    last_run_backend: "app-server-v2",
  });
  const sessionService = createTopicSessionService(session);
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const workerPool = buildGoalWorkerPool(goalCalls);

  const callbackResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-goal",
      data: "tcfg:g:input",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config: {
      ...config,
      codexEnableAppServerV2: true,
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool,
  });

  assert.equal(callbackResult.reason, "topic-control-pending-input-started");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "goal_text");
  assert.match(edited[0].text, /app-server-v2 goal/u);

  const replyResult = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      codexEnableAppServerV2: true,
    },
    message: {
      text: "ship stable prod app-server",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool,
  });

  assert.equal(replyResult.reason, "topic-control-goal-applied");
  assert.equal(topicControlPanelStore.getState(sessionService.getCurrentSession()).pending_input, null);
  assert.deepEqual(goalCalls, [{
    objective: "ship stable prod app-server",
    status: "active",
    tokenBudget: undefined,
  }]);
  assert.match(edited.at(-1).text, /ship stable prod app-server/u);
  assert.equal(sent.length, 0);
});

test("topic control panel shows Goal only for Codex app-server-v2 topics", () => {
  const baseView = {
    availableModels: [],
    runtimeModels: [],
    globalPromptSuffix: null,
    limitsSummary: null,
    profiles: {
      agent: {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      },
    },
    statusText: null,
    waitState: {
      local: {
        active: false,
        flushDelayMs: null,
      },
    },
  };
  const execJsonPayload = buildTopicControlPanelPayload({
    session: createTopicSession(),
    view: baseView,
  });
  const appServerV2Payload = buildTopicControlPanelPayload({
    session: createTopicSession({ last_run_backend: "app-server-v2" }),
    view: baseView,
  });
  const deepSeekPayload = buildTopicControlPanelPayload({
    session: createTopicSession({
      last_run_backend: "app-server-v2",
      session_runtime_provider: "deepseek",
    }),
    view: baseView,
  });
  const openRouterPayload = buildTopicControlPanelPayload({
    session: createTopicSession({
      last_run_backend: "app-server-v2",
      session_runtime_provider: "openrouter",
    }),
    view: baseView,
  });

  assert.equal(flattenKeyboardText(execJsonPayload.reply_markup).includes("Goal"), false);
  assert.equal(flattenKeyboardText(appServerV2Payload.reply_markup).includes("Goal"), true);
  assert.equal(flattenKeyboardText(deepSeekPayload.reply_markup).includes("Goal"), false);
  assert.equal(flattenKeyboardText(openRouterPayload.reply_markup).includes("Goal"), false);
});

test("topic control panel goal input buffers Telegram-split long goal text", async () => {
  const edited = [];
  const goalCalls = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    last_run_backend: "app-server-v2",
  });
  const sessionService = createTopicSessionService(session);
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 10,
  });
  const workerPool = buildGoalWorkerPool(goalCalls);
  const testConfig = {
    ...config,
    codexEnableAppServerV2: true,
  };

  await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-goal-long",
      data: "tcfg:g:input",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1000000 },
        message_thread_id: 55,
      },
    },
    config: testConfig,
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool,
  });

  const firstResult = await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config: testConfig,
    message: {
      text: "first long goal fragment",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
  const secondResult = await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config: testConfig,
    message: {
      text: "second fragment",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool,
  });

  assert.equal(firstResult.reason, "topic-control-goal-buffered");
  assert.equal(secondResult.reason, "topic-control-goal-buffered");
  await waitFor(() => (
    goalCalls.length === 1
    && /second fragment/u.test(edited.at(-1)?.text || "")
  ));
  assert.deepEqual(goalCalls[0], {
    objective: "first long goal fragment\n\nsecond fragment",
    status: "active",
    tokenBudget: undefined,
  });
  assert.equal(topicControlPanelStore.getState(sessionService.getCurrentSession()).pending_input, null);
  assert.match(edited.at(-1).text, /second fragment/u);
});

test("topic control panel custom wait reply flow applies the parsed local wait", async () => {
  const sent = [];
  const edited = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "wait",
  });
  const session = createTopicSession();
  const promptFragmentAssembler = new PromptFragmentAssembler();

  const callbackResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-wait-custom",
      data: "tcfg:w:input",
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

  assert.equal(callbackResult.reason, "topic-control-pending-input-started");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "wait_custom");

  const replyResult = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "2m",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
      reply_to_message: { message_id: 91 },
    },
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

  assert.equal(replyResult.reason, "topic-control-pending-input-applied");
  assert.equal(topicControlPanelStore.getState(session).pending_input, null);
  assert.equal(waitState.local.active, true);
  assert.equal(waitState.local.flushDelayMs, 120000);
});

test("topic control panel does not swallow non-reply slash commands as pending input", async () => {
  const sent = [];
  const edited = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 91,
      screen: "suffix",
    },
  });
  const session = createTopicSession();
  const sessionService = createTopicSessionService(session);

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/Q status",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.notEqual(result.reason, "topic-control-pending-input-applied");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "suffix_text");
  assert.equal(sessionService.getCurrentSession().prompt_suffix_text, null);
  assert.equal(edited.length, 0);
  assert.equal(sent.length, 1);
});

test("topic control panel keeps pending reply target aligned when the menu message is recreated", async () => {
  const sent = [];
  const answered = [];
  const deleted = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "suffix",
  });
  const session = createTopicSession();

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Telegram API editMessageText failed: message to edit not found");
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 92 };
      },
      async deleteMessage(payload) {
        deleted.push(payload);
      },
      async pinChatMessage() {
        return true;
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-recreate",
      data: "tcfg:s:input",
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

  assert.equal(result.reason, "topic-control-pending-input-started");
  assert.equal(answered.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(deleted[0].message_id, 91);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 92);
  assert.equal(topicControlPanelStore.getState(session).pending_input.menu_message_id, 92);
});

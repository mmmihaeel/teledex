import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import { PROMPT_SUFFIX_MAX_CHARS } from "../src/session-manager/prompt-suffix.js";
import {
  buildIdleWorkerPool,
  config,
  createGlobalControlPanelStore,
  createGlobalControlSessionService,
} from "../test-support/control-panel-fixtures.js";

test("global control panel suffix text flow applies manual input without side prompts", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
  });
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const sessionService = createGlobalControlSessionService();

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
      id: "cbq-2",
      data: "gcfg:s:input",
      from: { id: 1001001001, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1000000 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(callbackResult.reason, "global-control-pending-input-started");
  assert.equal(store.getState().pending_input.kind, "suffix_text");
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
    globalControlPanelStore: store,
    message: {
      text: "P.S.\nKeep it short everywhere.",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(replyResult.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input, null);
  assert.equal(sent.length, 0);
  assert.match(edited.at(-1).text, /Global prompt suffix updated|text: set/u);
  assert.equal(edited.length >= 2, true);
});

test("global control panel suffix input ignores stale reply target for same-user text", async () => {
  const sent = [];
  const edited = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-28T22:40:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "suffix",
    },
  });
  const sessionService = createGlobalControlSessionService();

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
    globalControlPanelStore: store,
    message: {
      message_id: 777,
      message_thread_id: 0,
      text: "Keep it concise, practical, and focused.",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      reply_to_message: { message_id: 12345 },
    },
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

  assert.equal(result.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input, null);
  assert.equal((await sessionService.getGlobalPromptSuffix()).prompt_suffix_text, "Keep it concise, practical, and focused.");
  assert.equal(sent.length, 0);
  assert.match(edited.at(-1).text, /Global prompt suffix updated|text: set/u);
});

test("global control panel applies max-size suffix without overlong menu update", async () => {
  const sent = [];
  const edited = [];
  const suffixText = "x".repeat(PROMPT_SUFFIX_MAX_CHARS);
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-29T10:19:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "suffix",
    },
  });
  const sessionService = createGlobalControlSessionService();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
        assert.ok(
          payload.text.length <= 4096,
          `menu update exceeded Telegram text limit: ${payload.text.length}`,
        );
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      message_id: 778,
      message_thread_id: 0,
      text: suffixText,
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      reply_to_message: { message_id: 12345 },
    },
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

  assert.equal(result.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input, null);
  assert.equal((await sessionService.getGlobalPromptSuffix()).prompt_suffix_text, suffixText);
  assert.equal(sent.length, 0);
  assert.match(edited.at(-1).text, /Global prompt suffix updated/u);
  assert.match(edited.at(-1).text, /truncated preview: 4000 chars total/u);
});

test("global control panel survives stale overlong notice from previous menu render", async () => {
  const sent = [];
  const edited = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    notice: "Global prompt suffix updated.\n\n".concat(
      "y".repeat(PROMPT_SUFFIX_MAX_CHARS),
    ),
  });
  const sessionService = createGlobalControlSessionService({
    async getGlobalPromptSuffix() {
      return {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "x".repeat(PROMPT_SUFFIX_MAX_CHARS),
      };
    },
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
        assert.ok(
          payload.text.length <= 4096,
          `menu update exceeded Telegram text limit: ${payload.text.length}`,
        );
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
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-opened");
  assert.equal(sent.length, 0);
  assert.match(edited.at(-1).text, /truncated notice: 4031 chars total/u);
  assert.equal(store.getState().notice, null);
});

test("global control panel keeps literal suffix text like off instead of reinterpreting it as a command", async () => {
  const sent = [];
  const edited = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "suffix",
    },
  });
  const sessionService = createGlobalControlSessionService();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
        return { ok: true };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "off",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      reply_to_message: { message_id: 901 },
    },
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

  assert.equal(result.reason, "global-control-pending-input-applied");
  const suffixState = await sessionService.getGlobalPromptSuffix();
  assert.equal(suffixState.prompt_suffix_text, "off");
  assert.equal(suffixState.prompt_suffix_enabled, true);
  assert.equal(sent.length, 0);
  assert.match(edited.at(-1).text, /text: set/u);
});

test("global control panel does not swallow non-reply slash commands as pending input", async () => {
  const sent = [];
  const edited = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "suffix",
    },
  });
  const sessionService = createGlobalControlSessionService();

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
    globalControlPanelStore: store,
    message: {
      text: "/Q status",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
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

  assert.notEqual(result.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input.kind, "suffix_text");
  assert.equal((await sessionService.getGlobalPromptSuffix()).prompt_suffix_text, null);
  assert.equal(edited.length, 0);
  assert.equal(sent.length, 1);
});

test("handleIncomingCallbackQuery clears pending global panel input", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "suffix",
    },
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
      id: "cbq-pending-clear",
      data: "gcfg:p:clear",
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

  assert.equal(result.reason, "global-control-pending-input-cleared");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(store.getState().pending_input, null);
  assert.match(edited[0].text, /Pending manual input cleared/u);
});

test("global control panel rejects overly long suffix replies", async () => {
  const sent = [];
  const edited = [];
  const tooLongSuffix = "x".repeat(PROMPT_SUFFIX_MAX_CHARS + 1);
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "suffix",
    },
  });

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
    globalControlPanelStore: store,
    message: {
      text: tooLongSuffix,
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      reply_to_message: { message_id: 901 },
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

  assert.equal(result.reason, "global-control-suffix-too-long");
  assert.equal(store.getState().pending_input.kind, "suffix_text");
  assert.equal(sent.length, 0);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, new RegExp(`max_chars: ${PROMPT_SUFFIX_MAX_CHARS}`, "u"));
});

test("global control panel keeps pending reply target aligned when the menu message is recreated", async () => {
  const sent = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
  });

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
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-3",
      data: "gcfg:s:input",
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

  assert.equal(result.reason, "global-control-pending-input-started");
  assert.equal(answered.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(store.getState().menu_message_id, 902);
  assert.equal(store.getState().pending_input.menu_message_id, 902);
});

test("global control panel custom wait rejects explicit topic/local scope", async () => {
  const edited = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "wait",
    pending_input: {
      kind: "wait_custom",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "wait",
    },
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("sendMessage should not run for invalid custom wait");
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "topic 2m",
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
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-invalid-custom-wait");
  assert.equal(store.getState().pending_input.kind, "wait_custom");
  assert.equal(
    promptFragmentAssembler.getStateForMessage({
      chat: { id: -1000000 },
      from: { id: 1001001001 },
      message_thread_id: 0,
    }).global.active,
    false,
  );
  assert.match(edited.at(-1).text, /Invalid custom global wait/u);
});

test("global control panel custom wait accepts explicit global scope", async () => {
  const edited = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "wait",
    pending_input: {
      kind: "wait_custom",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "1001001001",
      menu_message_id: 901,
      screen: "wait",
    },
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "global 2m",
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
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1000000 },
    from: { id: 1001001001 },
    message_thread_id: 0,
  });

  assert.equal(result.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input, null);
  assert.equal(waitState.global.active, true);
  assert.equal(waitState.global.flushDelayMs, 120000);
  assert.match(edited.at(-1).text, /wait global|120s|2m/u);
});

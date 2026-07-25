import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { handleIncomingMessage } from "../src/telegram/command-router.js";

const config = {
  telegramAllowedUserId: "1001001001",
  telegramAllowedUserIds: ["1001001001"],
  telegramAllowedBotIds: ["1002002002"],
  telegramForumChatId: "-1000000",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/teledex-tests-missing-config.toml",
};

function createGlobalControlPanelStore(initialState = {}) {
  let state = {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    ui_language: "eng",
    pending_input: null,
    ...initialState,
  };

  return {
    async load() {
      return JSON.parse(JSON.stringify(state));
    },
    async patch(patch) {
      state = {
        ...state,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      return JSON.parse(JSON.stringify(state));
    },
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

test("handleIncomingMessage sends the help card from General topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "teledex-operator-reference-1.png");
  assert.equal(documents[1].document.fileName, "teledex-operator-reference-2.png");
  assert.equal(documents[0].caption, undefined);
  assert.equal(documents[1].caption, undefined);
});

test("handleIncomingMessage sends the English help card from ENG General", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "teledex-operator-reference-1.png");
  assert.equal(documents[1].document.fileName, "teledex-operator-reference-2.png");
});

test("handleIncomingMessage falls back to complete help text when help-card delivery fails", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument() {
        throw new Error("upload unavailable");
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "help");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/new \[host=\.\.\.\] \[provider=\.\.\.\] \[model=\.\.\.\] \[profile=\.\.\.\] \[cwd=\.\.\.\|path=\.\.\.\]/u);
  assert.match(sent[0].text, /\/goal - show or change/u);
  assert.match(sent[0].text, /\/q <text>/u);
});

test("handleIncomingMessage sends the guidebook PDF from General topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "guide");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].document.fileName, "teledex-guidebook-eng.pdf");
  assert.match(documents[0].document.filePath, /teledex-guidebook-eng\.pdf$/u);
  const stats = await fs.stat(documents[0].document.filePath);
  assert.ok(stats.size > 1_000);
  const header = await fs.readFile(documents[0].document.filePath);
  assert.equal(header.subarray(0, 5).toString("utf8"), "%PDF-");
});

test("handleIncomingMessage sends the English guidebook PDF from ENG General", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "guide");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].document.fileName, "teledex-guidebook-eng.pdf");
  assert.match(documents[0].document.filePath, /teledex-guidebook-eng\.pdf$/u);
  const stats = await fs.stat(documents[0].document.filePath);
  assert.ok(stats.size > 1_000);
  const header = await fs.readFile(documents[0].document.filePath);
  assert.equal(header.subarray(0, 5).toString("utf8"), "%PDF-");
});

test("handleIncomingMessage keeps /guide General-only", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1000000:77",
    chat_id: "-1000000",
    topic_id: "77",
    topic_name: "Guide topic",
    lifecycle_state: "active",
    ui_language: "eng",
    workspace_binding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async recordHandledSession() {
        return session;
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "guide");
  assert.equal(result.reason, "guide-general-only");
  assert.match(sent[0].text, /works in General only/u);
});

test("handleIncomingMessage sends the English help card inside an ENG topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 88,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1000000:88",
          chat_id: "-1000000",
          topic_id: "88",
          topic_name: "ENG topic",
          lifecycle_state: "active",
          ui_language: "eng",
          workspace_binding: {
            repo_root: "/path/to/workspace",
            cwd: "/path/to/workspace",
            branch: "main",
            worktree_path: "/path/to/workspace",
          },
        };
      },
      async recordHandledSession() {},
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "teledex-operator-reference-1.png");
  assert.equal(documents[1].document.fileName, "teledex-operator-reference-2.png");
  assert.equal(documents[0].caption, undefined);
  assert.equal(documents[1].caption, undefined);
});

test("handleIncomingMessage parks topic-scoped /help when help-card delivery hits unavailable topic", async () => {
  const touched = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1000000:89",
    chat_id: "-1000000",
    topic_id: "89",
    topic_name: "Help topic",
    lifecycle_state: "active",
    ui_language: "eng",
    workspace_binding: {
      repo_root: "/path/to/workspace",
      cwd: "/path/to/workspace",
      branch: "main",
      worktree_path: "/path/to/workspace",
    },
  };
  const parkedSession = {
    ...session,
    lifecycle_state: "parked",
    parked_reason: "telegram/topic-unavailable",
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument() {
        throw new Error(
          "Telegram API sendDocument failed: Bad Request: message thread not found",
        );
      },
      async sendMessage() {
        throw new Error("should not fall back to help text");
      },
    },
    botUsername: "gatewaybot",
    config,
    lifecycleManager: {
      async handleTransportError(currentSession, error) {
        assert.equal(currentSession.session_key, session.session_key);
        assert.match(error.message, /message thread not found/u);
        return {
          handled: true,
          parked: true,
          session: parkedSession,
        };
      },
    },
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 89,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async recordHandledSession(_, handledSession, commandName) {
        touched.push({ handledSession, commandName });
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "help");
  assert.equal(result.reason, "topic-unavailable");
  assert.equal(touched.length, 1);
  assert.equal(touched[0].commandName, "help");
  assert.equal(touched[0].handledSession.lifecycle_state, "parked");
});

test("handleIncomingMessage shows suffix help from General topic", async () => {
  const sent = [];
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
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/suffix help",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "suffix");
  assert.equal(result.reason, "suffix-help");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Suffix help/u);
  assert.match(sent[0].text, /\/suffix global <text>/u);
  assert.match(sent[0].text, /\/suffix topic off/u);
});

test("handleIncomingMessage keeps suffix help in ENG when General panel language is ENG", async () => {
  const sent = [];
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
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/suffix help",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "suffix");
  assert.equal(result.reason, "suffix-help");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Suffix help/u);
  assert.match(sent[0].text, /Suffix help/u);
});

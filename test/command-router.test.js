import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";

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

test("handleIncomingMessage lets zooService short-circuit /zoo before normal session flow", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  let zooCalls = 0;

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 501 };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/zoo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("normal session flow should not run");
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
    zooService: {
      async maybeHandleIncomingMessage() {
        zooCalls += 1;
        return {
          handled: true,
          command: "zoo",
          reason: "zoo-topic-opened",
          ackText: "Project Catalog topic is ready.",
        };
      },
    },
  });

  assert.equal(zooCalls, 1);
  assert.equal(result.reason, "zoo-topic-opened");
  assert.equal(serviceState.lastCommandName, "zoo");
  assert.equal(sent[0].text, "Project Catalog topic is ready.");
});

test("handleIncomingCallbackQuery lets zooService short-circuit before panel callbacks", async () => {
  const result = await handleIncomingCallbackQuery({
    api: {},
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cb1",
      data: "zoo:v:pet1",
      from: { id: 1001001001, is_bot: false },
      message: {
        chat: { id: -1000000 },
        message_thread_id: 777,
      },
    },
    config: {
      ...config,
      codexEnableAppServerV2: true,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {},
    zooService: {
      async handleCallbackQuery() {
        return {
          handled: true,
          reason: "zoo-pet-opened",
        };
      },
    },
  });

  assert.equal(result.reason, "zoo-pet-opened");
});

test("handleIncomingMessage routes /goal to active app-server-v2 controller", async () => {
  const sent = [];
  const handledSessions = [];
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
        return { message_id: 777 };
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      codexEnableAppServerV2: true,
    },
    message: {
      text: "/goal set ship the app-server backend",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1000000:4242",
          ui_language: "eng",
        };
      },
      async recordHandledSession(_serviceState, session, commandName) {
        handledSessions.push({ session, commandName });
      },
    },
    workerPool: {
      getActiveRun(sessionKey) {
        assert.equal(sessionKey, "-1000000:4242");
        return {
          state: { backend: "app-server-v2" },
          controller: {
            async setGoal(goal) {
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
    },
  });

  assert.equal(result.command, "goal");
  assert.equal(serviceState.lastCommandName, "goal");
  assert.equal(handledSessions[0].commandName, "goal");
  assert.match(sent[0].text, /ship the app-server backend/u);
});

test("handleIncomingMessage buffers Telegram-split long /goal command text", async () => {
  const sent = [];
  const handledSessions = [];
  const goalCalls = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 10,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1000000:4242",
    ui_language: "eng",
    last_run_backend: "app-server-v2",
  };
  const sessionService = {
    async ensureSessionForMessage() {
      return session;
    },
    async recordHandledSession(_serviceState, handledSession, commandName) {
      handledSessions.push({ session: handledSession, commandName });
    },
  };
  const workerPool = {
    getActiveRun(sessionKey) {
      assert.equal(sessionKey, "-1000000:4242");
      return {
        state: { backend: "app-server-v2" },
        controller: {
          async setGoal(goal) {
            goalCalls.push(goal);
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
  };

  const firstResult = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 777 };
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      codexEnableAppServerV2: true,
    },
    message: {
      text: "/goal set first long fragment",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
  const secondResult = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 778 };
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      codexEnableAppServerV2: true,
    },
    message: {
      text: "second fragment",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 4242,
    },
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });

  assert.equal(firstResult.reason, "goal-buffered");
  assert.equal(secondResult.reason, "prompt-buffered");
  await waitFor(() => sent.length === 1);
  assert.deepEqual(goalCalls[0], {
    objective: "first long fragment\n\nsecond fragment",
    status: "active",
    tokenBudget: undefined,
  });
  assert.match(sent[0].text, /second fragment/u);
  assert.equal(handledSessions[0].commandName, "goal");
});

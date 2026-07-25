import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PROMPT_FLOW_CONFIG as config } from "../test-support/prompt-flow-fixtures.js";

test("handleIncomingMessage starts codex run for plain text in a topic", async () => {
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "run a quick task",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1000000:77",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt, session }) {
        assert.equal(prompt, "User Prompt:\nrun a quick task");
        assert.equal(session.session_key, "-1000000:77");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage blocks direct prompts while /compact is rebuilding the brief", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "continue from here",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 771,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1000000:771",
          chat_id: "-1000000",
          topic_id: "771",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async isCompacting() {
        return true;
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("compacting topic should not start a run");
      },
    },
  });

  assert.equal(result.reason, "compact-in-progress");
  assert.match(sent[0].text, /still working/i);
});

test("handleIncomingMessage queues plain follow-up while /compact is rebuilding the brief", async () => {
  const sent = [];
  const queued = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      message_id: 882,
      text: "do not touch that long-running process",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 771,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1000000:771",
          chat_id: "-1000000",
          topic_id: "771",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async isCompacting() {
        return true;
      },
      async enqueuePromptQueue(session, entry) {
        queued.push({ session, entry });
        return { position: 1 };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("compacting topic should not start a run");
      },
    },
  });

  assert.equal(result.reason, "prompt-queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].entry.rawPrompt, "do not touch that long-running process");
  assert.equal(queued[0].entry.prompt, "User Prompt:\ndo not touch that long-running process");
  assert.equal(queued[0].entry.replyToMessageId, 882);
  assert.match(sent[0].text, /Queued/u);
  assert.doesNotMatch(sent[0].text, /I am still working/u);
});

test("handleIncomingMessage defers live steer while compact recovery has an active run", async () => {
  const sent = [];
  const steered = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      message_id: 883,
      text: "apply the second change in the current run",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 771,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1000000:771",
          chat_id: "-1000000",
          topic_id: "771",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async isCompacting() {
        return true;
      },
      async enqueuePromptQueue() {
        throw new Error("active compact recovery should try live steer first");
      },
    },
    workerPool: {
      getActiveRun(sessionKey) {
        assert.equal(sessionKey, "-1000000:771");
        return {
          session_key: "-1000000:771",
          controller: null,
          state: {
            status: "rebuilding",
            finalizing: false,
          },
        };
      },
      async startPromptRun() {
        throw new Error("compacting topic should not start a new run");
      },
      async steerActiveRun(args) {
        steered.push(args);
        return { ok: true, reason: "steer-buffered" };
      },
    },
  });

  assert.equal(result.reason, "steer-buffered");
  assert.equal(steered.length, 1);
  assert.equal(steered[0].rawPrompt, "apply the second change in the current run");
  assert.equal(steered[0].message.message_id, 883);
  assert.match(sent[0].text, /steer this into the current run/u);
});

test("handleIncomingMessage starts a fresh direct run after purged topic reactivation", async () => {
  const sent = [];
  const started = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "continue",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 770,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1000000:770",
          lifecycle_state: "active",
          topic_name: "Purged topic",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
          codex_thread_id: null,
          provider_session_id: null,
          codex_rollout_path: null,
          last_context_snapshot: null,
        };
      },
    },
    workerPool: {
      async startPromptRun(payload) {
        started.push(payload);
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
  assert.equal(sent.length, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0].session.lifecycle_state, "active");
  assert.equal(started[0].session.codex_thread_id, null);
});

test("handleIncomingMessage starts direct human prompts even if legacy removed metadata remains", async () => {
  const started = [];
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("plain prompt should start the run directly");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "continue from here",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1000000:77",
          chat_id: "-1000000",
          topic_id: "77",
          topic_name: "Legacy topic",
          lifecycle_state: "active",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun(payload) {
        started.push(payload);
        return { ok: true, reason: "started" };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, `User Prompt:
continue from here`);
  assert.equal(started[0].rawPrompt, "continue from here");
});

test("handleIncomingMessage preserves captioned attachments when direct start fails", async () => {
  const sent = [];
  const buffered = [];
  const session = {
    session_key: "-1000000:77",
    chat_id: "-1000000",
    topic_id: "77",
    lifecycle_state: "active",
    execution_host_id: "workera",
    execution_host_label: "workera",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: sent.length };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      caption: "Review the attachment",
      photo: [
        { file_id: "small-photo", file_unique_id: "small", file_size: 10 },
      ],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_id: 991,
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async isCompacting() {
        return false;
      },
      async getPendingPromptAttachments() {
        return [];
      },
      async ingestIncomingAttachments() {
        return [
          {
            kind: "photo",
            file_path: "/tmp/incoming-direct-photo.jpg",
            is_image: true,
          },
        ];
      },
      async bufferPendingPromptAttachments(currentSession, attachments) {
        assert.equal(currentSession.session_key, session.session_key);
        buffered.push(...attachments);
      },
    },
    workerPool: {
      async startPromptRun(payload) {
        assert.equal(payload.rawPrompt, "Review the attachment");
        assert.equal(payload.attachments.length, 1);
        return {
          ok: false,
          reason: "host-unavailable",
          hostId: "workera",
          hostLabel: "workera",
        };
      },
    },
  });

  assert.equal(result.reason, "host-unavailable");
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0].file_path, "/tmp/incoming-direct-photo.jpg");
  assert.match(sent[0].text, /workera/u);
});

test("handleIncomingMessage steers the active run instead of returning busy when the topic is already running", async () => {
  const sent = [];
  const steerCalls = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "Also add this.",
      message_id: 990,
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 78,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1000000:78",
          chat_id: "-1000000",
          topic_id: "78",
          prompt_suffix_enabled: true,
          prompt_suffix_text: "SUFFIX",
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [];
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      async steerActiveRun(args) {
        steerCalls.push(args);
        return {
          ok: true,
          reason: "steered",
          inputCount: 1,
        };
      },
    },
  });

  assert.equal(result.reason, "steered");
  assert.equal(steerCalls.length, 1);
  assert.equal(steerCalls[0].rawPrompt, "Also add this.");
  assert.match(sent[0].text, /steer this into the current run/u);
});

test("handleIncomingMessage buffers long prompt fragments without reactivating the topic session", async () => {
  const enqueued = [];
  let ensuredSessionCount = 0;
  let ensuredRunnableCount = 0;

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("buffered fragments should not send a reply yet");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "part 1 of a very long prompt",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 79,
    },
    promptFragmentAssembler: {
      getStateForMessage() {
        return {
          active: false,
          mode: "auto",
          messageCount: 0,
        };
      },
      hasPendingForSameTopicMessage() {
        return false;
      },
      shouldBufferMessage() {
        return true;
      },
      enqueue(entry) {
        enqueued.push(entry);
      },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        ensuredSessionCount += 1;
        return {
          session_key: "-1000000:79",
          lifecycle_state: "parked",
        };
      },
      async ensureRunnableSessionForMessage() {
        ensuredRunnableCount += 1;
        throw new Error("buffer-only flow should not reactivate the session");
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("buffer-only flow should not start a run");
      },
    },
  });

  assert.equal(result.reason, "prompt-buffered");
  assert.equal(ensuredSessionCount, 1);
  assert.equal(ensuredRunnableCount, 0);
  assert.equal(enqueued.length, 1);
});

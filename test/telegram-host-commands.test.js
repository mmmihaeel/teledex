import test from "node:test";
import assert from "node:assert/strict";

import { handleIncomingMessage } from "../src/telegram/command-router.js";
import {
  buildIdleWorkerPool,
  config,
  createGlobalControlSessionService,
  createServiceState,
  createTopicSession,
  createTopicSessionService,
} from "../test-support/control-panel-fixtures.js";

test("handleIncomingMessage reports known hosts with /hosts", async () => {
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
      text: "/hosts",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
    },
    serviceState: createServiceState(),
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "hosts");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Hosts/u);
  assert.match(sent[0].text, /- local: ready/u);
  assert.match(sent[0].text, /- workerz: unavailable \(codex-auth\)/u);
});

test("handleIncomingMessage reports the bound topic host with /host", async () => {
  const sent = [];
  const session = createTopicSession();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/host",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "host");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Host workera/u);
  assert.match(sent[0].text, /topic_binding: workera/u);
  assert.match(sent[0].text, /binding_immutable: yes/u);
});

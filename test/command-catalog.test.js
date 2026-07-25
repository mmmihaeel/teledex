import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramCommandSyncPlan,
  syncTelegramCommandCatalog,
} from "../src/telegram/command-catalog.js";

test("buildTelegramCommandSyncPlan includes full Agent forum/private catalogs", () => {
  const plan = buildTelegramCommandSyncPlan("agent", "-1000000");

  assert.equal(plan.length, 4);
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1000000"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "global"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1000000"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "menu"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1000000"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "zoo"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1000000"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "limits"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1000000"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "goal"),
    true,
  );
  assert.deepEqual(
    plan
      .filter((entry) => entry.scope.type === "all_private_chats")
      .map((entry) => entry.commands.map((command) => command.command)),
    [
      ["help", "status", "interrupt"],
    ],
  );
});

test("buildTelegramCommandSyncPlan does not expose removed legacy commands", () => {
  const plan = buildTelegramCommandSyncPlan("agent", "-1000000");

  const commands = [
    ...new Set(
      plan.flatMap((entry) => entry.commands.map((command) => command.command)),
    ),
  ];
  assert.equal(commands.includes("auto"), false);
});

test("buildTelegramCommandSyncPlan rejects unknown catalogs", () => {
  assert.throws(
    () => buildTelegramCommandSyncPlan("legacy", "-1000000"),
    /Unsupported Telegram command catalog kind: legacy/u,
  );
});

test("syncTelegramCommandCatalog applies every scoped command list", async () => {
  const calls = [];
  const api = {
    async setMyCommands(params) {
      calls.push(params);
      return true;
    },
  };

  const plan = await syncTelegramCommandCatalog(api, "agent", "-1000000");

  assert.equal(calls.length, plan.length);
  assert.deepEqual(
    calls.at(0),
    {
      commands: plan[0].commands,
      scope: plan[0].scope,
    },
  );
  assert.equal("language_code" in calls.at(1), false);
});

test("syncTelegramCommandCatalog rejects unknown catalogs", async () => {
  const api = {
    async setMyCommands() {
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    () => syncTelegramCommandCatalog(api, "legacy", "-1000000"),
    /Unsupported Telegram command catalog kind: legacy/u,
  );
});

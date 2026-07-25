#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const TELEDEX_REPO = path.resolve(
  process.env.TELEDEX_REPO || DEFAULT_REPO_ROOT,
);
const DEFAULT_TIMEOUT_MS = 360000;
const WAIT_POLL_MS = 2000;
const SMOKE_FIXTURE = [
  "export function bridgeSmoke() {",
  "  return \"pitlane bridge smoke\";",
  "}",
  "",
].join("\n");
const NOISY_JSONL_LINES = Array.from({ length: 120 }, (_, index) =>
  JSON.stringify({
    index,
    marker: "HOOK_ECONOMY_NOISY_JSONL",
    payload: "x".repeat(160),
  }));
const teledexRequire = createRequire(path.join(TELEDEX_REPO, "package.json"));
const { Api, TelegramClient } = teledexRequire("telegram");
const { StringSession } = teledexRequire("telegram/sessions/index.js");

function repoModule(relativePath) {
  return pathToFileURL(path.join(TELEDEX_REPO, relativePath)).href;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  console.log(`Usage: node src/cli/run-hook-economy-canary.js [options]

Options:
  --workspace <path>   Workspace for the fresh Teledex session. Default: controlled state fixture.
  --out-dir <path>     Directory for the JSON result. Default: <stateRoot>/canaries/hook-economy.
  --host <id>          Execution host id. Default: runtime currentHostId or local.
  --timeout-ms <ms>    Completion timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --help               Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    workspace: null,
    outDir: null,
    hostId: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--workspace") {
      args.workspace = argv[++index];
      continue;
    }
    if (arg === "--out-dir") {
      args.outDir = argv[++index];
      continue;
    }
    if (arg === "--host") {
      args.hostId = argv[++index];
      continue;
    }
    if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++index]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }

  args.workspace = args.workspace ? path.resolve(args.workspace) : null;
  args.outDir = args.outDir ? path.resolve(args.outDir) : null;
  return args;
}

async function writeCanaryFixtures(workspace) {
  const fixturesDir = path.join(workspace, "fixtures");
  await fs.mkdir(fixturesDir, { recursive: true });
  await fs.writeFile(path.join(fixturesDir, "smoke.js"), SMOKE_FIXTURE, "utf8");
  await fs.writeFile(
    path.join(fixturesDir, "noisy.jsonl"),
    `${NOISY_JSONL_LINES.join("\n")}\n`,
    "utf8",
  );
}

async function validateCanaryFixtures(workspace) {
  const smokePath = path.join(workspace, "fixtures", "smoke.js");
  const noisyPath = path.join(workspace, "fixtures", "noisy.jsonl");
  const [smoke, noisy] = await Promise.all([
    fs.readFile(smokePath, "utf8").catch(() => null),
    fs.readFile(noisyPath, "utf8").catch(() => null),
  ]);
  if (smoke !== SMOKE_FIXTURE) {
    throw new Error(`canary fixture mismatch: ${smokePath}`);
  }
  if (noisy !== `${NOISY_JSONL_LINES.join("\n")}\n`) {
    throw new Error(`canary fixture mismatch: ${noisyPath}`);
  }
}

async function prepareCanaryWorkspace({ workspace, workspaceRoot = null, outDir, stamp }) {
  if (workspace) {
    await validateCanaryFixtures(workspace);
    return workspace;
  }

  const generatedWorkspace = workspaceRoot
    ? path.join(workspaceRoot, stamp)
    : path.join(outDir, "workspaces", stamp);
  await writeCanaryFixtures(generatedWorkspace);
  return generatedWorkspace;
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(WAIT_POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function buildCommandEntities(commandName) {
  return [
    new Api.MessageEntityBotCommand({
      offset: 0,
      length: commandName.length + 1,
    }),
  ];
}

async function sendTopicMessage(userClient, chatId, topicId, text, {
  commandName = null,
} = {}) {
  return userClient.sendMessage(Number(chatId), {
    message: text,
    replyTo: Number(topicId),
    topMsgId: Number(topicId),
    formattingEntities: commandName ? buildCommandEntities(commandName) : undefined,
  });
}

async function listTopicReplies(userClient, chatId, topicId) {
  const peer = await userClient.getInputEntity(Number(chatId));
  const response = await userClient.invoke(
    new Api.messages.GetReplies({
      peer,
      msgId: Number(topicId),
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit: 100,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }),
  );

  return Array.isArray(response?.messages)
    ? response.messages.map((message) => ({
      id: Number(message.id),
      text: String(message.message || "").trim(),
      fromId:
        Number(message?.fromId?.userId ?? message?.fromId?.channelId ?? 0) || null,
      replyToTopId:
        Number(message?.replyTo?.replyToTopId ?? message?.replyTo?.replyToMsgId ?? 0)
        || null,
    }))
    : [];
}

async function waitForRunCompletion(sessionStore, session, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  expectedToken = null,
} = {}) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (!current || !["completed", "failed", "interrupted"].includes(current.last_run_status)) {
      return null;
    }
    if (
      expectedToken
      && current.last_run_status === "completed"
      && !String(current.last_agent_reply || "").includes(expectedToken)
    ) {
      return null;
    }
    return current;
  }, timeoutMs, `run completion for ${session.session_key}`);
}

async function waitForThreadReplyContaining(userClient, chatId, topicId, needle) {
  return waitFor(async () => {
    const replies = await listTopicReplies(userClient, chatId, topicId);
    return replies.find((reply) => reply.text.includes(needle)) || null;
  }, DEFAULT_TIMEOUT_MS, `thread reply containing ${needle} in ${chatId}:${topicId}`);
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

function summarizeCommandEvent(record) {
  const item = record?.params?.item;
  if (!item || item.type !== "commandExecution") {
    return null;
  }
  return {
    id: item.id || null,
    command: item.command || null,
    cwd: item.cwd || null,
    status: item.status || null,
    exitCode: item.exitCode ?? null,
  };
}

function pickCanaryEvidence(commandEvents) {
  const smokeCommands = commandEvents.filter((entry) =>
    String(entry.command || "").includes("fixtures/smoke.js"));
  const rtkGuardCommands = commandEvents.filter((entry) =>
    String(entry.command || "").includes("fixtures/noisy.jsonl")
    || String(entry.command || "").includes("rtk-output-guard"));

  return {
    smoke: smokeCommands.at(-1) || null,
    rtkGuard: rtkGuardCommands.at(-1) || null,
    pitlaneRewriteObserved: smokeCommands.some((entry) =>
      String(entry.command || "").includes("pitlane lines")),
    rawCatObserved: smokeCommands.some((entry) =>
      /(?:^|[\s"'])cat\s+fixtures\/smoke\.js(?:$|[\s"'])/u.test(String(entry.command || ""))),
    rtkPreGuardRewriteObserved: rtkGuardCommands.some((entry) =>
      String(entry.command || "").includes("rtk-output-guard")),
  };
}

function pickHookEconomyEvidence(summary) {
  const latest = Array.isArray(summary?.latest) ? summary.latest : [];
  const byPlugin = summary?.byPlugin || {};
  const byDecision = summary?.byDecision || {};
  const pluginKeys = Object.keys(byPlugin).join(" ");
  const eventNameIs = (entry, expected) =>
    String(entry.eventName || "").toLowerCase() === expected.toLowerCase();
  const pitlaneObserved = /pitlane/iu.test(pluginKeys)
    || latest.some((entry) => /pitlane/iu.test(String(entry.pluginId || entry.key || "")));
  const rtkObserved = /rtk/iu.test(pluginKeys)
    || latest.some((entry) => /rtk/iu.test(String(entry.pluginId || entry.key || "")));
  const pitlanePreToolUseRewrite = latest.some((entry) =>
    /pitlane/iu.test(String(entry.pluginId || entry.key || ""))
    && eventNameIs(entry, "PreToolUse")
    && entry.decisionType === "rewrite");
  const rtkPreToolUseGuardRewrite = latest.some((entry) =>
    /rtk/iu.test(String(entry.pluginId || entry.key || ""))
    && eventNameIs(entry, "PreToolUse")
    && entry.decisionType === "rewrite");
  const rtkPostToolUseCompact = latest.some((entry) =>
    /rtk/iu.test(String(entry.pluginId || entry.key || ""))
    && eventNameIs(entry, "PostToolUse")
    && entry.decisionType === "compact");
  const rtkPostToolUseObserved = latest.some((entry) =>
    /rtk/iu.test(String(entry.pluginId || entry.key || ""))
    && eventNameIs(entry, "PostToolUse"));
  const rtkModelVisibleProof = latest.some((entry) =>
    /rtk/iu.test(String(entry.pluginId || entry.key || ""))
    && eventNameIs(entry, "PostToolUse")
    && Number(entry.outputOriginalBytes || 0) > Number(entry.outputModelVisibleBytes || 0));
  const outputSavingsObserved = Number(summary?.totals?.outputOriginalBytes || 0)
    > Number(summary?.totals?.outputModelVisibleBytes || 0);

  return {
    completedRuns: summary?.completedRuns || 0,
    pitlaneObserved,
    rtkObserved,
    pitlanePreToolUseRewrite,
    rtkPreToolUseGuardRewrite,
    rtkPostToolUseObserved,
    rtkPostToolUseCompact,
    rtkModelVisibleProof,
    outputSavingsObserved,
    byPlugin,
    byDecision,
    totals: summary?.totals || {},
    latest,
  };
}

function buildCanaryChecks({ completed, commandEvidence, hookEvidence }) {
  return {
    completed: completed.last_run_status === "completed",
    pitlanePreToolUseRewrite:
      commandEvidence.pitlaneRewriteObserved || hookEvidence.pitlanePreToolUseRewrite,
    rtkPreToolUseGuardRewrite:
      commandEvidence.rtkPreGuardRewriteObserved || hookEvidence.rtkPreToolUseGuardRewrite,
    rtkPostToolUseObserved: hookEvidence.rtkPostToolUseObserved,
    rtkModelVisibleProof: hookEvidence.rtkModelVisibleProof,
  };
}

function missingCanaryChecks(checks) {
  return Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
}

function completedRunTimestamp(completed) {
  return completed?.last_run_finished_at || completed?.last_run_completed_at || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const [
    { loadRuntimeConfig },
    { ensureStateLayout },
    { SessionStore },
    { SessionService },
    { TelegramBotApiClient },
    {
      loadTelegramUserBootstrap,
      readTelegramUserSession,
    },
  ] = await Promise.all([
    import(repoModule("src/config/runtime-config.js")),
    import(repoModule("src/state/layout.js")),
    import(repoModule("src/session-manager/session-store.js")),
    import(repoModule("src/session-manager/session-service.js")),
    import(repoModule("src/telegram/bot-api-client.js")),
    import(repoModule("src/live-user/client.js")),
  ]);

  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const sessionStore = new SessionStore(layout.sessions);
  const sessionService = new SessionService({ sessionStore, config });
  const api = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const userBootstrap = await loadTelegramUserBootstrap();
  if (!userBootstrap.userConfig) {
    throw userBootstrap.userConfigError || new Error("Missing Telegram user config");
  }

  const sessionString = await readTelegramUserSession(userBootstrap.paths);
  if (!sessionString) {
    throw new Error(`Missing Telegram user session: ${userBootstrap.paths.sessionFilePath}`);
  }

  const userClient = new TelegramClient(
    new StringSession(sessionString),
    userBootstrap.userConfig.apiId,
    userBootstrap.userConfig.apiHash,
    { connectionRetries: 5 },
  );

  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  const chatId = Number(config.telegramForumChatId);
  const outDir = args.outDir
    || path.join(config.stateRoot, "canaries", "hook-economy");
  await fs.mkdir(outDir, { recursive: true });
  const workspace = await prepareCanaryWorkspace({
    workspace: args.workspace,
    workspaceRoot: path.join(
      config.workspaceRootPath || TELEDEX_REPO,
      "work",
      "labs",
      "agents",
      "teledex-hook-economy-canaries",
    ),
    outDir,
    stamp,
  });
  const workspaceBinding = await sessionService.resolveBindingPath(workspace);

  try {
    await userClient.connect();
    const { forumTopic, session } = await sessionService.createTopicSession({
      api,
      executionHostId: args.hostId || config.currentHostId || "local",
      message: { chat: { id: chatId } },
      title: `Hook Trust Canary ${stamp}`,
      workspaceBinding,
    });
    const topic = {
      topicId: Number(forumTopic.message_thread_id),
      topicName: forumTopic.name,
      session,
    };

    const token = `HOOK_CANARY_DONE_${stamp}`;
    const prompt = [
      "Live hook canary. Use exactly three shell tool calls and do not call Pitlane or RTK manually.",
      "The current cwd is the controlled canary workspace. First shell command must be exactly: cat fixtures/smoke.js",
      "Second shell command must be exactly: python3 -c 'for i in range(1000): print(f\"RTK_POST_CANARY_{i:04d} \" + \"x\"*220)'",
      "Third shell command must be exactly: head -n 5 fixtures/noisy.jsonl",
      `After all three commands finish, reply exactly with: ${token}`,
    ].join("\n");

    await sendTopicMessage(userClient, chatId, topic.topicId, prompt);
    const completed = await waitForRunCompletion(sessionStore, topic.session, {
      expectedToken: token,
    });
    const reply = await waitForThreadReplyContaining(
      userClient,
      chatId,
      topic.topicId,
      token,
    );

    const sessionDir = sessionStore.getSessionDir(chatId, topic.topicId);
    const jsonlPath = path.join(sessionDir, "exec-json-run.jsonl");
    const hookEconomyPath = path.join(sessionDir, "hook-economy.json");
    const records = await readJsonl(jsonlPath);
    const commandEvents = records
      .map(summarizeCommandEvent)
      .filter(Boolean);
    const evidence = pickCanaryEvidence(commandEvents);
    const hookEconomy = await readJson(hookEconomyPath);
    const hookEvidence = pickHookEconomyEvidence(hookEconomy);
    const checks = buildCanaryChecks({
      completed,
      commandEvidence: evidence,
      hookEvidence,
    });
    const missingChecks = missingCanaryChecks(checks);
    const ok = missingChecks.length === 0;
    const result = {
      ok,
      token,
      topic,
      workspace,
      sessionDir,
      jsonlPath,
      hookEconomyPath,
      threadReplyId: reply.id,
      lastAgentReply: completed.last_agent_reply || null,
      commandCount: commandEvents.length,
      evidence,
      hookEvidence,
      checks,
      missingChecks,
      completedStatus: completed.last_run_status,
      completedAt: completedRunTimestamp(completed),
    };

    const outPath = path.join(outDir, `live-hook-economy-canary-${stamp}.json`);
    await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...result, outPath }, null, 2));
    process.exitCode = ok ? 0 : 2;
  } finally {
    await userClient.disconnect().catch(() => {});
  }
}

export {
  buildCanaryChecks,
  completedRunTimestamp,
  missingCanaryChecks,
  parseArgs,
  pickCanaryEvidence,
  pickHookEconomyEvidence,
  prepareCanaryWorkspace,
  summarizeCommandEvent,
  validateCanaryFixtures,
  writeCanaryFixtures,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

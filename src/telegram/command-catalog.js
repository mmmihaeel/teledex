function buildCommand(command, description) {
  return { command, description };
}

const AGENT_GROUP_COMMANDS = [
  buildCommand("help", "Show the quick help card"),
  buildCommand("guide", "Send the beginner PDF guidebook"),
  buildCommand("clear", "Clear General and keep only the active menu"),
  buildCommand("new", "Create a new work topic"),
  buildCommand("hosts", "Show available execution hosts"),
  buildCommand("host", "Show one execution host status"),
  buildCommand("zoo", "Open the dedicated Project Catalog topic"),
  buildCommand("status", "Show session and runtime status"),
  buildCommand("limits", "Show the current Codex rate limits"),
  buildCommand("global", "Open the General-topic global settings menu"),
  buildCommand("menu", "Open the topic-local settings menu"),
  buildCommand("language", "Show the UI language"),
  buildCommand("q", "Queue the next Agent prompt"),
  buildCommand("wait", "Manage the manual prompt buffer"),
  buildCommand("suffix", "Show or change prompt suffixes"),
  buildCommand("model", "Set or inspect the Agent model"),
  buildCommand("reasoning", "Set or inspect Agent reasoning"),
  buildCommand("interrupt", "Stop the active run"),
  buildCommand("diff", "Send the current workspace diff"),
  buildCommand("goal", "Show or change the app-server-v2 goal"),
  buildCommand("compact", "Rebuild the session brief"),
  buildCommand("purge", "Reset local session state"),
];

const AGENT_PRIVATE_COMMANDS = [
  buildCommand("help", "Show the private-lane help"),
  buildCommand("status", "Show emergency lane status"),
  buildCommand("interrupt", "Stop the emergency run"),
];

function buildCommandEntry(scope, commands) {
  return {
    scope,
    commands,
    languageCode: null,
  };
}

function buildScopeEntries(scopes) {
  return scopes.map((scope) => ({
    scope,
    languageCode: null,
  }));
}

function buildTelegramCommandClearPlan(kind, forumChatId) {
  const normalizedForumChatId = String(forumChatId || "").trim();
  if (!normalizedForumChatId) {
    throw new Error("buildTelegramCommandClearPlan requires forumChatId");
  }

  if (kind === "agent") {
    return buildScopeEntries([
      { type: "default" },
      { type: "all_group_chats" },
      { type: "chat", chat_id: normalizedForumChatId },
      { type: "all_private_chats" },
    ]);
  }

  throw new Error(`Unsupported Telegram command catalog kind: ${kind}`);
}

export function buildTelegramCommandSyncPlan(
  kind,
  forumChatId,
) {
  const normalizedForumChatId = String(forumChatId || "").trim();
  if (!normalizedForumChatId) {
    throw new Error("buildTelegramCommandSyncPlan requires forumChatId");
  }

  if (kind === "agent") {
    return [
      buildCommandEntry({ type: "default" }, AGENT_GROUP_COMMANDS),
      buildCommandEntry({ type: "all_group_chats" }, AGENT_GROUP_COMMANDS),
      buildCommandEntry(
        { type: "chat", chat_id: normalizedForumChatId },
        AGENT_GROUP_COMMANDS,
      ),
      buildCommandEntry(
        { type: "all_private_chats" },
        AGENT_PRIVATE_COMMANDS,
      ),
    ];
  }

  throw new Error(`Unsupported Telegram command catalog kind: ${kind}`);
}

export async function syncTelegramCommandCatalog(
  api,
  kind,
  forumChatId,
  options = {},
) {
  const plan = buildTelegramCommandSyncPlan(kind, forumChatId, options);
  if (plan.length === 0) {
    const clearPlan = buildTelegramCommandClearPlan(kind, forumChatId);
    for (const entry of clearPlan) {
      const params = {
        scope: entry.scope,
      };
      if (entry.languageCode) {
        params.language_code = entry.languageCode;
      }
      await api.deleteMyCommands(params);
    }
    return plan;
  }

  for (const entry of plan) {
    const params = {
      commands: entry.commands,
      scope: entry.scope,
    };
    if (entry.languageCode) {
      params.language_code = entry.languageCode;
    }
    await api.setMyCommands(params);
  }

  return plan;
}

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
export const PROMPT_FLOW_CONFIG = config;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate,
  {
    timeoutMs = 300,
    intervalMs = 5,
  } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for test condition");
}

import { runHostBash, shellQuote } from "../hosts/host-command-runner.js";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeTurnStatus(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase() ?? null;
  if (normalized === "inprogress") {
    return "in_progress";
  }
  return normalized;
}

export function parseDeepSeekThreadSnapshot(payload) {
  const thread =
    payload?.thread && typeof payload.thread === "object"
      ? payload.thread
      : payload;
  if (!thread || typeof thread !== "object") {
    return null;
  }

  const turnContainer =
    Array.isArray(payload?.turns)
      ? payload
      : thread;
  const turns = Array.isArray(turnContainer.turns) ? turnContainer.turns : [];
  const latestTurn = turns.length > 0 ? turns.at(-1) : null;
  const latestTurnId =
    normalizeOptionalText(latestTurn?.id)
    || normalizeOptionalText(thread.latest_turn_id)
    || null;
  const latestTurnStatus =
    normalizeTurnStatus(latestTurn?.status)
    || normalizeTurnStatus(thread.latest_turn_status)
    || null;

  return {
    threadId: normalizeOptionalText(thread.id) || null,
    updatedAt: normalizeOptionalText(thread.updated_at) || null,
    latestTurnId,
    latestTurnStatus,
    latestUsage:
      latestTurn?.usage && typeof latestTurn.usage === "object"
        ? latestTurn.usage
        : thread.latest_usage && typeof thread.latest_usage === "object"
          ? thread.latest_usage
        : null,
  };
}

export async function fetchDeepSeekThreadSnapshot({
  apiUrl,
  connectTimeoutSecs = 8,
  currentHostId,
  executionHost,
  runHostBashImpl = runHostBash,
  threadId,
} = {}) {
  const baseUrl = normalizeOptionalText(apiUrl)?.replace(/\/+$/u, "");
  const normalizedThreadId = normalizeOptionalText(threadId);
  const host = executionHost?.host ?? executionHost ?? null;
  if (!baseUrl || !normalizedThreadId || !host) {
    return null;
  }

  const url = `${baseUrl}/v1/threads/${encodeURIComponent(normalizedThreadId)}`;
  const script = [
    "set -euo pipefail",
    "need() { command -v \"$1\" >/dev/null 2>&1 || exit 127; }",
    "need curl",
    "need jq",
    `curl -fsS --max-time 3 ${shellQuote(url)} | jq -c '(.thread // .) as $t | (.turns // $t.turns // []) as $turns | {id: ($t.id // null), updated_at: ($t.updated_at // null), latest_turn_id: (($turns[-1].id // $t.latest_turn_id) // null), latest_turn_status: (($turns[-1].status // $t.latest_turn_status) // null), latest_usage: ($turns[-1].usage // null)}'`,
  ].join("\n");
  try {
    const { stdout } = await runHostBashImpl({
      connectTimeoutSecs,
      currentHostId,
      host,
      maxBufferBytes: 256 * 1024,
      script,
      timeoutMs: 5000,
    });
    return parseDeepSeekThreadSnapshot(JSON.parse(stdout));
  } catch {
    return null;
  }
}

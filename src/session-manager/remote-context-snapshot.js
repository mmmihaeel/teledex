import { normalizeContextSnapshot } from "./context-snapshot.js";
import { runHostBash } from "../hosts/host-command-runner.js";

export const CONTEXT_SNAPSHOT_SOURCE_REMOTE_CODEX_SESSIONS =
  "remote-codex-sessions";

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function isSafeThreadId(value) {
  return /^[A-Za-z0-9._:-]+$/u.test(String(value ?? ""));
}

function isRemoteReadyHost(executionHost, currentHostId) {
  const hostId = normalizeOptionalText(executionHost?.hostId);
  if (!hostId || hostId === normalizeOptionalText(currentHostId)) {
    return false;
  }
  return Boolean(executionHost?.ok && executionHost?.host?.ssh_target);
}

function buildRemoteSnapshotScript(threadId) {
  return [
    "set -euo pipefail",
    `thread_id=${JSON.stringify(threadId)}`,
    'root="${CODEX_SESSIONS_ROOT:-$HOME/.codex/sessions}"',
    'if [[ ! -d "$root" ]]; then',
    "  exit 0",
    "fi",
    'rollout_path="$(',
    '  find "$root" -type f -name "*${thread_id}.jsonl" -printf \'%T@ %p\\n\' 2>/dev/null \\',
    "    | sort -nr \\",
    "    | head -n 1 \\",
    "    | cut -d' ' -f2-",
    ')"',
    'if [[ -z "$rollout_path" || ! -f "$rollout_path" ]]; then',
    "  exit 0",
    "fi",
    'tail -c 4194304 "$rollout_path" \\',
    "  | awk 'NR == 1 && $0 !~ /^\\{/ { next } { print }' \\",
    "  | jq -c -sR --arg path \"$rollout_path\" --arg thread \"$thread_id\" '",
    String.raw`
      def n($v): if ($v | type) == "number" then $v else null end;
      def usage($u):
        if ($u | type) != "object" then null else
          {
            input_tokens: n($u.input_tokens),
            cached_input_tokens: n($u.cached_input_tokens),
            output_tokens: n($u.output_tokens),
            reasoning_tokens: n($u.reasoning_tokens // $u.reasoning_output_tokens),
            total_tokens: n($u.total_tokens)
          }
        end;
      [split("\n")[] | fromjson?] as $events
      | ($events
          | map(select(.type == "event_msg" and .payload.type == "task_started")
              | .payload.model_context_window
              | select(type == "number"))
          | last) as $task_window
      | ($events
          | map(select(.type == "event_msg" and .payload.type == "token_count" and .payload.info)
              | {timestamp, info: .payload.info})
          | last) as $token
      | if ($token == null and $task_window == null) then empty else
          {
            captured_at: ($token.timestamp // null),
            session_id: null,
            thread_id: $thread,
            model_context_window: (($token.info.model_context_window // $task_window) // null),
            last_token_usage: usage($token.info.last_token_usage),
            rollout_path: null
          }
        end
    '`,
  ].join("\n");
}

export async function fetchRemoteCodexContextSnapshot({
  connectTimeoutSecs = 5,
  currentHostId,
  executionHost,
  runHostBashImpl = runHostBash,
  threadId,
} = {}) {
  const normalizedThreadId = normalizeOptionalText(threadId);
  if (!normalizedThreadId || !isSafeThreadId(normalizedThreadId)) {
    return null;
  }
  if (!isRemoteReadyHost(executionHost, currentHostId)) {
    return null;
  }

  const result = await runHostBashImpl({
    connectTimeoutSecs,
    currentHostId,
    host: executionHost.host,
    maxBufferBytes: 64 * 1024,
    script: buildRemoteSnapshotScript(normalizedThreadId),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  });
  const text = String(result?.stdout ?? "").trim();
  if (!text) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text.split(/\r?\n/u).at(-1));
  } catch {
    return null;
  }

  const snapshot = normalizeContextSnapshot(parsed);
  return snapshot
    ? {
        snapshot,
        source: CONTEXT_SNAPSHOT_SOURCE_REMOTE_CODEX_SESSIONS,
      }
    : null;
}

import {
  buildSshBaseArgs,
  shellQuote,
} from "../hosts/host-command-runner.js";
import { resolveExecutionCwd } from "../hosts/host-paths.js";
import { startExecChild } from "../codex-exec/telegram-exec-runner.js";

export const DEEPSEEK_HTTP_BACKEND = "deepseek-http";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizePathSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || fallback;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildDeepSeekHttpScript({
  apiUrl,
  autoApprove,
  cwd,
  mode,
  model,
  requestedThreadId,
  sessionKey,
  trustMode,
  allowShell,
}) {
  const escapedThreadId = normalizeOptionalText(requestedThreadId) || "";
  const pollDelay = 2;
  const maxTurnWaitSecs = normalizePositiveInteger(
    process.env.DEEPSEEK_HTTP_MAX_TURN_WAIT_SECS,
    3600,
  );
  const maxPolls = Math.max(1, Math.ceil(maxTurnWaitSecs / pollDelay));
  return [
    "set -euo pipefail",
    "need() { command -v \"$1\" >/dev/null 2>&1 || { echo \"missing required command: $1\" >&2; exit 127; }; }",
    "need curl",
    "need jq",
    `api_url=${shellQuote(apiUrl.replace(/\/+$/u, ""))}`,
    `cwd=${shellQuote(cwd)}`,
    `model=${shellQuote(model)}`,
    `mode=${shellQuote(mode)}`,
    `allow_shell=${allowShell ? "true" : "false"}`,
    `trust_mode=${trustMode ? "true" : "false"}`,
    `auto_approve=${autoApprove ? "true" : "false"}`,
    "max_output_chars=60000",
    "max_message_chars=120000",
    "max_error_chars=4000",
    "max_progress_chars=500",
    `requested_thread_id=${shellQuote(escapedThreadId)}`,
    `session_key=${shellQuote(sanitizePathSegment(sessionKey || "deepseek", "deepseek"))}`,
    'input_file="$(mktemp "/tmp/deepseek-gateway-${session_key}.input.XXXXXX")"',
    'prompt_file="$(mktemp "/tmp/deepseek-gateway-${session_key}.XXXXXX")"',
    'system_prompt_file="$(mktemp "/tmp/deepseek-gateway-${session_key}.system.XXXXXX")"',
    'emitted_items_file="$(mktemp "/tmp/deepseek-gateway-${session_key}.seen.XXXXXX")"',
    'trap \'rm -f "$input_file" "$prompt_file" "$system_prompt_file" "$emitted_items_file"\' EXIT',
    'cat > "$input_file"',
    'if jq -e \'type == "object" and has("prompt")\' "$input_file" >/dev/null 2>&1; then',
    '  jq -r \'.prompt // ""\' "$input_file" > "$prompt_file"',
    '  jq -r \'.system_prompt // ""\' "$input_file" > "$system_prompt_file"',
    "else",
    '  cp "$input_file" "$prompt_file"',
    '  : > "$system_prompt_file"',
    "fi",
    'cap_text() { jq -Rr --argjson n "$max_progress_chars" \'if length > $n then .[0:$n] + "\\n[truncated by gateway]" else . end\'; }',
    'emit_progress_item() {',
    '  local text',
    '  text="$(printf "%s" "${1:-}" | cap_text)"',
    '  [[ -n "$text" ]] || return 0',
    '  jq -cn --arg text "$text" \'{type:"item.completed", item:{type:"reasoning", text:$text}}\'',
    '}',
    'emit_seen_once() {',
    '  local key="$1"',
    '  grep -qxF "$key" "$emitted_items_file" 2>/dev/null && return 1',
    '  printf "%s\\n" "$key" >> "$emitted_items_file"',
    '  return 0',
    '}',
    'emit_deepseek_progress_items() {',
    '  [[ -n "${detail:-}" && -n "${turn_id:-}" ]] || return 0',
    '  jq -cr --arg id "$turn_id" \'.items[]? | select(.turn_id == $id)\' <<<"$detail" | while IFS= read -r item; do',
    '    item_id="$(jq -r \'.id // empty\' <<<"$item")"',
    '    kind="$(jq -r \'.kind // empty\' <<<"$item")"',
    '    status="$(jq -r \'.status // empty\' <<<"$item")"',
    '    [[ -n "$item_id" && -n "$kind" && -n "$status" ]] || continue',
    '    emit_seen_once "$item_id:$status" || continue',
    '    case "$kind:$status" in',
    '      command_execution:in_progress)',
    '        command="$(jq -r \'((.detail | try fromjson catch {} | .command) // .metadata.task_id // .summary // "command") | tostring\' <<<"$item")"',
    '        jq -cn --arg command "$command" \'{type:"item.started", item:{type:"command_execution", command:$command}}\'',
    '        ;;',
    '      command_execution:completed|command_execution:failed)',
    '        command="$(jq -r \'.metadata.task_id // .summary // "command"\' <<<"$item")"',
    '        exit_code="$(jq -r \'.metadata.exit_code // 0\' <<<"$item")"',
    '        stream_delta="$(jq -r \'if .metadata.stream_delta == true then "true" else "false" end\' <<<"$item")"',
    '        output="$(jq -r --argjson n "$max_output_chars" \'def cap($n): if length > $n then .[0:$n] + "\\n[truncated by gateway]" else . end; ((.detail // .summary // "") | tostring | cap($n))\' <<<"$item")"',
    '        jq -cn --arg command "$command" --arg output "$output" --argjson exit_code "$exit_code" --argjson stream_delta "$stream_delta" \'{type:"item.completed", item:{type:"command_execution", command:$command, exit_code:$exit_code, aggregated_output:$output, stream_delta:$stream_delta}}\'',
    '        ;;',
    '      tool_call:in_progress|tool_call:completed|tool_call:failed)',
    '        ;;',
    '      context_compaction:in_progress|status:in_progress)',
    '        message="$(jq -r \'.summary // .detail // "DeepSeek: working"\' <<<"$item")"',
    '        [[ "$message" == "Session context synced" ]] && continue',
    '        [[ "$kind" == "status" && "$message" == Executing\\ * ]] && continue',
    '        emit_progress_item "$message"',
    '        ;;',
    '      context_compaction:completed|context_compaction:failed|status:completed|status:failed)',
    '        message="$(jq -r \'.summary // .detail // "DeepSeek: updated status"\' <<<"$item")"',
    '        [[ "$message" == "Session context synced" ]] && continue',
    '        [[ "$kind" == "status" && "$message" == Executing\\ * ]] && continue',
    '        emit_progress_item "$message"',
    '        ;;',
    '      agent_message:completed)',
    '        text="$(jq -r --argjson n "$max_message_chars" \'def cap($n): if length > $n then .[0:$n] + "\\n[truncated by gateway]" else . end; ((.detail // .summary // "") | tostring | cap($n))\' <<<"$item")"',
    '        if [[ -n "$text" ]]; then jq -cn --arg text "$text" \'{type:"item.completed", item:{type:"agent_message", text:$text}}\'; fi',
    '        ;;',
    '    esac',
    '  done',
    '}',
    'create_thread() {',
    '  jq -n --arg workspace "$cwd" --arg model "$model" --arg mode "$mode" --argjson allow_shell "$allow_shell" --argjson trust_mode "$trust_mode" --argjson auto_approve "$auto_approve" --rawfile system_prompt "$system_prompt_file" \'{workspace:$workspace, model:$model, mode:$mode, allow_shell:$allow_shell, trust_mode:$trust_mode, auto_approve:$auto_approve} + (if ($system_prompt | length) > 0 then {system_prompt:$system_prompt} else {} end)\' \\',
    '    | curl -fsS -X POST "$api_url/v1/threads" -H "Content-Type: application/json" -d @-',
    "}",
    'sync_thread_system_prompt() {',
    '  [[ -s "$system_prompt_file" ]] || return 0',
    '  local current_prompt desired_prompt old_thread_id',
    '  current_prompt="$(jq -r \'.system_prompt // ""\' <<<"$thread_json")"',
    '  desired_prompt="$(cat "$system_prompt_file")"',
    '  [[ "$current_prompt" == "$desired_prompt" ]] && return 0',
    '  old_thread_id="$thread_id"',
    '  if [[ "$old_thread_id" == "$requested_thread_id" ]]; then',
    '    thread_json="$(curl -fsS -X POST "$api_url/v1/threads/$old_thread_id/fork")"',
    '    thread_id="$(jq -r \'.id // empty\' <<<"$thread_json")"',
    '    [[ -n "$thread_id" && "$thread_id" != "null" ]]',
    '    curl -fsS -X PATCH "$api_url/v1/threads/$old_thread_id" -H "Content-Type: application/json" -d \'{"archived":true}\' >/dev/null || true',
    "  fi",
    '  thread_json="$(jq -n --rawfile system_prompt "$system_prompt_file" \'{system_prompt:$system_prompt}\' | curl -fsS -X PATCH "$api_url/v1/threads/$thread_id" -H "Content-Type: application/json" -d @-)"',
    "}",
    'if [[ -n "$requested_thread_id" ]]; then',
    '  set +e',
    '  thread_json="$(curl -fsS "$api_url/v1/threads/$requested_thread_id" 2>/dev/null)"',
    "  status=$?",
    "  set -e",
    '  if [[ "$status" -ne 0 || -z "$thread_json" ]]; then',
    '    thread_json="$(create_thread)"',
    "  fi",
    "else",
    '  thread_json="$(create_thread)"',
    "fi",
    'thread_id="$(jq -r \'.id // .thread.id // empty\' <<<"$thread_json")"',
    '[[ -n "$thread_id" && "$thread_id" != "null" ]]',
    'sync_thread_system_prompt',
    'printf \'{"type":"thread.started","thread_id":%s}\\n\' "$(jq -Rn --arg v "$thread_id" \'$v\')"',
    'turn_payload="$(jq -n --rawfile prompt "$prompt_file" --arg model "$model" --arg mode "$mode" --argjson allow_shell "$allow_shell" --argjson trust_mode "$trust_mode" --argjson auto_approve "$auto_approve" \'{prompt:$prompt, model:$model, mode:$mode, allow_shell:$allow_shell, trust_mode:$trust_mode, auto_approve:$auto_approve}\')"',
    'turn_start="$(curl -fsS -X POST "$api_url/v1/threads/$thread_id/turns" -H "Content-Type: application/json" -d "$turn_payload")"',
    'turn_id="$(jq -r .turn.id <<<"$turn_start")"',
    '[[ -n "$turn_id" && "$turn_id" != "null" ]]',
    'jq -cn --arg id "$turn_id" \'{type:"turn.started", turn_id:$id}\'',
    "detail=",
    "turn_status=",
    `for _ in $(seq 1 ${maxPolls}); do`,
    '  detail="$(curl -fsS "$api_url/v1/threads/$thread_id")"',
    '  turn_status="$(jq -r --arg id "$turn_id" \'.turns[] | select(.id == $id) | .status\' <<<"$detail")"',
    '  emit_deepseek_progress_items',
    '  case "$turn_status" in completed|failed|canceled|interrupted) break ;; esac',
    `  sleep ${pollDelay}`,
    "done",
    'if [[ -z "$detail" || -z "$turn_status" ]]; then',
    '  echo "DeepSeek HTTP runtime did not return turn status" >&2',
    "  exit 1",
    "fi",
    'if [[ "$turn_status" != "completed" && "$turn_status" != "failed" && "$turn_status" != "canceled" && "$turn_status" != "interrupted" ]]; then',
    `  error="DeepSeek HTTP runtime timed out waiting for turn $turn_id after ${maxTurnWaitSecs}s"`,
    '  jq -cn --arg message "$error" \'{type:"turn.failed", error:{message:$message}}\'',
    "  exit 124",
    "fi",
    'emit_deepseek_progress_items',
    'usage="$(jq -c --arg id "$turn_id" \'.turns[] | select(.id == $id) | .usage // null\' <<<"$detail")"',
    'turn_error="$(jq -r --arg id "$turn_id" \'.turns[] | select(.id == $id) | .error // empty\' <<<"$detail")"',
    'if [[ "$turn_status" == "completed" && -n "$turn_error" ]]; then',
    '  turn_status=failed',
    "fi",
    'if [[ "$turn_status" == "completed" ]]; then',
    '  jq -cn --arg id "$turn_id" --argjson usage "$usage" \'{type:"turn.completed", turn_id:$id, usage:$usage}\'',
    "else",
    '  error="$(jq -r --arg id "$turn_id" --argjson n "$max_error_chars" \'def cap($n): if length > $n then .[0:$n] + "\\n[truncated by gateway]" else . end; ((.turns[] | select(.id == $id) | .error // "DeepSeek turn failed") | tostring | cap($n))\' <<<"$detail")"',
    '  jq -cn --arg id "$turn_id" --arg message "$error" \'{type:"turn.failed", turn_id:$id, error:{message:$message}}\'',
    "fi",
  ].join("\n");
}

function buildDeepSeekHttpSshArgs({
  apiUrl,
  autoApprove,
  connectTimeoutSecs,
  cwd,
  host,
  mode,
  model,
  requestedThreadId,
  sessionKey,
  trustMode,
  allowShell,
}) {
  if (!host?.ssh_target) {
    throw new Error("Remote DeepSeek host is missing ssh_target metadata");
  }
  const script = buildDeepSeekHttpScript({
    apiUrl,
    autoApprove,
    cwd,
    mode,
    model,
    requestedThreadId,
    sessionKey,
    trustMode,
    allowShell,
  });
  return [
    "-T",
    ...buildSshBaseArgs(host.ssh_target, connectTimeoutSecs),
    `bash -lc ${shellQuote(script)}`,
  ];
}

export async function runRemoteDeepSeekHttpTask({
  connectTimeoutSecs = 8,
  currentHostId,
  executionHost,
  host = executionHost?.host ?? null,
  onEvent,
  onRuntimeState,
  onWarning,
  platform = process.platform,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  session,
  sessionKey = null,
  sessionThreadId = null,
  spawnImpl,
  streamCloseGraceMs,
  deepSeekApiUrl,
  deepSeekMode = "agent",
  deepSeekAllowShell = true,
  deepSeekTrustMode = false,
  deepSeekAutoApprove = true,
  model,
}) {
  const resolvedHost = host || null;
  const hostId = normalizeOptionalText(executionHost?.hostId || resolvedHost?.host_id);
  if (!resolvedHost || !hostId || !resolvedHost.ssh_target) {
    throw new Error("Remote DeepSeek execution host is missing ssh_target metadata");
  }

  const remoteCwd = resolveExecutionCwd({
    workspaceBinding: session?.workspace_binding,
    host: resolvedHost,
    currentHostId,
  });
  if (!remoteCwd) {
    throw new Error(`Cannot resolve remote cwd for DeepSeek host ${hostId}`);
  }

  const apiUrl = normalizeOptionalText(deepSeekApiUrl);
  if (!apiUrl) {
    throw new Error("DeepSeek HTTP runtime profile is missing api_url");
  }
  const normalizedModel = normalizeOptionalText(model) || "deepseek-v4-flash";
  const normalizedMode = normalizeOptionalText(deepSeekMode) || "agent";
  const systemPrompt =
    normalizeOptionalText(developerInstructions)
    || normalizeOptionalText(baseInstructions)
    || "";
  const sshArgs = buildDeepSeekHttpSshArgs({
    apiUrl,
    autoApprove: normalizeBoolean(deepSeekAutoApprove, true),
    connectTimeoutSecs,
    cwd: remoteCwd,
    host: resolvedHost,
    mode: normalizedMode,
    model: normalizedModel,
    requestedThreadId: sessionThreadId,
    sessionKey,
    trustMode: normalizeBoolean(deepSeekTrustMode, false),
    allowShell: normalizeBoolean(deepSeekAllowShell, true),
  });

  return startExecChild({
    backend: DEEPSEEK_HTTP_BACKEND,
    command: "ssh",
    args: sshArgs,
    prompt: JSON.stringify({
      prompt: String(prompt || ""),
      system_prompt: systemPrompt,
    }),
    onEvent,
    onWarning,
    onRuntimeState,
    platform,
    detached: platform !== "win32",
    sessionThreadId,
    streamCloseGraceMs,
    terminateOnTerminalEvent: false,
    spawnImpl,
  });
}

import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  normalizeSessionRuntimeProvider,
  SESSION_PROVIDER_DEEPSEEK,
  SESSION_PROVIDER_OPENROUTER,
} from "../../../session-manager/codex-runtime-profiles.js";
import { DEFAULT_UI_LANGUAGE } from "./common.js";

function buildRuntimeLine(session) {
  const provider = normalizeSessionRuntimeProvider(session?.session_runtime_provider)
    || "codex";
  if (provider === SESSION_PROVIDER_DEEPSEEK) {
    return `runtime: deepseek (${session?.session_runtime_model || DEFAULT_DEEPSEEK_MODEL})`;
  }
  if (provider === SESSION_PROVIDER_OPENROUTER) {
    return `runtime: openrouter (${session?.session_runtime_model || DEFAULT_OPENROUTER_MODEL})`;
  }
  return "runtime: codex";
}

function formatRuntimeSelectionDetail(error, _language = DEFAULT_UI_LANGUAGE) {
  return String(error?.message || error);
}

export function buildNewTopicRuntimeSelectionErrorMessage(
  error,
  language = DEFAULT_UI_LANGUAGE,
) {
  const errorMessage = formatRuntimeSelectionDetail(error, language);
  return [
    "Invalid runtime/model for the new topic.",
    "",
    errorMessage,
    "Examples: /new host=workera provider=codex Title",
    "Examples: /new host=workera provider=deepseek model=flash Title",
    "Examples: /new host=workera provider=openrouter model=kimi Title",
    "DeepSeek models: flash, pro.",
  ].join("\n");
}

export function buildNewTopicAckMessage(
  session,
  forumTopic,
  _language = getSessionUiLanguage(session),
) {
  return [
    `Created topic "${forumTopic.name}".`,
    "Use it like a normal chat.",
  ].join("\n");
}

export function buildNewTopicHostUnavailableMessage(
  {
    hostId = "unknown",
    hostLabel = hostId,
  } = {},
  _language = DEFAULT_UI_LANGUAGE,
) {
  return [
    `Cannot create a new topic on host ${hostLabel}.`,
    "",
    `Host ${hostLabel} is unavailable right now.`,
  ].join("\n");
}

export function buildNewTopicBootstrapMessage(
  session,
  forumTopic,
  _language = getSessionUiLanguage(session),
) {
  return [
    "Topic is ready.",
    "",
    `This is the work topic "${forumTopic.name}".`,
    buildRuntimeLine(session),
    "Just write here like in a normal chat.",
    "If you need session details, use /status.",
  ].join("\n");
}

export function buildDiffCleanMessage(
  session,
  generatedAt,
  _language = getSessionUiLanguage(session),
) {
  void generatedAt;
  return "Workspace diff is currently empty.";
}

export function buildDiffUnavailableMessage(
  session,
  generatedAt,
  _language = getSessionUiLanguage(session),
) {
  void generatedAt;
  return [
    "Workspace diff is unavailable for this binding.",
    "",
    "The current binding is not a git repository.",
  ].join("\n");
}

export function buildDocumentTooLargeMessage(
  session,
  filePath,
  sizeBytes,
  _language = getSessionUiLanguage(session),
) {
  void session;
  void filePath;
  return [
    "Artifact is too large for Telegram file delivery.",
    "",
    `size_bytes: ${sizeBytes}`,
  ].join("\n");
}

export function buildPurgeBusyMessage(
  session,
  _language = getSessionUiLanguage(session),
) {
  return [
    "You cannot purge the session while topic work is still active.",
    "",
    "Wait for /compact to finish or stop the run with /interrupt first, then repeat /purge.",
  ].join("\n");
}

export function buildPurgeAckMessage(
  session,
  _language = getSessionUiLanguage(session),
) {
  void session;
  return [
    "Session state purged.",
    "",
    "Stored exchange log, active brief, and diff artifacts were removed.",
    "The next plain prompt in this same topic will start a fresh session.",
  ].join("\n");
}

export function buildPurgedSessionMessage(
  session,
  _language = getSessionUiLanguage(session),
) {
  return [
    "This session is currently purged.",
    "",
    "Send a plain prompt in this topic to start a fresh session.",
  ].join("\n");
}

export function buildCompactMessage(
  session,
  compacted,
  _language = getSessionUiLanguage(session),
) {
  void session;
  return [
    "Session compacted.",
    "",
    `reason: ${compacted.reason}`,
    `exchange_log_entries: ${compacted.exchangeLogEntries}`,
    "active_brief: refreshed",
  ].join("\n");
}

export function buildCompactStartedMessage(
  session,
  _language = getSessionUiLanguage(session),
) {
  void session;
  return [
    "Compaction started.",
    "",
    "I will post the refreshed brief status here when it finishes.",
  ].join("\n");
}

export function buildCompactAlreadyRunningMessage(
  session,
  _language = getSessionUiLanguage(session),
) {
  void session;
  return "Compaction is already running for this session.";
}

export function buildCompactFailureMessage(
  session,
  error,
  _language = getSessionUiLanguage(session),
) {
  void session;
  void error;
  return "Compaction failed. Check the service logs for details.";
}

export function buildBindingResolutionErrorMessage(
  requestedPath,
  error,
  _language = DEFAULT_UI_LANGUAGE,
) {
  return [
    "Failed to resolve workspace binding for /new.",
    "",
    `requested_path: ${requestedPath || "none"}`,
    `error: ${error.message}`,
  ].join("\n");
}

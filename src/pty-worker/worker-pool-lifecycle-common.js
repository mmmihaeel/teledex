import { resolveSessionOwnerGenerationId } from "../rollout/session-ownership.js";

export function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function buildRunEventSessionFields(session) {
  return {
    session_key: session?.session_key || null,
    chat_id: session?.chat_id || null,
    topic_id: session?.topic_id || null,
    topic_name: session?.topic_name || null,
  };
}

export function computeRunDurationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt || "");
  const finished = Date.parse(finishedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return null;
  }

  return Math.max(0, finished - started);
}

const MAX_RUNTIME_WARNING_SAMPLES = 3;
const MAX_RUNTIME_WARNING_SAMPLE_CHARS = 800;

function sanitizeRuntimeDiagnosticMessage(value) {
  const withoutControlChars = Array.from(String(value ?? ""), (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  const normalized = withoutControlChars
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_RUNTIME_WARNING_SAMPLE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RUNTIME_WARNING_SAMPLE_CHARS)}...`;
}

export function buildRunResultDiagnosticFields(result) {
  if (result == null) {
    return {};
  }
  const warnings = Array.isArray(result?.warnings)
    ? result.warnings
    : [];
  const samples = [];
  const seen = new Set();
  for (const warning of warnings) {
    const sample = sanitizeRuntimeDiagnosticMessage(warning);
    if (!sample || seen.has(sample)) {
      continue;
    }
    seen.add(sample);
    samples.push(sample);
    if (samples.length >= MAX_RUNTIME_WARNING_SAMPLES) {
      break;
    }
  }

  const fields = {
    warnings_count: warnings.length,
  };
  if (samples.length > 0) {
    fields.warning_samples = samples;
  }
  if (warnings.length > samples.length) {
    fields.warning_samples_truncated = true;
  }
  return fields;
}

async function loadCurrentRunSession(pool, run) {
  if (typeof pool.sessionStore?.load !== "function") {
    return run.session;
  }

  return (
    await pool.sessionStore.load(run.session.chat_id, run.session.topic_id)
  ) || run.session;
}

function isRunSuperseded(currentSession, run, generationId) {
  const currentOwnerGenerationId = resolveSessionOwnerGenerationId(currentSession);
  if (
    currentOwnerGenerationId
    && currentOwnerGenerationId !== normalizeOptionalText(generationId)
  ) {
    return true;
  }

  const currentRunStartedAt = parseTimestampMs(currentSession?.last_run_started_at);
  const runStartedAt = parseTimestampMs(run.startedAt);
  return (
    currentRunStartedAt !== null
    && runStartedAt !== null
    && currentRunStartedAt > runStartedAt
  );
}

export async function maybeSuppressSupersededRunCompletion(
  pool,
  run,
  {
    state,
    result,
    progress,
    finishedAt,
  },
) {
  const currentSession = await loadCurrentRunSession(pool, run);
  if (!isRunSuperseded(currentSession, run, pool.serviceGenerationId)) {
    run.session = currentSession;
    return false;
  }

  run.session = currentSession;
  await noteRunEventBestEffort(pool, "run.finished", {
    ...buildRunEventSessionFields(currentSession),
    status: state.status,
    started_at: run.startedAt,
    finished_at: finishedAt,
    duration_ms: computeRunDurationMs(run.startedAt, finishedAt),
    exit_code: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    interrupted: result?.interrupted === true || result?.signal === "SIGINT",
    interrupt_reason: result?.interruptReason || null,
    abort_reason: result?.abortReason || null,
    thread_id: state.threadId || null,
    resume_mode: state.resumeMode,
    warnings_count: state.warnings.length,
    reply_documents_count: state.replyDocuments.length,
    token_usage: state.currentRunTokenUsage ?? null,
    stale_suppressed: true,
  });
  await progress.dismiss().catch(() => false);
  console.warn(
    `suppressing stale run completion for ${run.sessionKey}; newer owner or run already took over`,
  );
  return true;
}

export async function noteRunEventBestEffort(pool, type, details = {}) {
  if (!pool?.runtimeObserver || typeof pool.runtimeObserver.appendEvent !== "function") {
    return;
  }

  try {
    await pool.runtimeObserver.appendEvent(type, details);
  } catch (error) {
    console.warn(`runtime observer ${type} failed: ${error.message}`);
  }
}

function parseTimestampMs(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldStartFreshFromCompact(session) {
  const lastCompactedAtMs = parseTimestampMs(session?.last_compacted_at);
  if (!lastCompactedAtMs || !String(session?.last_compaction_reason || "").trim()) {
    return false;
  }

  const hasContinuitySurface = Boolean(
    session?.codex_thread_id,
  );
  if (hasContinuitySurface) {
    return false;
  }

  const lastRunStartedAtMs = parseTimestampMs(session?.last_run_started_at);
  return !lastRunStartedAtMs || lastRunStartedAtMs <= lastCompactedAtMs;
}

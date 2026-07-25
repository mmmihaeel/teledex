import {
  BOUNDED_RECENT_EXCHANGE_MAX_BYTES,
  BOUNDED_RECENT_EXCHANGE_TARGET_ENTRIES,
} from "./limits.js";
import {
  buildBoundedExchangeEntry,
  buildBoundedProgressNotes,
  buildFencedTextBlock,
  buildFullExchangeEntry,
  pushNewestBounded,
} from "./entries.js";

function normalizeLatestUserPrompt(latestUserPrompt) {
  if (!latestUserPrompt || typeof latestUserPrompt !== "object") {
    return {
      text: null,
      source: "none",
    };
  }

  const text = typeof latestUserPrompt.text === "string"
    && latestUserPrompt.text.trim()
    ? latestUserPrompt.text
    : null;
  return {
    text,
    source: typeof latestUserPrompt.source === "string"
      && latestUserPrompt.source.trim()
      ? latestUserPrompt.source.trim()
      : text
        ? "unknown"
        : "none",
  };
}

function pushLatestUserPromptSection(lines, latestUserPrompt) {
  const latestPrompt = normalizeLatestUserPrompt(latestUserPrompt);

  lines.push("## Last user prompt (verbatim)");
  lines.push(`- source: ${latestPrompt.source}`);
  if (!latestPrompt.text) {
    lines.push("- no user prompt available", "");
    return latestPrompt;
  }

  lines.push(...buildFencedTextBlock(latestPrompt.text), "");
  return latestPrompt;
}

function pushProgressNotesSection(lines, progressNotes) {
  const boundedProgressNotes = buildBoundedProgressNotes(progressNotes);
  const omittedProgressNotes = Math.max(
    progressNotes.length - boundedProgressNotes.length,
    0,
  );

  lines.push("## Recent progress notes for recovery");
  lines.push(`- recent_progress_notes_included: ${boundedProgressNotes.length}`);
  lines.push(`- older_progress_notes_omitted: ${omittedProgressNotes}`);
  if (boundedProgressNotes.length === 0) {
    lines.push("- no recovery progress notes included", "");
  } else {
    lines.push(
      "These notes are temporary hints from the interrupted in-flight run. Use them only for immediate recovery state; user prompts and final replies remain the durable source.",
      "",
      ...boundedProgressNotes,
      "",
    );
  }

  return {
    omittedProgressNotes,
    recentProgressNotes: boundedProgressNotes.length,
  };
}

export function buildFullCompactionSource({
  exchangeLog,
  latestUserPrompt = null,
  progressNotes = [],
  reason,
  session,
}) {
  const fullExchangeEntries = exchangeLog.map((entry, index) =>
    buildFullExchangeEntry(entry, index, exchangeLog.length));
  const lines = [
    "# Compaction source",
    "",
    "This source is built from durable user prompts and final assistant replies. It includes the latest user prompt verbatim, which may be newer than the exchange log during recovery.",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- reason: ${reason}`,
    `- exchange_log_entries_total: ${exchangeLog.length}`,
    `- full_exchange_entries_included: ${fullExchangeEntries.length}`,
    `- progress_notes_total: ${progressNotes.length}`,
    "",
  ];

  const latestPrompt = pushLatestUserPromptSection(lines, latestUserPrompt);
  const progressSelection = pushProgressNotesSection(lines, progressNotes);

  lines.push("## Full exchange log");
  if (fullExchangeEntries.length === 0) {
    lines.push("- no exchange log entries available");
  } else {
    lines.push(...fullExchangeEntries);
  }

  return {
    content: `${lines.join("\n")}\n`,
    fullExchangeEntries: fullExchangeEntries.length,
    latestUserPromptIncluded: Boolean(latestPrompt.text),
    latestUserPromptSource: latestPrompt.source,
    omittedProgressNotes: progressSelection.omittedProgressNotes,
    recentProgressNotes: progressSelection.recentProgressNotes,
  };
}

export function buildBoundedCompactionSource({
  exchangeLog,
  latestUserPrompt = null,
  progressNotes = [],
  reason,
  session,
}) {
  const boundedRecentSelection = pushNewestBounded({
    items: exchangeLog,
    maxBytes: BOUNDED_RECENT_EXCHANGE_MAX_BYTES,
    serialize: buildBoundedExchangeEntry,
    targetCount: BOUNDED_RECENT_EXCHANGE_TARGET_ENTRIES,
  });
  const boundedEntries = boundedRecentSelection.entries;
  const omittedExchangeEntries = Math.max(
    exchangeLog.length - boundedEntries.length,
    0,
  );
  const lines = [
    "# Compaction source",
    "",
    "This bounded source exists so active-brief.md can be regenerated from recent user prompts and final replies without rereading an oversized full exchange log.",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- reason: ${reason}`,
    `- exchange_log_entries_total: ${exchangeLog.length}`,
    `- recent_exchange_entries_included: ${boundedEntries.length}`,
    `- older_exchange_entries_omitted: ${omittedExchangeEntries}`,
    `- progress_notes_total: ${progressNotes.length}`,
    "",
  ];

  const latestPrompt = pushLatestUserPromptSection(lines, latestUserPrompt);
  const progressSelection = pushProgressNotesSection(lines, progressNotes);

  lines.push("## Recent exchange log slice");
  if (boundedEntries.length === 0) {
    lines.push("- no exchange log entries available");
  } else {
    lines.push(...boundedEntries);
  }

  return {
    content: `${lines.join("\n")}\n`,
    latestUserPromptIncluded: Boolean(latestPrompt.text),
    latestUserPromptSource: latestPrompt.source,
    omittedExchangeEntries,
    omittedProgressNotes: progressSelection.omittedProgressNotes,
    recentExchangeEntries: boundedEntries.length,
    recentProgressNotes: progressSelection.recentProgressNotes,
  };
}

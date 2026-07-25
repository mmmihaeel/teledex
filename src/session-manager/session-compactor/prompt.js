import { isContextWindowExceededText } from "../../codex-runtime/context-window.js";

export const isContextLengthExceededError = isContextWindowExceededText;

export function buildCompactionPrompt(session, { reason, source }) {
  const isBoundedSource = source?.kind === "bounded-compaction-source";
  const isFullCompactionSource = source?.kind === "full-compaction-source";
  const sourceContent =
    typeof source?.content === "string" && source.content.trim()
      ? source.content
      : null;
  const sourceDescription = isBoundedSource
    ? "The source file is a bounded compaction artifact built from the latest user prompt, recent user prompts, and final assistant replies. It includes recent progress notes only for recovery reasons."
    : isFullCompactionSource
      ? "The source file is a compact artifact built from the latest user prompt plus the full exchange log of user prompts and final assistant replies. It includes recent progress notes only for recovery reasons."
      : "The exchange log file contains only user prompts and final agent replies.";
  const continuityGoal = isBoundedSource || isFullCompactionSource
    ? "Write a concise, readable markdown brief that lets a fresh Codex run continue without dragging stale intermediate state forward."
    : "Write a dense but readable markdown brief that lets a fresh Codex run continue work without rereading the full exchange log.";
  const lines = [
    "You are generating active-brief.md for a Telegram Codex session recovery flow.",
    sourceDescription,
    continuityGoal,
    "",
    "Rules:",
    "- Output only markdown for active-brief.md.",
    "- Start with '# Active brief'.",
    "- Be concrete, practical, and continuity-first.",
    "- Preserve enough context for the next run to understand the current topic, the last few actions, and the next likely continuation.",
    "- Fresh evidence is most important. In long-running topics, concentrate on the latest several actions even when earlier work belongs to different projects.",
    "- Use user prompts and final assistant replies as durable memory. Do not treat progress notes as durable memory.",
    "- If progress notes are present, they are emergency recovery hints from an interrupted in-flight run. Use only the latest relevant notes to recover immediate state.",
    "- Copy the latest user prompt exactly, without paraphrase, into '## Last user prompt (verbatim)'.",
    "- The latest user prompt outranks open work inferred from older exchange history or progress notes, especially when it is a stop, correction, or pivot.",
    "- Preserve explicit user-specific rules that are still active, but avoid reviving old instructions that no longer affect the current work.",
    "- Preserve concrete delivery, routing, account-usage, artifact-destination, and output-format instructions whenever they are still current.",
    "- Session-specific operator rules outrank generic evergreen behavior.",
    "- Optimize for a useful handoff, not archival detail. Avoid deep implementation specificity unless it is needed for the very next step.",
    "- Latest settled production state overrides older plans, experiments, fallbacks, or superseded architecture ideas.",
    "- When multiple milestones exist, prefer the latest settled build, release, commit, or production direction over earlier accepted checkpoints.",
    "- If the log shows a later explicit correction, migration, replacement, or 'actually do X instead of Y', do not carry Y forward as an active rule, current state, or open work item.",
    "- Treat superseded history as background only; do not resurrect it into Active rules, Current state, or Open work.",
    "- Keep exact command/workflow names or proof identifiers only when they materially affect continuity.",
    "- Do not mention hidden reasoning, chain-of-thought, tools, or process chatter.",
    "- Ignore plan/todo/file/tool/command/web/subagent chatter if it appears in any source; it is not canonical memory.",
    "- Do not wrap the answer in code fences.",
    "- Prefer real repo/module names, current focus, recent outcomes, and actionable next steps over vague summaries.",
    "- Do not collapse the session into a one-line recap like 'continue previous work'.",
    "",
    "Use this structure:",
    "# Active brief",
    "updated_from_reason: ...",
    "session_key: ...",
    "topic_name: ...",
    "cwd: ...",
    "## Workspace context",
    "## Active rules",
    "## User preferences",
    "## Current state",
    "## Completed work",
    "## Open work",
    "## Last user prompt (verbatim)",
    "## Latest exchange",
    "",
    "Section guidance:",
    "- Workspace context: where work is happening, which repo/path/module matters, and any environment/runtime facts the next run should know immediately. Include exact repo/runtime/state anchors when they materially help the next run orient quickly.",
    "- Active rules: explicit user-specific instructions that are still in force, especially ones that are not guaranteed by repo docs or agents. Preserve delivery/account rules, artifact destinations, reply-routing expectations, output constraints, and similar operational directives in concrete bullets. Keep only rules still in force by the end of the log. Bias toward operator instructions, sync/restart rules, suffix/reviewer constraints, and style constraints. Avoid generic capabilities unless the user treated them as explicit rules.",
    "- User preferences: softer durable style, workflow, autonomy, or communication preferences. Keep this separate from hard rules.",
    "- Current state: what the session was recently doing, latest meaningful outcome, and any active constraints or blockers. Prefer the latest settled milestone and active direction over abandoned intermediate plans.",
    "- Completed work: concrete fixes, decisions, or verified outcomes already achieved. Compress older history when it no longer drives the present.",
    "- Open work: unresolved tasks, next likely moves, and unfinished threads that should not be forgotten. Keep explicitly parked backlog that still matters, but drop stale branches that were replaced later.",
    "- Last user prompt (verbatim): copy the latest user prompt from the source exactly. Use a fenced text block when it is multi-line.",
    "- Latest exchange: capture the latest user ask and the latest assistant outcome in concrete terms, keeping exact identifiers when they matter for continuity.",
    "",
    "Before finalizing, silently verify that the brief preserves the latest user prompt verbatim, the next likely continuation path, and still-active rules while excluding superseded policy.",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- repo_root: ${session.workspace_binding.repo_root ?? "unknown"}`,
    `- worktree_path: ${session.workspace_binding.worktree_path ?? session.workspace_binding.cwd}`,
    `- branch: ${session.workspace_binding.branch ?? "unknown"}`,
    `- last_run_status: ${session.last_run_status ?? "none"}`,
    `- last_run_started_at: ${session.last_run_started_at ?? "none"}`,
    `- last_run_finished_at: ${session.last_run_finished_at ?? "none"}`,
    `- reason: ${reason}`,
    `- exchange_log_entries: ${source.exchangeLogEntries}`,
    `- progress_notes: ${source.progressNotes ?? 0}`,
    `- latest_user_prompt_included: ${source.latestUserPromptIncluded ? "true" : "false"}`,
    `- latest_user_prompt_source: ${source.latestUserPromptSource ?? "unknown"}`,
    "",
    ...(isBoundedSource
      ? [
          `- recent_exchange_entries_included: ${source.recentExchangeEntries}`,
          `- older_exchange_entries_omitted: ${source.omittedExchangeEntries}`,
          `- recent_progress_notes_included: ${source.recentProgressNotes}`,
          `- older_progress_notes_omitted: ${source.omittedProgressNotes}`,
        ]
      : isFullCompactionSource
        ? [
            `- full_exchange_entries_included: ${source.fullExchangeEntries}`,
            `- recent_progress_notes_included: ${source.recentProgressNotes}`,
            `- older_progress_notes_omitted: ${source.omittedProgressNotes}`,
          ]
        : []),
    "",
    sourceContent
      ? "The compaction source is embedded below. The file path is diagnostic only; do not try to read it from disk."
      : "Read the compaction source from this file:",
    source.path,
    "",
    ...(isBoundedSource
      ? [
          "Use the latest user prompt and recent exchange slice as the source of truth for current work.",
          "Older exchanges are intentionally omitted for context safety; do not invent details from them.",
          "If progress notes are present, use only the latest few to recover interrupted in-flight state.",
        ]
      : isFullCompactionSource
        ? [
            "Use the full exchange-log section as durable source of truth for conversation history.",
            "Use the latest user prompt section verbatim in the resulting brief.",
            "If progress notes are present, use them only as recent interrupted-run hints.",
          ]
        : ["Use that file as the source of truth for the brief."]),
    ...(sourceContent
      ? [
          "",
          "<compaction_source>",
          sourceContent.trimEnd(),
          "</compaction_source>",
        ]
      : []),
  ];

  return `${lines.join("\n")}\n`;
}

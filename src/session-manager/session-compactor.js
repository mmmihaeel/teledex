import { randomUUID } from "node:crypto";

import { createHostAwareRunTask } from "../pty-worker/host-aware-run-task.js";
import {
  buildEmptyGlobalCodexSettingsState,
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "./codex-runtime-settings.js";
import {
  buildEmptyBrief,
  isPersistedCompactionActive,
} from "./session-compactor/common.js";
import { generateBriefWithCodex } from "./session-compactor/codex-run.js";
import { buildCompactionSourceSelection } from "./session-compactor/source.js";

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecoveryCompactionReason(reason) {
  return /(?:recovery|resume-fallback|stale|corruption|context-window)/iu.test(
    String(reason || ""),
  );
}

function buildCompactionId() {
  return `compact-${Date.now()}-${randomUUID()}`;
}

function filterProgressNotesForRun(notes = [], runStartedAt = null) {
  const startedAt = typeof runStartedAt === "string" && runStartedAt.trim()
    ? runStartedAt.trim()
    : null;
  if (!startedAt) {
    return notes;
  }

  const exactRunNotes = notes.filter((entry) => entry?.run_started_at === startedAt);
  if (exactRunNotes.length > 0) {
    return exactRunNotes;
  }

  const startedMs = parseTimestampMs(startedAt);
  if (startedMs === null) {
    return notes;
  }

  return notes.filter((entry) => {
    const createdMs = parseTimestampMs(entry?.created_at);
    return createdMs === null || createdMs >= startedMs;
  });
}

function normalizeLatestUserPrompt({ explicitPrompt, exchangeLog, session }) {
  if (typeof explicitPrompt === "string" && explicitPrompt.trim()) {
    return {
      text: explicitPrompt,
      source: "in-flight",
    };
  }

  const latestExchangePrompt = [...exchangeLog]
    .reverse()
    .find((entry) =>
      typeof entry?.user_prompt === "string" && entry.user_prompt.trim());
  if (latestExchangePrompt) {
    return {
      text: latestExchangePrompt.user_prompt,
      source: "exchange-log",
    };
  }

  if (typeof session?.last_user_prompt === "string" && session.last_user_prompt.trim()) {
    return {
      text: session.last_user_prompt,
      source: "session-meta",
    };
  }

  return {
    text: null,
    source: "none",
  };
}

export class SessionCompactor {
  constructor({
    sessionStore,
    config = null,
    globalCodexSettingsStore = null,
    hostRegistryService = null,
    runTask = createHostAwareRunTask({ config, hostRegistryService }),
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.hostRegistryService = hostRegistryService;
    this.runTask = runTask;
    this.activeCompactions = new Map();
  }

  async loadCompactRuntimeProfile() {
    const availableModels = await loadAvailableCodexModels({
      configPath: this.config?.codexConfigPath,
    });
    const globalSettings = this.globalCodexSettingsStore
      ? await this.globalCodexSettingsStore.load({ force: true })
      : buildEmptyGlobalCodexSettingsState();

    return resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config: this.config,
      target: "compact",
      availableModels,
    });
  }

  isCompacting(sessionOrKey) {
    const sessionKey = typeof sessionOrKey === "string"
      ? sessionOrKey
      : sessionOrKey?.session_key;
    if (Boolean(sessionKey) && this.activeCompactions.has(sessionKey)) {
      return true;
    }

    return isPersistedCompactionActive(
      typeof sessionOrKey === "string" ? null : sessionOrKey,
    );
  }

  async compact(
    session,
    {
      reason = "manual",
      includeProgressNotes = null,
      latestUserPrompt = null,
      progressRunStartedAt = null,
    } = {},
  ) {
    const sessionKey = session.session_key;
    const previous = this.activeCompactions.get(sessionKey) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.compactOnce(session, {
        includeProgressNotes,
        latestUserPrompt,
        progressRunStartedAt,
        reason,
      }));

    this.activeCompactions.set(sessionKey, current);

    try {
      return await current;
    } finally {
      if (this.activeCompactions.get(sessionKey) === current) {
        this.activeCompactions.delete(sessionKey);
      }
    }
  }

  async compactOnce(
    session,
    {
      reason,
      includeProgressNotes,
      latestUserPrompt,
      progressRunStartedAt,
    },
  ) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    if (current.lifecycle_state === "purged") {
      return {
        session: current,
        skipped: "purged",
        reason,
      };
    }

    const compactionId = buildCompactionId();
    const compactionStartedAt = new Date().toISOString();
    const claim = await this.sessionStore.withMetaLock(
      current.chat_id,
      current.topic_id,
      async () => {
        const latest =
          (await this.sessionStore.load(current.chat_id, current.topic_id)) || current;
        if (latest.lifecycle_state === "purged") {
          return {
            claimed: false,
            skipped: "purged",
            session: latest,
          };
        }
        if (isPersistedCompactionActive(latest)) {
          return {
            claimed: false,
            skipped: "compacting",
            session: latest,
          };
        }

        const next = {
          ...latest,
          compaction_in_progress: true,
          compaction_id: compactionId,
          compaction_owner_generation_id: this.config?.serviceGenerationId ?? null,
          compaction_started_at: compactionStartedAt,
        };
        await this.sessionStore.saveUnlocked(next);
        return {
          claimed: true,
          session: next,
        };
      },
    );
    if (!claim.claimed) {
      return {
        session: claim.session,
        skipped: claim.skipped,
        reason,
      };
    }
    const prepared = claim.session;

    const clearCompactionClaim = async () => this.sessionStore.withMetaLock(
      prepared.chat_id,
      prepared.topic_id,
      async () => {
        const latest =
          (await this.sessionStore.load(prepared.chat_id, prepared.topic_id)) || prepared;
        if (latest.compaction_id !== compactionId) {
          return latest;
        }
        const next = {
          ...latest,
          compaction_in_progress: false,
          compaction_id: null,
          compaction_owner_generation_id: null,
          compaction_started_at: null,
        };
        await this.sessionStore.saveUnlocked(next);
        return next;
      },
    );

    const finalizeCompaction = async ({ activeBrief, exchangeLog, progressNotes, updatedAt }) =>
      this.sessionStore.withMetaLock(prepared.chat_id, prepared.topic_id, async () => {
        const latest =
          (await this.sessionStore.load(prepared.chat_id, prepared.topic_id)) || prepared;
        if (latest.lifecycle_state === "purged") {
          return {
            session: latest,
            skipped: "purged",
          };
        }
        if (latest.compaction_id !== compactionId) {
          return {
            session: latest,
            skipped: "compaction-claim-lost",
          };
        }

        await this.sessionStore.writeSessionText(latest, "active-brief.md", activeBrief);
        await this.sessionStore.removeLegacyMemoryFiles(latest);
        const updated = {
          ...latest,
          compaction_in_progress: false,
          compaction_id: null,
          compaction_owner_generation_id: null,
          compaction_started_at: null,
          last_compacted_at: updatedAt,
          last_compaction_reason: reason,
          exchange_log_entries: exchangeLog.length,
          provider_session_id: null,
          codex_thread_id: null,
          codex_thread_model: null,
          codex_thread_reasoning_effort: null,
          codex_rollout_path: null,
          context_snapshot_rollout_path: null,
          last_context_snapshot: null,
          last_token_usage: null,
          last_run_status: null,
          last_run_model: null,
          last_run_reasoning_effort: null,
          session_owner_generation_id: null,
          session_owner_mode: null,
          session_owner_claimed_at: null,
          agent_run_owner_generation_id: null,
          last_run_started_at: null,
          last_run_finished_at: null,
          last_progress_message_id: null,
        };
        await this.sessionStore.saveUnlocked(updated);

        return {
          session: updated,
          reason,
          activeBrief,
          exchangeLogEntries: exchangeLog.length,
          progressNoteEntries: progressNotes.length,
        };
      });

    try {
      const exchangeLog = await this.sessionStore.loadExchangeLog(prepared);
      const shouldIncludeProgressNotes =
        includeProgressNotes ?? isRecoveryCompactionReason(reason);
      const progressNotes = shouldIncludeProgressNotes
        ? filterProgressNotesForRun(
            await this.sessionStore.loadProgressNotes(prepared, { limit: null }),
            progressRunStartedAt,
          )
        : [];
      const latestPrompt = normalizeLatestUserPrompt({
        explicitPrompt: latestUserPrompt,
        exchangeLog,
        session: prepared,
      });
      const updatedAt = new Date().toISOString();
      const exchangeLogPath = this.sessionStore.getExchangeLogPath(
        prepared.chat_id,
        prepared.topic_id,
      );
      const hasCompactionSource =
        exchangeLog.length > 0 || progressNotes.length > 0 || Boolean(latestPrompt.text);
      let sourceSelection = null;
      const activeBrief =
        !hasCompactionSource
          ? buildEmptyBrief(prepared, { reason, updatedAt })
          : await (async () => {
              sourceSelection = await buildCompactionSourceSelection({
                  exchangeLog,
                  exchangeLogPath,
                  latestUserPrompt: latestPrompt,
                  progressNotes,
                  reason,
                  session: prepared,
                  sessionStore: this.sessionStore,
                });
              return generateBriefWithCodex({
                config: this.config,
                runtimeProfile: await this.loadCompactRuntimeProfile(),
                reason,
                runTask: this.runTask,
                session: prepared,
                primarySource: sourceSelection.primarySource,
                fallbackSource: sourceSelection.fallbackSource,
              });
            })();

      const finalized = await finalizeCompaction({
        activeBrief,
        exchangeLog,
        progressNotes,
        updatedAt,
      });
      if (finalized.skipped) {
        return {
          session: finalized.session,
          skipped: finalized.skipped,
          reason,
        };
      }

      return {
        session: finalized.session,
        reason,
        activeBrief,
        exchangeLogEntries: exchangeLog.length,
        progressNoteEntries: progressNotes.length,
        generatedWithCodex: hasCompactionSource,
      };
    } catch (error) {
      await clearCompactionClaim().catch(() => null);
      throw error;
    }
  }
}

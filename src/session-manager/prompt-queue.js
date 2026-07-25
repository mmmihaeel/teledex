import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { quarantineCorruptFile } from "../state/file-utils.js";
import {
  extractRenderedUserPrompt,
  renderUserPrompt,
} from "./prompt-suffix.js";
import { shouldForwardSessionToOwner } from "../rollout/session-ownership.js";
import {
  clearSessionOwnershipPatch,
  isOwnedSessionForwardTargetLive,
} from "../rollout/session-ownership.js";
import {
  QUEUED_PROMPT_CLAIM_TTL_MS,
  AGENT_PROMPT_QUEUE_FILE_NAME,
} from "./prompt-queue-constants.js";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeReplyToMessageId(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeClaimId(value) {
  return normalizeText(value);
}

function isClaimFresh(entry, nowMs = Date.now()) {
  if (!entry?.claim_id) {
    return false;
  }
  const claimedMs = Date.parse(String(entry.claimed_at || ""));
  return Number.isFinite(claimedMs) && nowMs - claimedMs <= QUEUED_PROMPT_CLAIM_TTL_MS;
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => cloneJson(attachment));
}

function buildQueueEntry({
  rawPrompt,
  prompt,
  attachments = [],
  createdAt = new Date().toISOString(),
  claimGenerationId = null,
  claimId = null,
  claimedAt = null,
  replyToMessageId = null,
} = {}) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return null;
  }

  return {
    schema_version: 1,
    created_at: normalizeText(createdAt) || new Date().toISOString(),
    raw_prompt: normalizeText(rawPrompt) || normalizedPrompt,
    prompt: normalizedPrompt,
    attachments: normalizeAttachments(attachments),
    claim_generation_id: normalizeText(claimGenerationId),
    claim_id: normalizeClaimId(claimId),
    claimed_at: normalizeText(claimedAt),
    reply_to_message_id: normalizeReplyToMessageId(replyToMessageId),
  };
}

function parseQueueEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return buildQueueEntry({
    rawPrompt: value.raw_prompt,
    prompt: value.prompt,
    attachments: value.attachments,
    claimGenerationId: value.claim_generation_id,
    claimId: value.claim_id,
    claimedAt: value.claimed_at,
    createdAt: value.created_at,
    replyToMessageId: value.reply_to_message_id,
  });
}

function clearQueueEntryClaim(entry) {
  return buildQueueEntry({
    rawPrompt: entry?.raw_prompt,
    prompt: entry?.prompt,
    attachments: entry?.attachments,
    createdAt: entry?.created_at,
    replyToMessageId: entry?.reply_to_message_id,
  });
}

function buildEmptyQueueState() {
  return {
    schema_version: 1,
    updated_at: null,
    items: [],
  };
}

function parseQueueState(value) {
  if (!value || typeof value !== "object") {
    return buildEmptyQueueState();
  }

  const items = Array.isArray(value.items)
    ? value.items.map(parseQueueEntry).filter(Boolean)
    : [];

  return {
    schema_version: 1,
    updated_at: normalizeText(value.updated_at),
    items,
  };
}

function buildStoredQueueState(items) {
  return {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    items: normalizeAttachments(items),
  };
}

function buildQueuedPromptMessage(session, entry) {
  const message = {
    chat: {
      id: Number(session.chat_id),
    },
    message_thread_id: Number(session.topic_id),
  };

  if (Number.isInteger(entry?.reply_to_message_id)) {
    message.message_id = entry.reply_to_message_id;
  }

  return message;
}

function normalizeQueuedPromptEntry(entry) {
  const rawPrompt = normalizeText(
    extractRenderedUserPrompt(entry?.raw_prompt ?? entry?.prompt ?? "") || entry?.raw_prompt || entry?.prompt,
  );
  if (!rawPrompt) {
    return null;
  }

  return {
    rawPrompt,
    prompt: renderUserPrompt(rawPrompt),
  };
}

export function summarizeQueuedPrompt(rawPrompt, maxWords = 5) {
  const words = String(rawPrompt || "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  const preview = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${preview}...` : preview;
}

export class AgentPromptQueueStore {
  constructor(sessionStore) {
    this.sessionStore = sessionStore;
  }

  getPath(session) {
    return path.join(
      this.sessionStore.getSessionDir(session.chat_id, session.topic_id),
      AGENT_PROMPT_QUEUE_FILE_NAME,
    );
  }

  async readUnlocked(session) {
    const filePath = this.getPath(session);
    const text = await this.sessionStore.readSessionText(
      session,
      AGENT_PROMPT_QUEUE_FILE_NAME,
    );
    if (!text) {
      return buildEmptyQueueState();
    }

    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
        await quarantineCorruptFile(filePath);
        return buildEmptyQueueState();
      }
      return parseQueueState(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(filePath);
      }
      return buildEmptyQueueState();
    }
  }

  async writeUnlocked(session, items) {
    if (!Array.isArray(items) || items.length === 0) {
      await fs.rm(this.getPath(session), { force: true });
      return buildEmptyQueueState();
    }

    const state = buildStoredQueueState(items);
    await this.sessionStore.writeSessionJson(
      session,
      AGENT_PROMPT_QUEUE_FILE_NAME,
      state,
    );
    return state;
  }

  async load(session) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => (await this.readUnlocked(session)).items,
    );
  }

  async enqueue(session, payload) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        const entry = buildQueueEntry(payload);
        if (!entry) {
          throw new Error("Queued prompt is empty");
        }

        state.items.push(entry);
        await this.writeUnlocked(session, state.items);
        return {
          entry,
          position: state.items.length,
          size: state.items.length,
        };
      },
    );
  }

  async deleteAt(session, position) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        if (!Number.isInteger(position) || position < 1 || position > state.items.length) {
          return {
            entry: null,
            position: null,
            size: state.items.length,
          };
        }

        const [entry] = state.items.splice(position - 1, 1);
        await this.writeUnlocked(session, state.items);
        return {
          entry,
          position,
          size: state.items.length,
        };
      },
    );
  }

  async shift(session) {
    return this.deleteAt(session, 1);
  }

  async claimHead(session, { generationId = null } = {}) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        const [head] = state.items;
        if (!head) {
          return {
            entry: null,
            claimId: null,
            size: 0,
            reason: "empty",
          };
        }
        if (head.claim_id && isClaimFresh(head)) {
          return {
            entry: null,
            claimId: head.claim_id,
            size: state.items.length,
            reason: "claimed",
          };
        }

        const claimId = `queue-${Date.now()}-${randomUUID()}`;
        const claimed = buildQueueEntry({
          rawPrompt: head.raw_prompt,
          prompt: head.prompt,
          attachments: head.attachments,
          createdAt: head.created_at,
          claimGenerationId: generationId,
          claimId,
          claimedAt: new Date().toISOString(),
          replyToMessageId: head.reply_to_message_id,
        });
        state.items[0] = claimed;
        await this.writeUnlocked(session, state.items);
        return {
          entry: claimed,
          claimId,
          size: state.items.length,
          reason: head.claim_id ? "stale-claim-replaced" : "claimed",
        };
      },
    );
  }

  async removeClaimed(session, claimId) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        const index = state.items.findIndex((entry) => entry?.claim_id === claimId);
        if (index < 0) {
          return {
            entry: null,
            size: state.items.length,
          };
        }

        const [entry] = state.items.splice(index, 1);
        await this.writeUnlocked(session, state.items);
        return {
          entry,
          size: state.items.length,
        };
      },
    );
  }

  async releaseClaim(session, claimId) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        const index = state.items.findIndex((entry) => entry?.claim_id === claimId);
        if (index < 0) {
          return {
            entry: null,
            size: state.items.length,
          };
        }

        const released = clearQueueEntryClaim(state.items[index]);
        state.items[index] = released;
        await this.writeUnlocked(session, state.items);
        return {
          entry: released,
          size: state.items.length,
        };
      },
    );
  }

  async clear(session) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        await fs.rm(this.getPath(session), { force: true });
      },
    );
  }
}

export async function drainPendingAgentPromptQueue({
  session = null,
  sessionStore,
  workerPool,
  promptQueueStore,
  currentGenerationId = null,
  generationStore = null,
}) {
  const sessions = session
    ? [((await sessionStore.load(session.chat_id, session.topic_id)) || session)]
    : await sessionStore.listSessionsWithFile(AGENT_PROMPT_QUEUE_FILE_NAME);
  const results = [];

  for (let currentSession of sessions) {
    const queuedItems = await promptQueueStore.load(currentSession);
    if (queuedItems.length === 0) {
      continue;
    }

    if (currentSession.lifecycle_state === "purged") {
      await promptQueueStore.clear(currentSession);
      continue;
    }

    if (currentSession.lifecycle_state !== "active") {
      continue;
    }

    if (
      currentGenerationId
      && shouldForwardSessionToOwner(currentSession, currentGenerationId)
    ) {
      if (!generationStore) {
        continue;
      }

      const ownerIsLive = await isOwnedSessionForwardTargetLive(
        currentSession,
        generationStore,
      );
      if (ownerIsLive) {
        continue;
      }

      currentSession = await sessionStore.patch(currentSession, {
        ...clearSessionOwnershipPatch(),
        agent_run_owner_generation_id: null,
      });
    }

    const claimed = await promptQueueStore.claimHead(currentSession, {
      generationId: currentGenerationId,
    });
    if (!claimed.entry) {
      results.push({
        sessionKey: currentSession.session_key,
        topicId: currentSession.topic_id,
        queueLength: queuedItems.length,
        entry: null,
        result: { handled: true, reason: `queue-${claimed.reason || "claimed"}` },
      });
      continue;
    }

    const normalizedHead = normalizeQueuedPromptEntry(claimed.entry);
    if (!normalizedHead) {
      await promptQueueStore.removeClaimed(currentSession, claimed.claimId);
      continue;
    }
    if (workerPool.shouldSkipQueuedPromptStart?.(currentSession.session_key)) {
      await promptQueueStore.releaseClaim(currentSession, claimed.claimId);
      results.push({
        sessionKey: currentSession.session_key,
        topicId: currentSession.topic_id,
        queueLength: queuedItems.length,
        entry: claimed.entry,
        result: { handled: true, reason: "queue-backoff" },
      });
      continue;
    }
    const latestSession = await sessionStore.load(
      currentSession.chat_id,
      currentSession.topic_id,
    );
    if (!latestSession || latestSession.lifecycle_state !== "active") {
      await promptQueueStore.releaseClaim(currentSession, claimed.claimId);
      results.push({
        sessionKey: currentSession.session_key,
        topicId: currentSession.topic_id,
        queueLength: queuedItems.length,
        entry: claimed.entry,
        result: { handled: true, reason: "queue-session-inactive" },
      });
      continue;
    }
    currentSession = latestSession;

    let result;
    try {
      result = await workerPool.startPromptRun({
        session: currentSession,
        prompt: normalizedHead.prompt,
        rawPrompt: normalizedHead.rawPrompt,
        message: buildQueuedPromptMessage(currentSession, claimed.entry),
        attachments: normalizeAttachments(claimed.entry.attachments),
      });
    } catch (error) {
      await promptQueueStore.releaseClaim(currentSession, claimed.claimId)
        .catch(() => {});
      throw error;
    }

    if (result?.ok) {
      await promptQueueStore.removeClaimed(currentSession, claimed.claimId);
    } else {
      await promptQueueStore.releaseClaim(currentSession, claimed.claimId);
    }
    workerPool.noteQueuedPromptStartResult?.(currentSession.session_key, result);

    results.push({
      sessionKey: currentSession.session_key,
      topicId: currentSession.topic_id,
      queueLength: queuedItems.length,
      entry: claimed.entry,
      result: result?.ok
        ? { handled: true, reason: "prompt-started" }
        : { handled: true, reason: result?.reason || "queue-start-failed" },
    });
  }

  return results;
}

import fs from "node:fs/promises";
import path from "node:path";

import {
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const AGENT_FINAL_EVENT_FILE_NAME = "agent-final-event.json";

function normalizeIntegerString(value) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+$/u.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeInteger(value, fallback = 0) {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.trunc(value);
}

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeMessageIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((entry) => normalizeIntegerString(entry))
        .filter(Boolean),
    ),
  ];
}

function buildDefaultAgentFinalEvent() {
  return {
    schema_version: 1,
    updated_at: null,
    exchange_log_entries: 0,
    status: null,
    finished_at: null,
    final_reply_text: null,
    telegram_message_ids: [],
    reply_to_message_id: null,
    thread_id: null,
  };
}

function normalizeAgentFinalEvent(value) {
  const defaults = buildDefaultAgentFinalEvent();
  return {
    ...defaults,
    updated_at: normalizeText(value?.updated_at),
    exchange_log_entries: normalizeInteger(value?.exchange_log_entries),
    status: normalizeText(value?.status),
    finished_at: normalizeText(value?.finished_at),
    final_reply_text: normalizeText(value?.final_reply_text),
    telegram_message_ids: normalizeMessageIds(value?.telegram_message_ids),
    reply_to_message_id: normalizeIntegerString(value?.reply_to_message_id),
    thread_id: normalizeText(value?.thread_id),
  };
}

async function readAgentFinalEvent(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return normalizeAgentFinalEvent(JSON.parse(text));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return buildDefaultAgentFinalEvent();
    }

    if (error instanceof SyntaxError) {
      await quarantineCorruptFile(filePath);
      return buildDefaultAgentFinalEvent();
    }

    throw error;
  }
}

export class AgentFinalEventStore {
  constructor(sessionStore) {
    this.sessionStore = sessionStore;
  }

  getPath(session) {
    return path.join(
      this.sessionStore.getSessionDir(session.chat_id, session.topic_id),
      AGENT_FINAL_EVENT_FILE_NAME,
    );
  }

  async load(session) {
    return readAgentFinalEvent(this.getPath(session));
  }

  async write(session, event) {
    const next = normalizeAgentFinalEvent({
      ...buildDefaultAgentFinalEvent(),
      ...event,
      updated_at: new Date().toISOString(),
    });
    await writeTextAtomic(
      this.getPath(session),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return next;
  }

  async clear(session) {
    await fs.rm(this.getPath(session), { force: true });
  }
}

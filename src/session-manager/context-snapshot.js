import fs from "node:fs/promises";
import path from "node:path";

import {
  normalizeTokenUsage,
  normalizeUsageCount,
} from "../codex-runtime/token-usage.js";

const ROLLOUT_TAIL_SCAN_BYTES = 4 * 1024 * 1024;
const ROLLOUT_COMPACT_SCAN_MAX_BYTES = 64 * 1024 * 1024;

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function normalizeContextSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const lastTokenUsage = normalizeTokenUsage(
    snapshot.last_token_usage ?? snapshot.lastTokenUsage ?? snapshot.usage,
  );
  const modelContextWindow = normalizeUsageCount(
    snapshot.model_context_window ??
      snapshot.modelContextWindow ??
      snapshot.context_window,
  );
  const lastPostCompactTokenUsage = normalizeTokenUsage(
    snapshot.last_post_compact_token_usage ??
      snapshot.lastPostCompactTokenUsage,
  );
  const capturedAt =
    typeof snapshot.captured_at === "string"
      ? snapshot.captured_at
      : typeof snapshot.capturedAt === "string"
        ? snapshot.capturedAt
        : null;
  const lastCompactAt =
    typeof snapshot.last_compact_at === "string"
      ? snapshot.last_compact_at
      : typeof snapshot.lastCompactAt === "string"
        ? snapshot.lastCompactAt
        : null;
  const lastPostCompactAt =
    typeof snapshot.last_post_compact_at === "string"
      ? snapshot.last_post_compact_at
      : typeof snapshot.lastPostCompactAt === "string"
        ? snapshot.lastPostCompactAt
        : null;
  const sessionId =
    typeof snapshot.session_id === "string"
      ? snapshot.session_id
      : typeof snapshot.sessionId === "string"
        ? snapshot.sessionId
        : null;
  const threadId =
    typeof snapshot.thread_id === "string"
      ? snapshot.thread_id
      : typeof snapshot.threadId === "string"
        ? snapshot.threadId
        : null;
  const rolloutPath =
    typeof snapshot.rollout_path === "string"
      ? snapshot.rollout_path
      : typeof snapshot.rolloutPath === "string"
        ? snapshot.rolloutPath
        : null;

  if (
    lastTokenUsage === null &&
    lastPostCompactTokenUsage === null &&
    modelContextWindow === null &&
    lastCompactAt === null &&
    lastPostCompactAt === null &&
    sessionId === null &&
    threadId === null &&
    rolloutPath === null
  ) {
    return null;
  }

  const normalized = {
    captured_at: capturedAt,
    session_id: sessionId,
    thread_id: threadId,
    model_context_window: modelContextWindow,
    last_token_usage: lastTokenUsage,
    rollout_path: rolloutPath,
  };
  if (lastCompactAt !== null) {
    normalized.last_compact_at = lastCompactAt;
  }
  if (lastPostCompactAt !== null) {
    normalized.last_post_compact_at = lastPostCompactAt;
  }
  if (lastPostCompactTokenUsage !== null) {
    normalized.last_post_compact_token_usage = lastPostCompactTokenUsage;
  }
  return normalized;
}

export function buildLegacyContextSnapshot({ usage, contextWindow } = {}) {
  return normalizeContextSnapshot({
    model_context_window: contextWindow ?? null,
    last_token_usage: usage ?? null,
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function findRolloutPathInDay(dayPath, suffix) {
  const entries = await fs.readdir(dayPath, { withFileTypes: true });
  const file = entries.find(
    (entry) =>
      entry.isFile() && entry.name.endsWith(`${suffix}.jsonl`),
  );
  return file ? path.join(dayPath, file.name) : null;
}

async function findRolloutPathBySuffix(sessionsRoot, suffix) {
  if (!suffix) {
    return null;
  }

  let years;
  try {
    years = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const yearDirs = years
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name));

  for (const year of yearDirs) {
    const yearPath = path.join(sessionsRoot, year.name);
    const months = await fs.readdir(yearPath, { withFileTypes: true });
    const monthDirs = months
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name));

    for (const month of monthDirs) {
      const monthPath = path.join(yearPath, month.name);
      const days = await fs.readdir(monthPath, { withFileTypes: true });
      const dayDirs = days
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name));

      for (const day of dayDirs) {
        const rolloutPath = await findRolloutPathInDay(
          path.join(monthPath, day.name),
          suffix,
        );
        if (rolloutPath) {
          return rolloutPath;
        }
      }
    }
  }

  return null;
}

function nonEmptyLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readRolloutTailText(rolloutPath, scanBytes = ROLLOUT_TAIL_SCAN_BYTES) {
  const stat = await fs.stat(rolloutPath);
  if (stat.size <= scanBytes) {
    return {
      complete: true,
      text: await fs.readFile(rolloutPath, "utf8"),
    };
  }

  const handle = await fs.open(rolloutPath, "r");
  try {
    const bytesToRead = Math.min(scanBytes, stat.size);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      bytesToRead,
      stat.size - bytesToRead,
    );
    let text = buffer.toString("utf8", 0, bytesRead);
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    return {
      complete: false,
      text,
    };
  } finally {
    await handle.close();
  }
}

function shouldExpandRolloutTailScan(parsed, tail) {
  if (tail.complete) {
    return false;
  }
  if (!parsed.latestTokenSnapshot) {
    return true;
  }
  if (parsed.latestTokenSnapshot.model_context_window === null) {
    return true;
  }

  return parsed.lastPostCompactTokenUsage === null;
}

function parseContextSnapshotLines(
  lines,
  {
    rolloutPath,
    normalizedThreadId,
    normalizedProviderSessionId,
  },
) {
  let taskStartedWindow = null;
  let latestTokenSnapshot = null;
  let discoveredSessionId = normalizedProviderSessionId;
  let pendingCompact = null;
  let lastCompactAt = null;
  let lastPostCompactAt = null;
  let lastPostCompactTokenUsage = null;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session_meta") {
      const nextSessionId = normalizeOptionalText(event.payload?.id);
      if (nextSessionId) {
        discoveredSessionId = nextSessionId;
      }
      continue;
    }

    if (event.type === "compacted") {
      pendingCompact = {
        compactAt: typeof event.timestamp === "string" ? event.timestamp : null,
      };
      continue;
    }

    if (event.type !== "event_msg" || !event.payload) {
      continue;
    }

    if (event.payload.type === "task_started") {
      const nextWindow = normalizeUsageCount(event.payload.model_context_window);
      if (nextWindow !== null) {
        taskStartedWindow = nextWindow;
      }
      continue;
    }

    if (event.payload.type !== "token_count" || !event.payload.info) {
      continue;
    }

    const snapshot = normalizeContextSnapshot({
      captured_at: event.timestamp ?? null,
      session_id: discoveredSessionId,
      thread_id: normalizedThreadId,
      model_context_window:
        event.payload.info.model_context_window ?? taskStartedWindow,
      last_token_usage: event.payload.info.last_token_usage,
      rollout_path: rolloutPath,
    });
    if (snapshot) {
      latestTokenSnapshot = snapshot;
      if (pendingCompact) {
        lastCompactAt = pendingCompact.compactAt;
        lastPostCompactAt = snapshot.captured_at;
        lastPostCompactTokenUsage = snapshot.last_token_usage;
        pendingCompact = null;
      }
    }
  }

  return {
    discoveredSessionId,
    latestTokenSnapshot,
    taskStartedWindow,
    lastCompactAt,
    lastPostCompactAt,
    lastPostCompactTokenUsage,
  };
}

function withCompactSummary(snapshot, parsed) {
  if (!snapshot) {
    return null;
  }

  return normalizeContextSnapshot({
    ...snapshot,
    last_compact_at: parsed.lastCompactAt,
    last_post_compact_at: parsed.lastPostCompactAt,
    last_post_compact_token_usage: parsed.lastPostCompactTokenUsage,
  });
}

function snapshotFromParsedRollout(
  parsed,
  {
    rolloutPath,
    normalizedThreadId,
  },
) {
  if (parsed.latestTokenSnapshot) {
    return withCompactSummary(parsed.latestTokenSnapshot, parsed);
  }

  if (parsed.taskStartedWindow !== null) {
    return withCompactSummary(normalizeContextSnapshot({
      session_id: parsed.discoveredSessionId,
      thread_id: normalizedThreadId,
      model_context_window: parsed.taskStartedWindow,
      rollout_path: rolloutPath,
    }), parsed);
  }

  if (parsed.discoveredSessionId || normalizedThreadId || rolloutPath) {
    return withCompactSummary(normalizeContextSnapshot({
      session_id: parsed.discoveredSessionId,
      thread_id: normalizedThreadId,
      rollout_path: rolloutPath,
    }), parsed);
  }

  return null;
}

export async function readLatestContextSnapshot({
  threadId,
  providerSessionId = null,
  sessionsRoot,
  knownRolloutPath = null,
}) {
  const normalizedThreadId = normalizeOptionalText(threadId);
  const normalizedProviderSessionId = normalizeOptionalText(providerSessionId);

  if ((!normalizedThreadId && !normalizedProviderSessionId) || !sessionsRoot) {
    return {
      rolloutPath: null,
      snapshot: null,
    };
  }

  const rolloutPath =
    knownRolloutPath && (await fileExists(knownRolloutPath))
      ? knownRolloutPath
      : await findRolloutPathBySuffix(
          sessionsRoot,
          normalizedProviderSessionId,
        ) || await findRolloutPathBySuffix(sessionsRoot, normalizedThreadId);

  if (!rolloutPath) {
    return {
      rolloutPath: null,
      snapshot: null,
    };
  }

  let scanBytes = ROLLOUT_TAIL_SCAN_BYTES;
  let tail;
  let parsed;
  while (true) {
    tail = await readRolloutTailText(rolloutPath, scanBytes);
    parsed = parseContextSnapshotLines(nonEmptyLines(tail.text), {
      rolloutPath,
      normalizedThreadId,
      normalizedProviderSessionId,
    });

    if (
      !shouldExpandRolloutTailScan(parsed, tail)
      || scanBytes >= ROLLOUT_COMPACT_SCAN_MAX_BYTES
    ) {
      break;
    }
    scanBytes = Math.min(scanBytes * 2, ROLLOUT_COMPACT_SCAN_MAX_BYTES);
  }

  return {
    rolloutPath,
    snapshot: snapshotFromParsedRollout(parsed, {
      rolloutPath,
      normalizedThreadId,
    }),
  };
}

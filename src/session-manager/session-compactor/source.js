import fs from "node:fs/promises";
import path from "node:path";

import {
  COMPACTION_FALLBACK_SOURCE_FILENAME,
  COMPACTION_SOURCE_FILENAME,
  LARGE_EXCHANGE_LOG_THRESHOLD_BYTES,
  LARGE_EXCHANGE_LOG_THRESHOLD_ENTRIES,
} from "./source/limits.js";
import {
  buildBoundedCompactionSource,
  buildFullCompactionSource,
} from "./source/builders.js";

async function getExchangeLogBytes(exchangeLogPath) {
  try {
    const stats = await fs.stat(exchangeLogPath);
    return stats.size;
  } catch {
    return 0;
  }
}

function isLargeExchangeLog({ exchangeLog, exchangeLogBytes }) {
  return exchangeLog.length > LARGE_EXCHANGE_LOG_THRESHOLD_ENTRIES
    || exchangeLogBytes > LARGE_EXCHANGE_LOG_THRESHOLD_BYTES;
}

function buildBoundedSourceDescriptor({
  bounded,
  content,
  sourcePath,
  exchangeLog,
  progressNotes,
}) {
  return {
    kind: "bounded-compaction-source",
    path: sourcePath,
    content,
    exchangeLogEntries: exchangeLog.length,
    recentExchangeEntries: bounded.recentExchangeEntries,
    omittedExchangeEntries: bounded.omittedExchangeEntries,
    progressNotes: progressNotes.length,
    recentProgressNotes: bounded.recentProgressNotes,
    omittedProgressNotes: bounded.omittedProgressNotes,
    latestUserPromptIncluded: bounded.latestUserPromptIncluded,
    latestUserPromptSource: bounded.latestUserPromptSource,
  };
}

function buildFullCompactionSourceDescriptor({
  fullCompactionSource,
  content,
  sourcePath,
  exchangeLog,
  progressNotes,
}) {
  return {
    kind: "full-compaction-source",
    path: sourcePath,
    content,
    exchangeLogEntries: exchangeLog.length,
    fullExchangeEntries: fullCompactionSource.fullExchangeEntries,
    progressNotes: progressNotes.length,
    recentProgressNotes: fullCompactionSource.recentProgressNotes,
    omittedProgressNotes: fullCompactionSource.omittedProgressNotes,
    latestUserPromptIncluded: fullCompactionSource.latestUserPromptIncluded,
    latestUserPromptSource: fullCompactionSource.latestUserPromptSource,
  };
}

async function writeCompactionSource(
  sessionStore,
  session,
  relativePath,
  content,
) {
  await sessionStore.writeSessionText(
    session,
    relativePath,
    content,
  );
}

export async function buildCompactionSourceSelection({
  exchangeLog,
  exchangeLogPath,
  latestUserPrompt = null,
  progressNotes = [],
  reason,
  session,
  sessionStore,
}) {
  const sourcePath = path.join(
    sessionStore.getSessionDir(session.chat_id, session.topic_id),
    COMPACTION_SOURCE_FILENAME,
  );
  const fallbackSourcePath = path.join(
    sessionStore.getSessionDir(session.chat_id, session.topic_id),
    COMPACTION_FALLBACK_SOURCE_FILENAME,
  );

  const largeExchangeLog = isLargeExchangeLog({
    exchangeLog,
    exchangeLogBytes: await getExchangeLogBytes(exchangeLogPath),
  });

  const bounded = buildBoundedCompactionSource({
    exchangeLog,
    latestUserPrompt,
    progressNotes,
    reason,
    session,
  });
  if (largeExchangeLog) {
    await writeCompactionSource(
      sessionStore,
      session,
      COMPACTION_SOURCE_FILENAME,
      bounded.content,
    );
    const boundedSource = buildBoundedSourceDescriptor({
      bounded,
      content: bounded.content,
      sourcePath,
      exchangeLog,
      progressNotes,
    });
    return {
      primarySource: boundedSource,
      fallbackSource: null,
    };
  }

  const fullCompactionSource = buildFullCompactionSource({
    exchangeLog,
    latestUserPrompt,
    progressNotes,
    reason,
    session,
  });
  await writeCompactionSource(
    sessionStore,
    session,
    COMPACTION_SOURCE_FILENAME,
    fullCompactionSource.content,
  );
  await writeCompactionSource(
    sessionStore,
    session,
    COMPACTION_FALLBACK_SOURCE_FILENAME,
    bounded.content,
  );

  return {
    primarySource: buildFullCompactionSourceDescriptor({
      fullCompactionSource,
      content: fullCompactionSource.content,
      sourcePath,
      exchangeLog,
      progressNotes,
    }),
    fallbackSource: buildBoundedSourceDescriptor({
      bounded,
      content: bounded.content,
      sourcePath: fallbackSourcePath,
      exchangeLog,
      progressNotes,
    }),
  };
}

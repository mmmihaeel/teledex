import fs from "node:fs/promises";
import path from "node:path";

import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { splitTelegramReply } from "../transport/telegram-reply-normalizer.js";
import { deliverDocumentToTopic } from "../transport/topic-document-delivery.js";
import {
  getRetryDelayMs,
  isMissingReplyTargetError,
  isTransientTransportError,
  sleep,
  stringifyMessageId,
} from "./worker-pool-common.js";
import {
  buildOutsideDeliveryRootsMessage,
  isPathInsideRoot,
  resolveDocumentDeliveryRoots,
  resolveExistingRealPath,
  resolveRemoteDeliveryHost,
  stageRemoteDocumentForDelivery,
} from "./worker-pool-document-staging.js";

export {
  resolveDocumentDeliveryRoots,
} from "./worker-pool-document-staging.js";

const FINAL_REPLY_MAX_ATTEMPTS = 3;
const FINAL_REPLY_TRANSIENT_RETRY_DELAYS_MS = [500, 1500];

function formatOutgoingDocumentLabel(document) {
  if (typeof document?.fileName === "string" && document.fileName.trim()) {
    return document.fileName.trim();
  }

  if (typeof document?.filePath === "string" && document.filePath.trim()) {
    return path.basename(document.filePath.trim());
  }

  return "file";
}

function buildDocumentSuccessSummary(successes, _language = "eng") {
  const labels = successes.map((entry) => entry.label);
  if (labels.length === 1) {
    return `Sent file: ${labels[0]}.`;
  }

  return `Sent files: ${labels.join(", ")}.`;
}

function buildDocumentFailureLine(failure, _language = "eng") {
  return `Could not send file ${failure.label}: ${failure.error}`;
}

export function buildFinalCompletedReplyText({
  baseText,
  successes = [],
  failures = [],
  warnings = [],
  language = "eng",
}) {
  const normalizedBaseText = String(baseText || "").trim();
  const notes = [
    ...warnings,
    ...failures.map((failure) => buildDocumentFailureLine(failure, language)),
  ].filter(Boolean);

  if (normalizedBaseText) {
    return notes.length > 0
      ? `${normalizedBaseText}\n\n${notes.join("\n")}`
      : normalizedBaseText;
  }

  if (successes.length > 0) {
    const successSummary = buildDocumentSuccessSummary(successes, language);
    return notes.length > 0
      ? `${successSummary}\n\n${notes.join("\n")}`
      : successSummary;
  }

  return notes.join("\n").trim();
}

function buildReplyParams(session, text, replyToMessageId = null) {
  const params = {
    chat_id: Number(session.chat_id),
    text,
    parse_mode: "HTML",
    message_thread_id: Number(session.topic_id),
  };

  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }

  return params;
}

function getTransientFinalReplyRetryDelayMs(error, attempt) {
  const retryDelayMs = getRetryDelayMs(error);
  if (retryDelayMs !== null) {
    return retryDelayMs;
  }

  if (!isTransientTransportError(error)) {
    return null;
  }

  return FINAL_REPLY_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export async function deliverRunDocuments(pool, session, documents = []) {
  const successes = [];
  const failures = [];
  const allowedRoots = await resolveDocumentDeliveryRoots(pool, session);
  const remoteDeliveryHost = await resolveRemoteDeliveryHost(pool, session);
  const language = getSessionUiLanguage(session);

  for (const document of documents) {
    const filePath = String(document?.filePath || "").trim();
    const label = formatOutgoingDocumentLabel(document);

    if (!filePath) {
      failures.push({
        label,
        error: "path is missing",
      });
      continue;
    }

    const isRemoteDelivery = Boolean(remoteDeliveryHost);
    const pathModule = isRemoteDelivery ? path.posix : path;

    if (!pathModule.isAbsolute(filePath)) {
      failures.push({
        label,
        error: `path must be absolute: ${filePath}`,
      });
      continue;
    }

    const candidateFilePath = isRemoteDelivery
      ? path.posix.normalize(filePath)
      : path.resolve(filePath);
    let resolvedFilePath = null;
    let remoteStageDir = null;
    if (isRemoteDelivery) {
      const remoteStage = await stageRemoteDocumentForDelivery(
        pool,
        session,
        candidateFilePath,
        document,
        language,
      );
      if (remoteStage?.failure) {
        failures.push({
          label,
          error: remoteStage.failure,
        });
        continue;
      }
      resolvedFilePath = remoteStage?.resolvedFilePath ?? null;
      remoteStageDir = remoteStage?.stageDir ?? null;
    } else {
      resolvedFilePath = await resolveExistingRealPath(candidateFilePath);
    }

    try {
      const deliveryAllowedRoots = remoteStageDir
        ? [remoteStageDir]
        : allowedRoots;
      if (
        resolvedFilePath &&
        !deliveryAllowedRoots.some((rootPath) =>
          isPathInsideRoot(resolvedFilePath, rootPath),
        )
      ) {
        failures.push({
          label,
          error: buildOutsideDeliveryRootsMessage(language),
        });
        continue;
      }

      if (!resolvedFilePath) {
        failures.push({
          label,
          error: `file not found: ${filePath}`,
        });
        continue;
      }

      const result = await deliverDocumentToTopic({
        api: pool.api,
        chatId: Number(session.chat_id),
        messageThreadId: Number(session.topic_id),
        document: {
          filePath: resolvedFilePath,
          fileName:
            typeof document?.fileName === "string" && document.fileName.trim()
              ? document.fileName.trim()
              : null,
          caption:
            typeof document?.caption === "string" && document.caption.trim()
              ? document.caption.trim()
              : null,
        },
      });

      if (!result.delivered) {
        failures.push({
          label,
          error: `size ${result.sizeBytes} bytes exceeds the Telegram limit`,
        });
        continue;
      }

      successes.push({
        label,
        sizeBytes: result.sizeBytes,
      });
    } catch (error) {
      if (pool.sessionLifecycleManager) {
        const lifecycleResult = await pool.sessionLifecycleManager.handleTransportError(
          session,
          error,
        );
        if (lifecycleResult?.handled) {
          failures.push({
            label,
            error: "topic is unavailable in Telegram",
          });
          return {
            successes,
            failures,
            parked: true,
            session: lifecycleResult.session || session,
          };
        }
      }

      failures.push({
        label,
        error: error.message,
      });
    } finally {
      if (remoteStageDir) {
        await fs.rm(remoteStageDir, { recursive: true, force: true }).catch(() => null);
      }
    }
  }

  return {
    successes,
    failures,
    parked: false,
    session,
  };
}

export async function emitAgentFinalEvent(
  pool,
  run,
  {
    finishedAt,
    deliveryResult = null,
  } = {},
) {
  if (!pool.agentFinalEventStore || !run?.session) {
    return null;
  }

  const currentSession =
    (await pool.sessionStore?.load?.(run.session.chat_id, run.session.topic_id))
    || run.session;

  return pool.agentFinalEventStore.write(currentSession, {
    exchange_log_entries: currentSession.exchange_log_entries ?? 0,
    status: run.state.status,
    finished_at: finishedAt ?? new Date().toISOString(),
    final_reply_text: run.state.finalAgentMessage,
    telegram_message_ids: deliveryResult?.messageIds ?? [],
    reply_to_message_id: stringifyMessageId(run.state.replyToMessageId),
    thread_id: run.state.threadId ?? null,
  });
}

export async function deliverRunReply(
  pool,
  session,
  text,
  { replyToMessageId = null, progress = null } = {},
) {
  const chunks = splitTelegramReply(text);
  const messageIds = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const params = buildReplyParams(
      session,
      chunk,
      index === 0 ? replyToMessageId : null,
    );
    let allowReplyTargetFallback = Boolean(params.reply_to_message_id);

    for (let attempt = 1; attempt <= FINAL_REPLY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const delivered = await pool.api.sendMessage(params);
        if (Number.isInteger(delivered?.message_id)) {
          messageIds.push(String(delivered.message_id));
        }
        break;
      } catch (error) {
        if (allowReplyTargetFallback && isMissingReplyTargetError(error)) {
          delete params.reply_to_message_id;
          allowReplyTargetFallback = false;
          continue;
        }

        if (pool.sessionLifecycleManager) {
          const lifecycleResult = await pool.sessionLifecycleManager.handleTransportError(
            session,
            error,
          );
          if (lifecycleResult?.handled) {
            return {
              ...lifecycleResult,
              delivered: false,
              messageIds,
            };
          }
        }

        const retryDelayMs = getTransientFinalReplyRetryDelayMs(error, attempt);
        if (retryDelayMs !== null && attempt < FINAL_REPLY_MAX_ATTEMPTS) {
          await sleep(retryDelayMs);
          continue;
        }

        if (
          messageIds.length === 0 &&
          progress?.messageId !== null &&
          isTransientTransportError(error)
        ) {
          await progress.finalize(text);
          return {
            delivered: true,
            fallback: "progress",
            messageIds: [stringifyMessageId(progress.messageId)].filter(Boolean),
          };
        }

        if (messageIds.length > 0) {
          error.partialTelegramMessageIds = Array.from(messageIds);
        }
        throw error;
      }
    }
  }

  return {
    delivered: true,
    messageIds,
  };
}

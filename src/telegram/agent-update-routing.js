import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import {
  clearSessionOwnershipPatch,
  isOwnedSessionForwardTargetLive,
  shouldForwardSessionToOwner,
} from "../rollout/session-ownership.js";

function getUpdateMessage(update) {
  return update?.callback_query?.message || update?.message || null;
}

function extractCommandName(update) {
  const message = update?.message;
  const text = typeof message?.text === "string" ? message.text : null;
  const entity = Array.isArray(message?.entities)
    ? message.entities.find((candidate) =>
      candidate?.type === "bot_command" && Number(candidate?.offset) === 0)
    : null;
  if (!text || !entity || !Number.isInteger(entity.length) || entity.length <= 1) {
    return null;
  }

  const rawCommand = text.slice(1, entity.length).trim();
  return rawCommand ? rawCommand.split("@", 1)[0].toLowerCase() : null;
}

function shouldHandleLocallyDespiteOwner(update) {
  return extractCommandName(update) === "status";
}

export function extractUpdateSessionSelector(update) {
  const message = getUpdateMessage(update);
  const topicId = getTopicIdFromMessage(message);
  const chatId = message?.chat?.id;
  if (!message || !topicId || chatId === undefined || chatId === null) {
    return null;
  }

  return {
    chatId: String(chatId),
    topicId: String(topicId),
  };
}

export async function resolveAgentUpdateRoute({
  update,
  generationId,
  generationStore,
  sessionStore,
}) {
  const selector = extractUpdateSessionSelector(update);
  if (!selector) {
    return { type: "local", session: null };
  }

  const session = await sessionStore.load(selector.chatId, selector.topicId);
  if (!session) {
    return { type: "local", session: null };
  }

  if (!shouldForwardSessionToOwner(session, generationId)) {
    return { type: "local", session };
  }

  if (shouldHandleLocallyDespiteOwner(update)) {
    return { type: "local", session, ownerBypassed: "status" };
  }

  const ownerGenerationId =
    session?.session_owner_generation_id
    ?? session?.agent_run_owner_generation_id
    ?? null;
  const ownerGenerationIsLive = await isOwnedSessionForwardTargetLive(
    session,
    generationStore,
  );
  const ownerGeneration = ownerGenerationIsLive
    ? await generationStore.loadGeneration(ownerGenerationId)
    : null;
  if (!ownerGenerationIsLive || !ownerGeneration?.ipc_endpoint) {
    const clearedSession = typeof sessionStore.patch === "function"
      ? await sessionStore.patch(session, {
          ...clearSessionOwnershipPatch(),
          agent_run_owner_generation_id: null,
        })
      : session;
    return {
      type: "local",
      session: clearedSession,
      staleOwnerGenerationId: ownerGenerationId,
    };
  }

  return {
    type: "forward",
    session,
    ownerGeneration,
  };
}

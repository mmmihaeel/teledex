import path from "node:path";

import { ZOO_CALLBACK_PREFIX } from "./render.js";

const YES_WORDS = new Set(["yes", "y"]);
const NO_WORDS = new Set(["no", "n"]);
const ACTIVE_ZOO_OPERATION_CHAINS = new Map();

export const ZOO_UI_LANGUAGE = "eng";
export const ZOO_REFRESH_FRAME_TICK_MS = 12000;
export const ZOO_IDLE_FRAME_TICK_MS = 20000;

export function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeRandomSourceValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.random();
  }

  if (parsed <= 0) {
    return 0;
  }
  if (parsed >= 1) {
    return 0.999999999999;
  }
  return parsed;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function uniquePositiveIntegers(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function pickRandomValue(pool, randomSource = Math.random) {
  const candidates = uniqueStrings(pool);
  if (candidates.length === 0) {
    return null;
  }

  const randomValue = normalizeRandomSourceValue(randomSource());
  const index = Math.min(
    candidates.length - 1,
    Math.floor(randomValue * candidates.length),
  );
  return candidates[index];
}

export function pickRandomUnusedValue(pool, usedValues, randomSource = Math.random) {
  const candidates = uniqueStrings(pool);
  const used = new Set(uniqueStrings(usedValues));
  const unused = candidates.filter((candidate) => !used.has(candidate));
  return pickRandomValue(unused.length > 0 ? unused : candidates, randomSource);
}

export function isYes(text) {
  return YES_WORDS.has(String(text || "").trim().toLowerCase());
}

export function isNo(text) {
  return NO_WORDS.has(String(text || "").trim().toLowerCase());
}

export function buildZooTopicReadyMessage(topicName, _language = ZOO_UI_LANGUAGE) {
  return `Project Catalog topic "${topicName}" is ready.`;
}

export function buildZooTopicOnlyCommandMessage(_language = ZOO_UI_LANGUAGE) {
  return "This topic is reserved for Project Catalog only. Use /zoo here.";
}

export function buildZooAddPromptMessage(_language = ZOO_UI_LANGUAGE) {
  return "Tell me what project this is so I can find it.";
}

export function buildZooLookupBusyMessage(_language = ZOO_UI_LANGUAGE) {
  return "Project lookup is already running.";
}

export function buildZooLookupSearchingMessage(_language = ZOO_UI_LANGUAGE) {
  return "Searching the workspace for the project...";
}

export function buildZooLookupNotFoundMessage(_language = ZOO_UI_LANGUAGE) {
  return "I could not confidently find it. Describe it in more detail.";
}

export function buildZooLookupFailureMessage(error, _language = ZOO_UI_LANGUAGE) {
  return `Lookup failed: ${error.message}`;
}

export function buildZooNeedsYesNoMessage(_language = ZOO_UI_LANGUAGE) {
  return "Reply Yes or No. If No, you can also send a better description right away.";
}

export function buildZooRefreshStartedText(_language = ZOO_UI_LANGUAGE) {
  return "Analyzing the full project...";
}

export function buildZooRefreshFailureText(error, _language = ZOO_UI_LANGUAGE) {
  return `Refresh failed: ${error.message}`;
}

export function buildZooAddFailureMessage(error, _language = ZOO_UI_LANGUAGE) {
  return `Add project failed: ${error.message}`;
}

export function buildZooUnsupportedMessage(_language = ZOO_UI_LANGUAGE) {
  return "This topic is Project Catalog-only. Use the Project Catalog menu.";
}

export function buildZooOwnerMismatchMessage(_language = ZOO_UI_LANGUAGE) {
  return "This Project Catalog flow belongs to another operator.";
}

export function buildZooPathLabel(binding) {
  return binding.repo_root || binding.cwd;
}

export function getZooProjectRoot(binding) {
  return binding.repo_root || binding.cwd || binding.resolved_path;
}

export function sortPetsByDisplayName(left, right) {
  return String(left.display_name || left.pet_id).localeCompare(
    String(right.display_name || right.pet_id),
  );
}

export function buildPetDisplayBaseName(value) {
  return path.basename(getZooProjectRoot(value) || "project") || "project";
}

function getPetDisplayVisibility(value, workspaceRootPath) {
  const projectRoot = normalizeText(getZooProjectRoot(value));
  const workspaceRoot = normalizeText(workspaceRootPath);
  if (!projectRoot || !workspaceRoot) {
    return "priv";
  }

  const relativePath = path.relative(workspaceRoot, projectRoot);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "priv";
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  return segments[0] === "work" && segments[1] === "public" ? "pub" : "priv";
}

export function computeCanonicalPetDisplayNames(pets, workspaceRootPath) {
  const entries = (pets || []).map((pet, index) => ({
    key: normalizeText(pet?.key) || normalizeText(pet?.pet_id) || `pet-${index}`,
    baseName: buildPetDisplayBaseName(pet),
    visibility: getPetDisplayVisibility(pet, workspaceRootPath),
  }));

  const countsByBaseName = new Map();
  for (const entry of entries) {
    countsByBaseName.set(
      entry.baseName,
      (countsByBaseName.get(entry.baseName) || 0) + 1,
    );
  }

  return new Map(entries.map((entry) => [
    entry.key,
    countsByBaseName.get(entry.baseName) > 1
      ? `${entry.baseName} [${entry.visibility}]`
      : entry.baseName,
  ]));
}

export function buildPendingCandidatePet(state) {
  const candidatePath = normalizeText(state?.pending_add?.candidate_path);
  if (state?.pending_add?.stage !== "await_confirmation" || !candidatePath) {
    return null;
  }

  return {
    key: "__candidate__",
    repo_root: candidatePath,
    cwd: candidatePath,
    resolved_path: candidatePath,
  };
}

export function isRecoverableZooMenuEditError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("message to edit not found")
    || message.includes("message can't be edited")
  );
}

export function isZooMenuNotModifiedError(error) {
  return String(error?.message ?? "").toLowerCase().includes("message is not modified");
}

export function buildZooBindingForPet(binding, workspaceRootPath) {
  const projectRoot = getZooProjectRoot(binding);
  return {
    projectRoot,
    cwdRelativeToWorkspaceRoot:
      path.relative(workspaceRootPath, projectRoot) || ".",
  };
}

export function isCurrentLookupRequest(topicState, lookupRequestId, requestedByUserId) {
  return (
    Boolean(lookupRequestId)
    && topicState?.pending_add?.busy === true
    && topicState.pending_add.lookup_request_id === lookupRequestId
    && topicState.pending_add.requested_by_user_id === requestedByUserId
  );
}

export function parseCallbackData(data) {
  const [prefix, action, value] = String(data ?? "").split(":");
  if (prefix !== ZOO_CALLBACK_PREFIX || !action) {
    return null;
  }

  return {
    action,
    value: value || null,
  };
}

export async function answerCallbackQuerySafe(api, callbackQueryId, text = undefined) {
  if (!callbackQueryId) {
    return;
  }

  try {
    await api.answerCallbackQuery(
      text
        ? {
            callback_query_id: callbackQueryId,
            text,
          }
        : {
            callback_query_id: callbackQueryId,
          },
    );
  } catch {}
}

export async function deleteMessagesBestEffort(api, chatId, messageIds = []) {
  for (const messageId of messageIds) {
    if (!Number.isInteger(messageId) || messageId <= 0) {
      continue;
    }
    try {
      await api.deleteMessage({
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {}
  }
}

export async function pinMessageBestEffort(api, chatId, messageId) {
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return;
  }

  try {
    await api.pinChatMessage({
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
    await deleteMessagesBestEffort(api, chatId, [messageId + 1]);
  } catch {}
}

export async function runSerializedZooOperation(key, operation) {
  const previous = ACTIVE_ZOO_OPERATION_CHAINS.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  ACTIVE_ZOO_OPERATION_CHAINS.set(key, current);

  try {
    return await current;
  } finally {
    if (ACTIVE_ZOO_OPERATION_CHAINS.get(key) === current) {
      ACTIVE_ZOO_OPERATION_CHAINS.delete(key);
    }
  }
}

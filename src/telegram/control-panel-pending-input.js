import {
  hasLeadingBotCommandText,
} from "./command-parsing.js";

export function getPendingInputMessageText(message) {
  return String(message?.text ?? message?.caption ?? "");
}

function hasMediaOrCaption(message) {
  return Boolean(
    message?.caption
    || message?.photo
    || message?.document
    || message?.video
    || message?.audio
    || message?.voice
    || message?.animation
    || message?.sticker,
  );
}

function isPlainTextPendingInputMessage(message) {
  return (
    typeof message?.text === "string"
    && message.text.trim()
    && !hasLeadingBotCommandText(message)
    && !hasMediaOrCaption(message)
  );
}

export function isSamePendingInputRequester(message, pendingInput) {
  return (
    !pendingInput.requested_by_user_id
    || String(message?.from?.id ?? "") === pendingInput.requested_by_user_id
  );
}

function getReplyToMessageId(message) {
  return Number(message?.reply_to_message?.message_id ?? 0) || null;
}

function getAcceptedReplyMessageIds(pendingInput) {
  return new Set(
    [pendingInput.menu_message_id, pendingInput.prompt_message_id]
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

export function isPendingInputTargetMessage(message, pendingInput) {
  const replyToMessageId = getReplyToMessageId(message);
  if (
    replyToMessageId
    && getAcceptedReplyMessageIds(pendingInput).has(replyToMessageId)
  ) {
    return true;
  }

  return isSamePendingInputRequester(message, pendingInput)
    && isPlainTextPendingInputMessage(message);
}

export function withPendingInputStatus(pendingInput, statusMessage) {
  return {
    ...pendingInput,
    status_message: statusMessage,
  };
}

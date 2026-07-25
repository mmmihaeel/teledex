function isGeneralThreadId(value) {
  return value === undefined || value === 0 || value === "0";
}

export function buildExpiredGlobalMenuMessage(_language, _getGlobalControlLanguage) {
  return "This /global menu is expired. Reopen /global.";
}

export function isGeneralForumMessage(message, config) {
  return (
    message
    && String(message.chat?.id ?? "") === String(config.telegramForumChatId ?? "")
    && isGeneralThreadId(message.message_thread_id)
  );
}

export function isGlobalControlCallbackQuery(callbackQuery, callbackPrefix) {
  return String(callbackQuery?.data ?? "").startsWith(`${callbackPrefix}:`);
}

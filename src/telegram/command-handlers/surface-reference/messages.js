import { DEFAULT_UI_LANGUAGE } from "../../../i18n/ui-language.js";

export function buildHelpTextMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Teledex quick help",
    "",
    "/help - this cheat sheet",
    "/guide - beginner PDF guidebook from General",
    "/clear - clear General and keep only the active menu",
    "/new [host=...] [provider=...] [model=...] [profile=...] [cwd=...|path=...] [title] - create a new work topic",
    "/hosts - show available execution hosts",
    "/host [id] - show one execution host status",
    "/zoo - open the dedicated Project Catalog topic",
    "/status - session, model, and context status",
    "/limits - current Codex rate-limit windows",
    "/global - pin-friendly global settings menu in General",
    "/menu - pin-friendly local settings menu in this topic",
    "/language - show the UI language",
    "/q <text> - add a prompt to the Agent queue",
    "/q status | /q delete <n> - inspect or remove queued prompts",
    "/wait 60 - local one-shot collection window",
    "/wait global 60 - persistent global collection window",
    "`All` - flush the collected prompt immediately",
    "/wait off - cancel the local one-shot window",
    "/wait global off - disable the global window",
    "/interrupt - stop the run",
    "/diff - diff for the current workspace",
    "/goal - show or change the app-server-v2 goal",
    "/compact - rebuild the brief from the exchange log",
    "/purge - clear local session state",
    "/suffix <text> - topic prompt suffix",
    "/suffix global <text> - global prompt suffix",
    "/suffix topic on|off - routing suffixes for this topic",
    "/suffix help - separate suffix cheat sheet",
    "/model [list|clear|<slug>] - Agent model for this topic",
    "/model global [list|clear|<slug>] - global Agent model default",
    "/reasoning [list|clear|<level>] - Agent reasoning for this topic",
    "/reasoning global [list|clear|<level>] - global Agent reasoning default",
  ].join("\n");
}

export function buildHelpCardPartialFailureMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "I sent part of the help card, but a later page failed.",
    "",
    "Run /help again if you still need the missing page.",
  ].join("\n");
}

export function buildGuideGeneralOnlyMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "/guide works in General only.",
    "",
    "Run it there to receive the beginner PDF guidebook.",
  ].join("\n");
}

export function buildGuideGenerationFailureMessage(
  _language = DEFAULT_UI_LANGUAGE,
  error = null,
) {
  const detail = error?.message
    ? `\n\nError: ${error.message}`
    : "";
  return `Could not generate the guidebook right now.${detail}`;
}

export function buildGuideDeliveryFailureMessage(
  _language = DEFAULT_UI_LANGUAGE,
  delivery = null,
) {
  const reason = String(delivery?.reason || "").trim();
  const detail = reason
    ? `\n\nReason: ${reason}`
    : "";
  return `Could not deliver the guidebook right now.${detail}`;
}

import { normalizeControlScreenId } from "../control-panel-view-common.js";

export const TOPIC_CONTROL_PANEL_CALLBACK_PREFIX = "tcfg";

export const SCREEN_CODES = {
  root: "r",
  status: "st",
  wait: "w",
  suffix: "s",
  language: "l",
  bot_settings: "b",
  agent_model: "sm",
  agent_reasoning: "sr",
};

export const SCREEN_IDS = Object.fromEntries(
  Object.entries(SCREEN_CODES).map(([screenId, code]) => [code, screenId]),
);

export const TARGET_CODES = {
  agent: "s",
};

export const TARGET_IDS = {
  s: "agent",
};

export function normalizeTopicControlScreenId(value) {
  return normalizeControlScreenId(value, SCREEN_CODES);
}

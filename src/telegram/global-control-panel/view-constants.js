import { normalizeControlScreenId } from "../control-panel-view-common.js";

export const GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX = "gcfg";

export const SCREEN_CODES = {
  root: "r",
  hosts: "hs",
  new_topic: "nt",
  new_topic_runtime: "nr",
  wait: "w",
  suffix: "s",
  language: "l",
  bot_settings: "b",
  agent_model: "sm",
  agent_reasoning: "sr",
  compact_model: "cm",
  compact_reasoning: "cr",
};

export const SCREEN_IDS = Object.fromEntries(
  Object.entries(SCREEN_CODES).map(([screenId, code]) => [code, screenId]),
);

export const TARGET_CODES = {
  agent: "s",
  compact: "c",
};

export const TARGET_IDS = {
  s: "agent",
  c: "compact",
};

export function normalizeGlobalControlScreenId(value) {
  return normalizeControlScreenId(value, SCREEN_CODES);
}

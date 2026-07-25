import { parseStandardControlCallbackData } from "../control-panel-view-common.js";
import {
  SCREEN_IDS,
  TARGET_IDS,
  TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
} from "./view-constants.js";

export function parseTopicControlCallbackData(data) {
  return parseStandardControlCallbackData(data, {
    prefix: TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
    screenIds: SCREEN_IDS,
    targetIds: TARGET_IDS,
    extraGroups: {
      t: (rest) => {
        const value = rest[0] ?? "";
        if (!["on", "off"].includes(value)) {
          return null;
        }
        return { kind: "suffix_routing_set", value };
      },
      cmd: (rest) => {
        const command = String(rest[0] ?? "").trim().toLowerCase();
        if (!["compact", "purge", "interrupt"].includes(command)) {
          return null;
        }
        return {
          kind: "command_dispatch",
          command,
        };
      },
      g: (rest) => {
        if (rest[0] !== "input") {
          return null;
        }
        return { kind: "goal_input" };
      },
    },
  });
}

import { parseStandardControlCallbackData } from "../control-panel-view-common.js";
import {
  GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  SCREEN_IDS,
  TARGET_IDS,
} from "./view-constants.js";

export function parseGlobalControlCallbackData(data) {
  return parseStandardControlCallbackData(data, {
    prefix: GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
    screenIds: SCREEN_IDS,
    targetIds: TARGET_IDS,
    extraGroups: {
      nh: (rest) => {
        const hostId = String(rest[0] ?? "").trim().toLowerCase();
        if (!hostId) {
          return null;
        }
        return {
          kind: "new_topic_host_select",
          hostId,
          runtimeProvider: String(rest[1] ?? "").trim().toLowerCase() || null,
          runtimeModel: String(rest[2] ?? "").trim().toLowerCase() || null,
        };
      },
      g: (rest) => (rest[0] === "show" ? { kind: "guide_show" } : null),
      z: (rest) => (rest[0] === "show" ? { kind: "zoo_show" } : null),
      c: (rest) => (rest[0] === "run" ? { kind: "clear_run" } : null),
    },
  });
}

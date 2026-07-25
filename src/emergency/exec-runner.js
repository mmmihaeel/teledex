import path from "node:path";

import {
  startCodexExecRun,
} from "../codex-exec/exec-runner.js";

export function startEmergencyExecRun({
  stateRoot,
  ...options
}) {
  return startCodexExecRun({
    ...options,
    outputDir: path.join(stateRoot, "emergency", "runs"),
    outputPrefix: "last-message",
  });
}

import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { RolloutCoordinationStore } from "../session-manager/rollout-coordination-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { ServiceGenerationStore } from "../runtime/service-generation-store.js";
import {
  SYSTEMD_USER_SERVICE_NAME,
  isSystemdUserSupported,
} from "../runtime/systemd-user-service.js";
import {
  performServiceRollout,
} from "../runtime/service-rollout-command.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WAIT_TIMEOUT_MS = 30000;

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

async function runSystemctl(args) {
  await execFileAsync("systemctl", ["--user", ...args]);
}

export function isUnavailableSystemdUnitError(error, serviceName = SYSTEMD_USER_SERVICE_NAME) {
  const text = [
    error?.stderr,
    error?.stdout,
    error?.message,
  ].filter(Boolean).join("\n");
  if (Number(error?.code) === 5) {
    return true;
  }

  const escapedServiceName = String(serviceName).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:Unit\\s+${escapedServiceName}\\s+(?:could not be found|not found)|${escapedServiceName}.*(?:not loaded|not found))`,
    "iu",
  ).test(text);
}

export async function restartSystemdService({
  runSystemctlImpl = runSystemctl,
} = {}) {
  await runSystemctlImpl(["restart", SYSTEMD_USER_SERVICE_NAME]);
}

async function main() {
  if (!isSystemdUserSupported()) {
    throw new Error("service rollout is Linux-only");
  }

  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const generationStore = new ServiceGenerationStore({
    indexesRoot: layout.indexes,
    tmpRoot: layout.tmp,
    serviceKind: "agent",
    generationId: "operator",
  });
  const rolloutCoordinationStore = new RolloutCoordinationStore(layout.settings);
  const waitTimeoutMs = Number.parseInt(
    process.env.SERVICE_ROLLOUT_WAIT_TIMEOUT_MS ?? "",
    10,
  );
  const timeoutMs =
    Number.isInteger(waitTimeoutMs) && waitTimeoutMs > 0
      ? waitTimeoutMs
      : DEFAULT_WAIT_TIMEOUT_MS;

  const result = await performServiceRollout({
    generationStore,
    rolloutCoordinationStore,
    timeoutMs,
    restartService: () => restartSystemdService(),
  });

  printLine("mode", result.mode);
  if (result.previousGenerationId) {
    printLine("previous_generation", result.previousGenerationId);
  }
  printLine("leader_generation", result.leaderGenerationId);
  printLine("leader_pid", result.leaderPid);
  if (result.rolloutStatus) {
    printLine("rollout_status", result.rolloutStatus);
  }
  if (result.retiringGenerationId) {
    printLine("retiring_generation", result.retiringGenerationId);
  }
  if (Number.isInteger(result.retainedSessionCount)) {
    printLine("retained_sessions", result.retainedSessionCount);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`service rollout failed: ${error.message}`);
    process.exitCode = 1;
  });
}

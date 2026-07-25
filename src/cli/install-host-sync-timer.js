import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  TELEDEX_HOST_SYNC_SERVICE_NAME,
  TELEDEX_HOST_SYNC_TIMER_NAME,
  TELEDEX_DISPLAY_NAME,
} from "../config/app-identity.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  buildServicePathEntries,
  buildUnsupportedSystemdUserMessage,
  isSystemdUserSupported,
} from "../runtime/systemd-user-service.js";

const execFileAsync = promisify(execFile);
const SYNC_SERVICE_NAME = TELEDEX_HOST_SYNC_SERVICE_NAME;
const SYNC_TIMER_NAME = TELEDEX_HOST_SYNC_TIMER_NAME;

function quoteEnvironment(name, value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"');
  return `Environment="${name}=${escaped}"`;
}

function quoteUnitValue(value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"');
  return `"${escaped}"`;
}

function escapeDirectiveValue(value) {
  return String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/ /gu, "\\ ");
}

function getUserUnitPath(unitName) {
  return path.posix.join(os.homedir(), ".config", "systemd", "user", unitName);
}

export function buildHostSyncServiceUnit({
  repoRoot,
  envFilePath,
  nodePath,
  pathEntries,
}) {
  const scriptPath = path.posix.resolve(repoRoot, "src/cli/registry-sync.js");
  const pathValue = [...new Set(pathEntries.filter(Boolean))].join(":");

  return [
    "[Unit]",
    `Description=${TELEDEX_DISPLAY_NAME} Registry Sync`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "UMask=0077",
    `WorkingDirectory=${escapeDirectiveValue(repoRoot)}`,
    quoteEnvironment("ENV_FILE", envFilePath),
    quoteEnvironment("PATH", pathValue),
    `ExecStart=${quoteUnitValue(nodePath)} ${quoteUnitValue(scriptPath)}`,
    "",
  ].join("\n");
}

function buildHostSyncTimerUnit(intervalMinutes) {
  return [
    "[Unit]",
    `Description=Run ${TELEDEX_DISPLAY_NAME} registry sync periodically`,
    "",
    "[Timer]",
    `OnUnitActiveSec=${intervalMinutes}min`,
    "OnBootSec=2min",
    "RandomizedDelaySec=90",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

async function runSystemctl(args) {
  await execFileAsync("systemctl", ["--user", ...args]);
}

async function main() {
  if (!isSystemdUserSupported()) {
    throw new Error(buildUnsupportedSystemdUserMessage());
  }

  const config = await loadRuntimeConfig();
  if (config.currentHostId !== "local") {
    throw new Error("Registry sync timer can only be installed on local");
  }

  const servicePath = getUserUnitPath(SYNC_SERVICE_NAME);
  const timerPath = getUserUnitPath(SYNC_TIMER_NAME);
  const nodePath = process.execPath;
  const pathEntries = buildServicePathEntries({ nodePath });

  await fs.mkdir(path.dirname(servicePath), { recursive: true });
  await fs.writeFile(
    servicePath,
    buildHostSyncServiceUnit({
      repoRoot: config.repoRoot,
      envFilePath: config.envFilePath,
      nodePath,
      pathEntries,
    }),
    "utf8",
  );
  await fs.writeFile(
    timerPath,
    buildHostSyncTimerUnit(config.hostSyncIntervalMinutes),
    "utf8",
  );

  await runSystemctl(["daemon-reload"]);
  await runSystemctl(["enable", "--now", SYNC_TIMER_NAME]);

  console.log(`service: ${servicePath}`);
  console.log(`timer: ${timerPath}`);
  console.log(`interval_minutes: ${config.hostSyncIntervalMinutes}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`registry sync timer install failed: ${error.message}`);
    process.exitCode = 1;
  });
}

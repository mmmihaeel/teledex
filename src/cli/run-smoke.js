#!/usr/bin/env node

import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assertSmokeSupported } from "./run-smoke-common.js";
import { SYSTEMD_USER_SERVICE_NAME } from "../runtime/systemd-user-service.js";
import { applyEnvFileArg } from "./env-file-args.js";

const execFileAsync = promisify(execFile);

async function main() {
  const { envFilePath } = applyEnvFileArg(process.argv.slice(2));
  const serviceName = SYSTEMD_USER_SERVICE_NAME;
  await assertSmokeSupported(serviceName, {
    execFileAsync,
  });

  const scriptPath = fileURLToPath(
    new URL("./run.js", import.meta.url),
  );
  const childArgs = envFilePath ? [scriptPath, "--env-file", envFilePath] : [scriptPath];
  const child = spawn(process.execPath, childArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_ONCE: "1",
      TELEGRAM_POLL_TIMEOUT_SECS: "1",
    },
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`smoke run exited via signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

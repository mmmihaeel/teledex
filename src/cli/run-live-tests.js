#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  let suite = "app-server-v2";
  const nodeTestArgs = [];

  for (const arg of argv) {
    if (arg === "--exec-json") {
      suite = "exec-json";
      continue;
    }
    if (arg === "--app-server") {
      suite = "app-server";
      continue;
    }
    if (arg === "--app-server-v2") {
      suite = "app-server-v2";
      continue;
    }
    nodeTestArgs.push(arg);
  }

  return { suite, nodeTestArgs };
}

function resolveLiveTestPath(suite) {
  if (suite === "app-server") {
    return [path.join(REPO_ROOT, "test", "worker-pool.live.test.js")];
  }
  if (suite === "app-server-v2") {
    return [path.join(REPO_ROOT, "test", "worker-pool.app-server-v2.live.test.js")];
  }

  return [
    path.join(REPO_ROOT, "test", "telegram-exec-runner.live.test.js"),
    path.join(REPO_ROOT, "test", "worker-pool.exec-json.live.test.js"),
  ];
}

function ensureSequentialNodeTestArgs(args = []) {
  if (
    args.some((arg) =>
      arg === "--test-concurrency"
      || String(arg).startsWith("--test-concurrency="),
    )
  ) {
    return args;
  }

  return ["--test-concurrency=1", ...args];
}

export function buildLiveNodeTestArgs({ suite = "app-server-v2", nodeTestArgs = [] } = {}) {
  return [
    "--test",
    ...ensureSequentialNodeTestArgs(nodeTestArgs),
    ...resolveLiveTestPath(suite),
  ];
}

async function main() {
  const { suite, nodeTestArgs } = parseArgs(process.argv.slice(2));
  const child = spawn(
    process.execPath,
    buildLiveNodeTestArgs({ suite, nodeTestArgs }),
    {
      stdio: "inherit",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEX_LIVE_TESTS: "1",
        ...(suite === "app-server"
          ? { TELEDEX_ENABLE_LEGACY_APP_SERVER: "1" }
          : {}),
        ...(suite === "app-server-v2"
          ? { TELEDEX_ENABLE_APP_SERVER_V2: "1" }
          : {}),
      },
    },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`live tests exited via signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

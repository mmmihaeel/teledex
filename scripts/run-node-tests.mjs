#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanupTestTempDirs,
  createTestRunTempRoot,
  hasExplicitTestFile,
} from "./run-node-tests-support.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(REPO_ROOT, "test");
const BEFORE_CLEANUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const EXEC_TEST_FILES = [
  "test/telegram-exec-runner.test.js",
  "test/exec-runner.test.js",
  "test/remote-executor.test.js",
  "test/host-aware-run-task.test.js",
  "test/worker-pool-common.test.js",
  "test/worker-pool-startup.test.js",
  "test/worker-pool.test.js",
  "test/worker-pool-exec-json-contract.test.js",
  "test/worker-pool-live-steer.test.js",
  "test/session-store.test.js",
  "test/session-service.test.js",
  "test/session-compactor.test.js",
  "test/run-stale-run-recovery.test.js",
];

async function collectDefaultTestFiles(dir = TEST_ROOT) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectDefaultTestFiles(fullPath));
      continue;
    }
    if (
      entry.isFile()
      && entry.name.endsWith(".test.js")
      && !entry.name.includes(".live.")
    ) {
      files.push(path.relative(REPO_ROOT, fullPath));
    }
  }

  return files.sort();
}

function buildTestRunEnv(runTempRoot) {
  return {
    ...process.env,
    TMPDIR: runTempRoot,
    TEMP: runTempRoot,
    TMP: runTempRoot,
  };
}

function parseArgs(rawArgs) {
  const args = [];
  let suite = null;
  let cleanupOnly = false;
  let cleanupAll = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--cleanup-only") {
      cleanupOnly = true;
      continue;
    }
    if (arg === "--cleanup-all") {
      cleanupAll = true;
      continue;
    }
    if (arg === "--suite") {
      suite = rawArgs[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length);
      continue;
    }
    args.push(arg);
  }

  return { args, cleanupAll, cleanupOnly, suite };
}

async function buildNodeTestArgs({ args, suite }) {
  if (suite === "exec") {
    return [...args, ...EXEC_TEST_FILES];
  }
  if (suite) {
    throw new Error(`Unknown test suite: ${suite}`);
  }
  if (hasExplicitTestFile(args)) {
    return args;
  }
  return [...args, ...await collectDefaultTestFiles()];
}

async function main() {
  const { args, cleanupAll, cleanupOnly, suite } = parseArgs(process.argv.slice(2));

  if (cleanupOnly) {
    const removed = await cleanupTestTempDirs({
      olderThanMs: cleanupAll ? 0 : BEFORE_CLEANUP_MAX_AGE_MS,
    });
    console.log(`removed_test_temp_dirs: ${removed}`);
    return;
  }

  await cleanupTestTempDirs({ olderThanMs: BEFORE_CLEANUP_MAX_AGE_MS });
  const runStartedAtMs = Date.now();
  const runTempRoot = await createTestRunTempRoot();
  const nodeTestArgs = await buildNodeTestArgs({ args, suite });
  let result;
  try {
    result = spawnSync(
      process.execPath,
      ["--test", ...nodeTestArgs],
      {
        cwd: REPO_ROOT,
        env: buildTestRunEnv(runTempRoot),
        stdio: "inherit",
      },
    );
  } finally {
    await cleanupTestTempDirs({
      tmpRoot: runTempRoot,
      sinceMs: runStartedAtMs,
      includeMarked: false,
      includeUnmarked: true,
    }).catch(() => {});
    await fs.rm(runTempRoot, { recursive: true, force: true }).catch(() => {});
  }

  if (result.signal) {
    console.error(`node --test terminated by signal ${result.signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`run-node-tests failed: ${error.message}`);
    process.exitCode = 1;
  });
}

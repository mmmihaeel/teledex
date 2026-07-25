import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupTestTempDirs,
  createTestRunTempRoot,
  hasExplicitTestFile,
  isRepoOwnedTempDir,
} from "../scripts/run-node-tests-support.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hasExplicitTestFile accepts POSIX and Windows-style test paths", () => {
  assert.equal(hasExplicitTestFile(["test/foo.test.js"]), true);
  assert.equal(hasExplicitTestFile(["test\\foo.test.js"]), true);
  assert.equal(hasExplicitTestFile(["--test-name-pattern", "foo"]), false);
});

test("cleanupTestTempDirs only removes marked runner temp roots", async () => {
  const marked = await createTestRunTempRoot();
  const unmarked = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-unmarked-"),
  );

  try {
    assert.equal(isRepoOwnedTempDir(path.basename(marked)), true);
    const removed = await cleanupTestTempDirs({ olderThanMs: 0 });
    assert.equal(removed >= 1, true);
    await assert.rejects(() => fs.stat(marked), { code: "ENOENT" });
    assert.equal((await fs.stat(unmarked)).isDirectory(), true);
  } finally {
    await fs.rm(marked, { recursive: true, force: true });
    await fs.rm(unmarked, { recursive: true, force: true });
  }
});

test("cleanupTestTempDirs can remove unmarked dirs created by the current run", async () => {
  const runStartedAtMs = Date.now();
  const scanRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-cleanup-scan-"),
  );
  const unmarked = await fs.mkdtemp(
    path.join(scanRoot, "teledex-unmarked-current-"),
  );

  try {
    const removed = await cleanupTestTempDirs({
      tmpRoot: scanRoot,
      sinceMs: runStartedAtMs - 1000,
      includeMarked: false,
      includeUnmarked: true,
    });
    assert.equal(removed >= 1, true);
    await assert.rejects(() => fs.stat(unmarked), { code: "ENOENT" });
  } finally {
    await fs.rm(scanRoot, { recursive: true, force: true });
  }
});

test("run-node-tests does not remove fresh unmarked dirs from parent temp root", async (t) => {
  const parentUnmarked = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-unmarked-parent-"),
  );
  const testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-wrapper-test-"),
  );
  const testFile = path.join(testDir, "pass.test.js");
  await fs.writeFile(
    testFile,
    "import test from 'node:test';\ntest('pass', () => {});\n",
    "utf8",
  );
  t.after(async () => {
    await fs.rm(parentUnmarked, { recursive: true, force: true });
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "run-node-tests.mjs"), testFile],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await fs.stat(parentUnmarked)).isDirectory(), true);
});

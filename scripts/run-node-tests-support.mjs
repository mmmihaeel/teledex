import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const TEST_RUN_TEMP_PREFIX = "teledex-test-run-";
const TEST_RUN_MARKER_FILE = ".teledex-test-run";
const TEST_TEMP_PREFIXES = [
  TEST_RUN_TEMP_PREFIX,
  "teledex-",
  "codex-exec-jsonl-mirror-",
  "codex-legacy-remote-images-",
  "codex-remote-images-",
  "codex-runtime-models-",
];

export function isRepoOwnedTempDir(name) {
  return TEST_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function hasTestRunMarker(dirPath) {
  try {
    const stats = await fs.stat(path.join(dirPath, TEST_RUN_MARKER_FILE));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function resolveActiveTempRoots() {
  const roots = new Set();
  for (const candidate of [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
  ]) {
    if (!candidate) {
      continue;
    }
    try {
      roots.add(await fs.realpath(candidate));
    } catch {
      roots.add(path.resolve(candidate));
    }
  }
  return roots;
}

export async function cleanupTestTempDirs({
  tmpRoot = os.tmpdir(),
  olderThanMs = null,
  sinceMs = null,
  includeMarked = true,
  includeUnmarked = false,
} = {}) {
  const activeTempRoots = await resolveActiveTempRoots();
  let entries;
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isRepoOwnedTempDir(entry.name)) {
      continue;
    }

    const dirPath = path.join(tmpRoot, entry.name);
    let resolvedDirPath;
    try {
      resolvedDirPath = await fs.realpath(dirPath);
    } catch {
      resolvedDirPath = path.resolve(dirPath);
    }
    if (activeTempRoots.has(resolvedDirPath)) {
      continue;
    }

    const hasMarker = await hasTestRunMarker(dirPath);
    if ((hasMarker && !includeMarked) || (!hasMarker && !includeUnmarked)) {
      continue;
    }

    let stats;
    try {
      stats = await fs.stat(dirPath);
    } catch {
      continue;
    }

    if (olderThanMs !== null && now - stats.mtimeMs < olderThanMs) {
      continue;
    }
    if (sinceMs !== null && stats.mtimeMs < sinceMs) {
      continue;
    }

    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }

  return removed;
}

export async function createTestRunTempRoot() {
  const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), TEST_RUN_TEMP_PREFIX));
  await fs.writeFile(
    path.join(runTempRoot, TEST_RUN_MARKER_FILE),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
  return runTempRoot;
}

export function hasExplicitTestFile(args) {
  return args.some((arg) => {
    if (arg.startsWith("-")) {
      return false;
    }
    const normalized = arg.replace(/\\/gu, "/");
    return normalized.endsWith(".js") || normalized.startsWith("test/");
  });
}

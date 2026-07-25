import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { getSessionKey } from "./session-key.js";
import {
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  writeTextAtomic,
} from "../state/file-utils.js";
import {
  META_LOCK_RETRY_MS,
  META_LOCK_STALE_MS,
  META_LOCK_TIMEOUT_MS,
  sleep,
} from "./session-store-common.js";

const META_LOCK_OWNER_FILE = "owner.json";
const META_LOCK_HEARTBEAT_MS = Math.max(
  1000,
  Math.min(10_000, Math.floor(META_LOCK_STALE_MS / 3)),
);

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function writeMetaLockOwner(lockPath) {
  await writeTextAtomic(
    path.join(lockPath, META_LOCK_OWNER_FILE),
    `${JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

async function readMetaLockOwner(lockPath) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(lockPath, META_LOCK_OWNER_FILE), "utf8"),
    );
  } catch {
    return null;
  }
}

async function isMetaLockReapable(lockPath) {
  const stats = await fs.stat(lockPath);
  if (Date.now() - stats.mtimeMs < META_LOCK_STALE_MS) {
    return false;
  }

  const owner = await readMetaLockOwner(lockPath);
  if (isProcessAlive(Number(owner?.pid))) {
    return false;
  }

  return true;
}

function startMetaLockHeartbeat(lockPath) {
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockPath, now, now).catch(() => {});
  }, META_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return heartbeat;
}

export async function withMetaLock(store, chatId, topicId, fn) {
  const sessionDir = store.getSessionDir(chatId, topicId);
  const lockPath = store.getMetaLockPath(chatId, topicId);
  await ensurePrivateDirectory(sessionDir);
  const startedAt = Date.now();
  let heartbeat;

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      try {
        await writeMetaLockOwner(lockPath);
        heartbeat = startMetaLockHeartbeat(lockPath);
      } catch (ownerError) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw ownerError;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAt >= META_LOCK_TIMEOUT_MS) {
        try {
          if (await isMetaLockReapable(lockPath)) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") {
            continue;
          }
          throw statError;
        }

        throw new Error(
          `Timed out acquiring session meta lock for ${getSessionKey(chatId, topicId)}`,
          { cause: error },
        );
      }

      await sleep(META_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

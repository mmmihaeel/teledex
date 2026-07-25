import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  TELEDEX_APP_NAME,
} from "./app-identity.js";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function isWindows(platform = process.platform) {
  return platform === "win32";
}

function getWindowsLocalAppData({
  homeDirectory = os.homedir(),
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  return localAppData?.trim() || path.join(homeDirectory, "AppData", "Local");
}

export function getDefaultRepoRoot() {
  return DEFAULT_REPO_ROOT;
}

export function getDefaultStateRoot(options = {}) {
  if (isWindows(options.platform)) {
    return path.join(getWindowsLocalAppData(options), TELEDEX_APP_NAME);
  }

  const stateHome = options.xdgStateHome?.trim()
    || process.env.XDG_STATE_HOME?.trim()
    || path.join(options.homeDirectory || os.homedir(), ".local", "state");
  return path.join(stateHome, TELEDEX_APP_NAME);
}

export function getDefaultWorkspaceRoot(options = {}) {
  if (isWindows(options.platform)) {
    return path.dirname(options.repoRoot || getDefaultRepoRoot());
  }

  return path.dirname(options.repoRoot || getDefaultRepoRoot());
}

export function getDefaultEnvFilePath(options = {}) {
  return path.join(
    options.stateRoot || getDefaultStateRoot(options),
    "runtime.env",
  );
}

function getRepoEnvFilePath(options = {}) {
  return path.join(options.repoRoot || getDefaultRepoRoot(), ".env");
}

export function getDefaultCodexConfigPath({
  homeDirectory = os.homedir(),
} = {}) {
  return path.join(homeDirectory, ".codex", "config.toml");
}

export function getDefaultCodexSessionsRoot({
  homeDirectory = os.homedir(),
} = {}) {
  return path.join(homeDirectory, ".codex", "sessions");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRuntimeEnvFilePath({
  explicitEnvFilePath = process.env.ENV_FILE,
  platform = process.platform,
  repoRoot = getDefaultRepoRoot(),
  stateRoot = getDefaultStateRoot({ platform }),
  allowRepoEnvFallback =
    process.env.TELEDEX_ALLOW_REPO_ENV === "1"
    || isWindows(platform),
} = {}) {
  const explicit = explicitEnvFilePath?.trim();
  if (explicit) {
    return explicit;
  }

  const repoEnvFilePath = getRepoEnvFilePath({ repoRoot });
  if (
    isWindows(platform)
    && allowRepoEnvFallback
    && await fileExists(repoEnvFilePath)
  ) {
    return repoEnvFilePath;
  }

  const defaultEnvFilePath = getDefaultEnvFilePath({ stateRoot });
  if (await fileExists(defaultEnvFilePath)) {
    return defaultEnvFilePath;
  }

  if (allowRepoEnvFallback && await fileExists(repoEnvFilePath)) {
    return repoEnvFilePath;
  }

  return defaultEnvFilePath;
}

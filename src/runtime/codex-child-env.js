import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED_ENV_NAMES = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "CODEX_AUTH_PATH",
  "CODEX_CONFIG_PATH",
  "CODEX_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "Path",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PITLANE_CODEX_BYPASS",
  "PITLANE_CODEX_HOOK_DISABLE",
  "PITLANE_DISABLE",
  "PITLANE_DISABLED",
  "RTK_CODEX_BYPASS",
  "RTK_CODEX_HOOK_DISABLE",
  "RTK_DISABLE",
  "RTK_DISABLED",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const ALLOWED_ENV_PREFIXES = [
  "ANTHROPIC_",
  "AZURE_OPENAI_",
  "DEEPSEEK_",
  "OPENAI_",
  "OPENROUTER_",
];

const BLOCKED_ENV_NAMES = new Set([
  "BOT_TOKEN",
  "ENV_FILE",
  "HOST_REGISTRY_PATH",
  "SERVICE_GENERATION_ID",
  "STATE_ROOT",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_FORUM_CHAT_ID",
  "TELEGRAM_OPERATOR_USER_IDS",
  "TELEGRAM_USER_ENV_FILE",
]);

const BLOCKED_ENV_PREFIXES = [
  "CODEX_GATEWAY_",
  "CODEX_LIMITS_",
  "AGENT_",
  "TELEDEX_",
  "TELEGRAM_",
];

function shouldBlockEnvName(name) {
  return (
    BLOCKED_ENV_NAMES.has(name)
    || BLOCKED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function shouldAllowEnvName(name) {
  return (
    ALLOWED_ENV_NAMES.has(name)
    || ALLOWED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function isValidEnvName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(name || ""));
}

function normalizeExtraAllowedEnvNames(names) {
  return new Set(
    []
      .concat(names || [])
      .map((name) => String(name || "").trim())
      .filter((name) => isValidEnvName(name) && !shouldBlockEnvName(name)),
  );
}

function shouldAllowChildEnvName(name, extraAllowedNames) {
  return shouldAllowEnvName(name) || extraAllowedNames.has(name);
}

function normalizeWindowsPathEnv(env) {
  const pathEntries = Object.entries(env)
    .filter(([name]) => name.toLowerCase() === "path");
  if (pathEntries.length === 0) {
    return;
  }

  const preferred =
    pathEntries.find(([, value]) => String(value ?? "").includes(";"))
    || pathEntries.find(([name]) => name === "Path")
    || pathEntries.find(([name]) => name === "PATH")
    || pathEntries[0];

  for (const [name] of pathEntries) {
    delete env[name];
  }
  env.Path = preferred[1];
}

export function getCodexProviderEnvKeyNames(modelProviderConfig) {
  const envKey = String(modelProviderConfig?.env_key || "").trim();
  return isValidEnvName(envKey) && !shouldBlockEnvName(envKey) ? [envKey] : [];
}

function parseProviderEnvText(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = assignment.slice(0, separatorIndex).trim();
    let value = assignment.slice(separatorIndex + 1).trim();
    if (!isValidEnvName(name)) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function readProviderEnv(sourceEnv, { loadProviderEnv, providerEnvPath }) {
  const shouldLoad = loadProviderEnv ?? sourceEnv === process.env;
  if (!shouldLoad) {
    return {};
  }

  const homePath = sourceEnv?.HOME || os.homedir();
  const resolvedPath = providerEnvPath || (homePath
    ? path.join(homePath, ".codex", "provider-env")
    : null);
  if (!resolvedPath) {
    return {};
  }

  try {
    return parseProviderEnvText(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    return {};
  }
}

export function buildCodexChildEnv(
  sourceEnv = process.env,
  {
    extraEnv = {},
    extraAllowedEnvNames = [],
    loadProviderEnv,
    platform = process.platform,
    providerEnvPath,
  } = {},
) {
  const childEnv = {};
  const extraAllowedNames = normalizeExtraAllowedEnvNames(extraAllowedEnvNames);
  for (const [name, value] of Object.entries(sourceEnv || {})) {
    if (
      value === undefined
      || shouldBlockEnvName(name)
      || !shouldAllowChildEnvName(name, extraAllowedNames)
    ) {
      continue;
    }
    childEnv[name] = value;
  }

  for (const [name, value] of Object.entries(readProviderEnv(sourceEnv, {
    loadProviderEnv,
    providerEnvPath,
  }))) {
    if (
      value === undefined
      || shouldBlockEnvName(name)
      || !shouldAllowChildEnvName(name, extraAllowedNames)
    ) {
      continue;
    }
    childEnv[name] = value;
  }

  for (const [name, value] of Object.entries(extraEnv || {})) {
    if (value === undefined || shouldBlockEnvName(name)) {
      continue;
    }
    childEnv[name] = value;
  }

  if (platform === "win32") {
    normalizeWindowsPathEnv(childEnv);
  }

  return childEnv;
}

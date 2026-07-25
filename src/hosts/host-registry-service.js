import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "smol-toml";

import {
  formatExecutionHostName,
  normalizeHostId,
  normalizeHostLabel,
} from "./topic-host.js";
import { ensurePrivateDirectory, writeTextAtomic } from "../state/file-utils.js";
import { normalizeSshTarget } from "./host-command-runner.js";

const HOST_REGISTRY_SCHEMA_VERSION = 2;
const REGISTRY_LOCK_TIMEOUT_MS = 15_000;
const REGISTRY_LOCK_RETRY_MS = 50;
const REGISTRY_LOCK_STALE_MS = 2 * 60_000;

const CANONICAL_HOST_REQUIRED_KEYS = [
  "id",
  "role",
  "availability",
  "lan_ipv4",
  "host_user",
  "host_root",
  "state_root",
];

const MUTABLE_HOST_STATE_KEYS = [
  "last_health",
  "last_health_checked_at",
  "failure_reason",
  "last_ready_at",
];

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => normalizeOptionalText(value))
        .filter(Boolean),
    ),
  ];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildDefaultRegistry(currentHostId) {
  return {
    schema_version: HOST_REGISTRY_SCHEMA_VERSION,
    hosts: [
      {
        host_id: currentHostId,
        label: currentHostId,
        ssh_target: currentHostId,
        enabled: true,
        role: null,
        host_user: null,
        host_root: null,
        state_root: null,
        workspace_root: null,
        repo_root: null,
        default_binding_path: null,
        worker_runtime_root: null,
        codex_bin_path: null,
        codex_config_path: null,
        codex_auth_path: null,
        profile_id: null,
        suffix_id: null,
        mcp_mode: null,
        capabilities: [],
        required_capabilities: [],
        supports_root_mesh: false,
        last_health: "unknown",
        last_health_checked_at: null,
        failure_reason: null,
        last_ready_at: null,
      },
    ],
  };
}

function rejectLegacyRegistryShapes(document, registryPath) {
  if (document?.registry) {
    throw new Error(`${registryPath}: nested registry tables are not supported`);
  }
  if (document?.raw_toml) {
    throw new Error(`${registryPath}: raw_toml is not supported`);
  }
}

function parseRegistryToml(text, registryPath) {
  let document;
  try {
    document = parse(text);
  } catch (error) {
    throw new Error(`${registryPath}: ${error.message}`, { cause: error });
  }

  rejectLegacyRegistryShapes(document, registryPath);
  if (!Array.isArray(document.hosts)) {
    throw new Error(`${registryPath}: expected top-level [[hosts]]`);
  }
  return document;
}

function sanitizeTomlValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTomlValue(entry));
  }
  return value;
}

function sanitizeHostForToml(host) {
  return Object.fromEntries(
    Object.entries(host).map(([key, value]) => [key, sanitizeTomlValue(value)]),
  );
}

function assertFlatHostEntry(entry, registryPath, tableName = "hosts") {
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      throw new Error(`${registryPath}: \`${tableName}.${key}\` must stay flat`);
    }
    if (key === "raw_toml") {
      throw new Error(`${registryPath}: raw_toml is not supported`);
    }
    if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) {
      throw new Error(`${registryPath}: \`${tableName}.${key}\` must not contain tables`);
    }
  }
}

function requireCanonicalString(entry, key, registryPath) {
  const value = entry?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${registryPath}: \`${key}\` must be a non-empty string`);
  }
  return value.trim();
}

function validateCanonicalHostEntry(entry, { registryPath, shardOwner = null }) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${registryPath}: each host entry must be a table`);
  }

  assertFlatHostEntry(entry, registryPath);
  const hostId = requireCanonicalString(entry, "id", registryPath);
  for (const key of CANONICAL_HOST_REQUIRED_KEYS) {
    requireCanonicalString(entry, key, registryPath);
  }
  const mutableKeys = MUTABLE_HOST_STATE_KEYS.filter((key) => key in entry);
  if (mutableKeys.length > 0) {
    throw new Error(
      `${registryPath}: mutable host state belongs in runtime fallback only: ${mutableKeys.join(", ")}`,
    );
  }
  if (shardOwner) {
    if (normalizeHostId(hostId, null) !== normalizeHostId(shardOwner, null)) {
      throw new Error(
        `${registryPath}: host id \`${hostId}\` does not match shard owner \`${shardOwner}\``,
      );
    }
  }
}

async function listCanonicalHostFiles(sourcePath) {
  const stat = await fs.stat(sourcePath);
  if (stat.isFile()) {
    return [{ filePath: sourcePath, shardOwner: null }];
  }
  if (!stat.isDirectory()) {
    throw new Error(`${sourcePath}: expected a TOML file or directory`);
  }

  const shardRoot = path.join(sourcePath, "shards");
  const root = await fs.stat(shardRoot)
    .then((entry) => entry.isDirectory() ? shardRoot : sourcePath)
    .catch(() => sourcePath);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const shardFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      filePath: path.join(root, entry.name, "hosts.toml"),
      shardOwner: entry.name,
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const existingShardFiles = [];
  for (const record of shardFiles) {
    const exists = await fs.stat(record.filePath)
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (exists) {
      existingShardFiles.push(record);
    }
  }
  if (existingShardFiles.length > 0) {
    return existingShardFiles;
  }

  const directHostsPath = path.join(sourcePath, "hosts.toml");
  const hasDirectHosts = await fs.stat(directHostsPath)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (hasDirectHosts) {
    return [{ filePath: directHostsPath, shardOwner: null }];
  }

  throw new Error(`${sourcePath}: no canonical hosts.toml files found`);
}

async function sourceMetadata(sourcePath) {
  if (!sourcePath) {
    return {
      source_path: "",
      source_mtime_ms: 0,
      source_sha256: "",
    };
  }

  const files = await listCanonicalHostFiles(sourcePath);
  const fileRecords = await Promise.all(
    files.map(async ({ filePath }) => {
      const [stat, buffer] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(filePath),
      ]);
      return { filePath, stat, buffer };
    }),
  );
  const hash = crypto.createHash("sha256");
  let maxMtimeMs = 0;
  for (const record of fileRecords) {
    hash.update(path.relative(sourcePath, record.filePath));
    hash.update("\0");
    hash.update(record.buffer);
    hash.update("\0");
    maxMtimeMs = Math.max(maxMtimeMs, record.stat.mtimeMs);
  }

  return {
    source_path: sourcePath,
    source_mtime_ms: Math.trunc(maxMtimeMs),
    source_sha256: hash.digest("hex"),
  };
}

async function writeRegistryState(registryPath, document, sync = {}) {
  const payload = {
    sync: {
      schema_version: HOST_REGISTRY_SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      status: sync.status || "ok",
      source_path: sync.source_path || "",
      source_mtime_ms: sync.source_mtime_ms || 0,
      source_sha256: sync.source_sha256 || "",
      error: sync.error || "",
    },
    hosts: document.hosts.map(sanitizeHostForToml),
  };

  await writeTextAtomic(registryPath, `${stringify(payload).trim()}\n`);
}

async function quarantineMalformedRegistry(registryPath, text) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const quarantinePath = `${registryPath}.corrupt-${stamp}`;
  await writeTextAtomic(quarantinePath, text);
  await fs.rm(registryPath, { force: true });
}

function normalizeHostEntry(
  entry,
  currentHostId,
  { fallbackToCurrentHost = false } = {},
) {
  const hostId = normalizeHostId(
    entry?.host_id ?? entry?.hostId ?? entry?.id,
    fallbackToCurrentHost ? currentHostId : null,
  );
  const label = normalizeHostLabel(entry?.label, hostId);
  const sshTarget = normalizeOptionalText(
    entry?.ssh_target ?? entry?.sshTarget,
  ) || hostId;
  const hostRoot = normalizeOptionalText(entry?.host_root ?? entry?.hostRoot);
  const stateRoot = normalizeOptionalText(entry?.state_root ?? entry?.stateRoot);

  return {
    host_id: hostId,
    label,
    ssh_target: normalizeSshTarget(sshTarget),
    enabled: entry?.enabled !== false,
    role: normalizeOptionalText(entry?.role),
    host_user: normalizeOptionalText(entry?.host_user ?? entry?.workspaceUser),
    host_root: hostRoot,
    state_root: stateRoot,
    workspace_root: normalizeOptionalText(
      entry?.workspace_root ?? entry?.workspaceRoot ?? hostRoot,
    ),
    repo_root: normalizeOptionalText(
      entry?.repo_root ?? entry?.repoRoot,
    ),
    default_binding_path: normalizeOptionalText(
      entry?.default_binding_path ?? entry?.defaultBindingPath ?? hostRoot,
    ),
    worker_runtime_root: normalizeOptionalText(
      entry?.worker_runtime_root ?? entry?.workerRuntimeRoot ?? stateRoot,
    ),
    codex_bin_path: normalizeOptionalText(
      entry?.codex_bin_path ?? entry?.codexBinPath,
    ),
    codex_config_path: normalizeOptionalText(
      entry?.codex_config_path ?? entry?.codexConfigPath,
    ),
    codex_auth_path: normalizeOptionalText(
      entry?.codex_auth_path ?? entry?.codexAuthPath,
    ),
    profile_id: normalizeOptionalText(
      entry?.profile_id ?? entry?.profileId,
    ),
    suffix_id: normalizeOptionalText(
      entry?.suffix_id ?? entry?.suffixId,
    ),
    mcp_mode: normalizeOptionalText(
      entry?.mcp_mode ?? entry?.mcpMode,
    ),
    capabilities: normalizeStringArray(
      entry?.capabilities,
    ),
    required_capabilities: normalizeStringArray(
      entry?.required_capabilities ?? entry?.requiredCapabilities,
    ),
    supports_root_mesh:
      entry?.supports_root_mesh === true
      || entry?.supportsRootMesh === true,
    last_health:
      normalizeOptionalText(entry?.last_health ?? entry?.lastHealth)
      || "unknown",
    last_health_checked_at: normalizeOptionalText(
      entry?.last_health_checked_at ?? entry?.lastHealthCheckedAt,
    ),
    failure_reason: normalizeOptionalText(
      entry?.failure_reason ?? entry?.failureReason,
    ),
    last_ready_at: normalizeOptionalText(
      entry?.last_ready_at ?? entry?.lastReadyAt,
    ),
  };
}

function normalizeRegistryDocument(document, currentHostId, {
  injectCurrentHost = true,
  strict = false,
  sourcePath = "registry",
} = {}) {
  const rawHosts = Array.isArray(document)
    ? document
    : Array.isArray(document?.hosts)
      ? document.hosts
      : [];
  const hostMap = new Map();
  for (const [index, rawHost] of rawHosts.entries()) {
    let host;
    try {
      host = normalizeHostEntry(rawHost, currentHostId);
    } catch (error) {
      if (strict) {
        throw new Error(
          `${sourcePath}: invalid host entry ${index + 1}: ${error.message}`,
          { cause: error },
        );
      }
      continue;
    }
    if (host.host_id) {
      if (strict && hostMap.has(host.host_id)) {
        throw new Error(`${sourcePath}: duplicate host id: ${host.host_id}`);
      }
      hostMap.set(host.host_id, host);
    } else if (strict) {
      throw new Error(`${sourcePath}: host entry ${index + 1} is missing id`);
    }
  }
  const hosts = [...hostMap.values()];

  if (strict && hosts.length === 0) {
    throw new Error(`${sourcePath}: expected at least one host`);
  }

  if (injectCurrentHost && !hosts.some((entry) => entry.host_id === currentHostId)) {
    hosts.unshift(
      normalizeHostEntry(
        { host_id: currentHostId },
        currentHostId,
        { fallbackToCurrentHost: true },
      ),
    );
  }

  return {
    schema_version: HOST_REGISTRY_SCHEMA_VERSION,
    hosts,
  };
}

function mergeMutableHostState(canonicalRegistry, fallbackRegistry) {
  if (!fallbackRegistry) {
    return canonicalRegistry;
  }

  const fallbackHosts = new Map(
    fallbackRegistry.hosts.map((host) => [host.host_id, host]),
  );

  return {
    ...canonicalRegistry,
    hosts: canonicalRegistry.hosts.map((host) => {
      const fallbackHost = fallbackHosts.get(host.host_id);
      if (!fallbackHost) {
        return host;
      }
      const merged = { ...host };
      for (const key of MUTABLE_HOST_STATE_KEYS) {
        if (fallbackHost[key]) {
          merged[key] = fallbackHost[key];
        }
      }
      return merged;
    }),
  };
}

function buildHostUnavailableResult({
  host,
  hostId,
  hostLabel,
  failureReason,
  isLocal = false,
}) {
  return {
    ok: false,
    reason: "host-unavailable",
    hostId,
    hostLabel,
    failureReason,
    lastReadyAt: host?.last_ready_at ?? null,
    isLocal,
    host: host || null,
  };
}

function buildHostReadyResult({
  host,
  hostId,
  hostLabel,
  isLocal = false,
}) {
  return {
    ok: true,
    reason: null,
    hostId,
    hostLabel,
    lastReadyAt: host?.last_ready_at ?? new Date().toISOString(),
    failureReason: null,
    isLocal,
    host: host || null,
  };
}

function resolveHostAvailability(hostId, host, currentHostId) {
  const normalizedHostId = normalizeHostId(hostId, currentHostId);
  const hostLabel = formatExecutionHostName(host?.label, normalizedHostId);
  const isLocal = normalizedHostId === currentHostId;

  if (!host) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: "host-unregistered",
      isLocal,
    });
  }

  if (host.enabled === false) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: host.failure_reason || "host-disabled",
      isLocal,
    });
  }

  if (host.failure_reason) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: host.failure_reason,
      isLocal,
    });
  }

  if (!isLocal && (host.last_health !== "ready" || !host.last_ready_at)) {
    return buildHostUnavailableResult({
      host,
      hostId: normalizedHostId,
      hostLabel,
      failureReason: host.failure_reason || "host-not-ready",
      isLocal,
    });
  }

  return buildHostReadyResult({
    host,
    hostId: normalizedHostId,
    hostLabel,
    isLocal,
  });
}

export class HostRegistryService {
  constructor({ registryPath, canonicalRegistryPath = null, currentHostId }) {
    this.registryPath = registryPath;
    this.canonicalRegistryPath = canonicalRegistryPath;
    this.currentHostId = normalizeHostId(currentHostId, "local");
  }

  async ensureRegistryExists() {
    await ensurePrivateDirectory(path.dirname(this.registryPath));
  }

  async withRegistryLock(callback) {
    const lockPath = `${this.registryPath}.lock`;
    const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
    await this.ensureRegistryExists();

    while (true) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        await writeTextAtomic(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({
            pid: process.pid,
            created_at: new Date().toISOString(),
          }, null, 2)}\n`,
        );
        try {
          return await callback();
        } finally {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }

        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > REGISTRY_LOCK_STALE_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for host registry lock: ${lockPath}`,
            { cause: error },
          );
        }
        await sleep(REGISTRY_LOCK_RETRY_MS);
      }
    }
  }

  async loadFallbackRegistry() {
    try {
      const text = await fs.readFile(this.registryPath, "utf8");
      return normalizeRegistryDocument(
        parseRegistryToml(text, this.registryPath),
        this.currentHostId,
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      const text = await fs.readFile(this.registryPath, "utf8").catch(() => "");
      if (text) {
        await quarantineMalformedRegistry(this.registryPath, text);
      }
      throw error;
    }
  }

  async loadCanonicalRegistry() {
    if (!this.canonicalRegistryPath) {
      return null;
    }

    const files = await listCanonicalHostFiles(this.canonicalRegistryPath);
    const hosts = [];
    for (const { filePath, shardOwner } of files) {
      const text = await fs.readFile(filePath, "utf8");
      const document = parseRegistryToml(text, filePath);
      for (const entry of document.hosts) {
        validateCanonicalHostEntry(entry, {
          registryPath: filePath,
          shardOwner,
        });
      }
      hosts.push(...document.hosts);
    }

    return normalizeRegistryDocument(
      {
        hosts,
      },
      this.currentHostId,
      {
        injectCurrentHost: false,
        strict: true,
        sourcePath: this.canonicalRegistryPath,
      },
    );
  }

  async saveRegistry(document, sync = {}) {
    await this.ensureRegistryExists();
    const normalized = normalizeRegistryDocument(
      {
        ...document,
        schema_version: HOST_REGISTRY_SCHEMA_VERSION,
      },
      this.currentHostId,
    );
    await writeRegistryState(this.registryPath, normalized, sync);
    return normalized;
  }

  async syncFromCanonical(options = {}) {
    return this.withRegistryLock(() => this.syncFromCanonicalUnlocked(options));
  }

  async syncFromCanonicalUnlocked({ allowStaleFallback = true } = {}) {
    await this.ensureRegistryExists();

    const fallbackRegistry = await this.loadFallbackRegistry().catch(() => null);
    if (!this.canonicalRegistryPath) {
      if (fallbackRegistry) {
        return fallbackRegistry;
      }
      return this.saveRegistry(buildDefaultRegistry(this.currentHostId), {
        status: "default",
        error: "canonical registry path not configured",
      });
    }

    let canonicalRegistry;
    try {
      canonicalRegistry = await this.loadCanonicalRegistry();
    } catch (error) {
      if (fallbackRegistry && allowStaleFallback) {
        return fallbackRegistry;
      }
      throw error;
    }

    const merged = mergeMutableHostState(canonicalRegistry, fallbackRegistry);
    return this.saveRegistry(merged, {
      status: "ok",
      ...await sourceMetadata(this.canonicalRegistryPath),
    });
  }

  async loadRegistry(options = {}) {
    return this.syncFromCanonical(options);
  }

  async listHosts(options = {}) {
    const registry = await this.loadRegistry(options);
    return registry.hosts;
  }

  async replaceHosts(hosts) {
    return this.withRegistryLock(async () => {
      const registry = await this.syncFromCanonicalUnlocked();
      const nextRegistry = {
        ...registry,
        hosts,
      };
      const saved = await this.saveRegistry(nextRegistry, {
        status: "local-write",
        source_path: this.canonicalRegistryPath || "",
      });
      return saved.hosts;
    });
  }

  async upsertHost(entry) {
    const incomingHostId = normalizeHostId(
      entry?.host_id ?? entry?.hostId ?? entry?.id,
      null,
    );
    if (!incomingHostId) {
      throw new Error("Cannot upsert a host entry without host_id");
    }

    return this.withRegistryLock(() => this.upsertHostUnlocked({
      ...entry,
      host_id: incomingHostId,
    }));
  }

  async upsertHostUnlocked(entry) {
    const incomingHostId = normalizeHostId(
      entry?.host_id ?? entry?.hostId ?? entry?.id,
      null,
    );
    if (!incomingHostId) {
      throw new Error("Cannot upsert a host entry without host_id");
    }

    const registry = await this.syncFromCanonicalUnlocked();
    const hosts = [...registry.hosts];
    const index = hosts.findIndex((host) => host.host_id === incomingHostId);
    const merged =
      index >= 0
        ? {
            ...hosts[index],
            ...entry,
            host_id: incomingHostId,
          }
        : {
            ...entry,
            host_id: incomingHostId,
          };

    if (index >= 0) {
      hosts[index] = merged;
    } else {
      hosts.push(merged);
    }

    const saved = await this.saveRegistry(
      {
        ...registry,
        hosts,
      },
      {
        status: "local-write",
        source_path: this.canonicalRegistryPath || "",
      },
    );
    return saved.hosts.find((host) => host.host_id === incomingHostId) || null;
  }

  async patchHost(hostId, patch) {
    const normalizedHostId = normalizeHostId(hostId, null);
    if (!normalizedHostId) {
      throw new Error("Cannot patch a host without host_id");
    }

    return this.withRegistryLock(async () => {
      const registry = await this.syncFromCanonicalUnlocked();
      const existing = registry.hosts.find(
        (host) => host.host_id === normalizedHostId,
      );
      return this.upsertHostUnlocked({
        ...(existing || {}),
        ...patch,
        host_id: normalizedHostId,
      });
    });
  }

  async getHost(hostId) {
    const normalizedHostId = normalizeHostId(hostId, this.currentHostId);
    const hosts = await this.listHosts();
    return hosts.find((entry) => entry.host_id === normalizedHostId) || null;
  }

  async listTopicCreationHosts() {
    const hosts = await this.listHosts();
    return hosts.map((host) =>
      resolveHostAvailability(host.host_id, host, this.currentHostId)
    );
  }

  async resolveTopicCreationHost(requestedHostId = null) {
    const hostId = normalizeHostId(requestedHostId, this.currentHostId);
    const host = await this.getHost(hostId);
    return resolveHostAvailability(hostId, host, this.currentHostId);
  }

  async resolveSessionExecution(session) {
    const hostId = normalizeHostId(session?.execution_host_id, this.currentHostId);
    const host = await this.getHost(hostId);
    return resolveHostAvailability(hostId, host, this.currentHostId);
  }
}

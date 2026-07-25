import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import { HostRegistryService } from "../src/hosts/host-registry-service.js";

async function makeRegistryPaths() {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-hosts-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry-state.toml");
  const canonicalRegistryPath = path.join(stateRoot, "fleet", "hosts.toml");
  const canonicalShardsPath = path.join(stateRoot, "fleet", "shards");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.mkdir(path.dirname(canonicalRegistryPath), { recursive: true });
  return {
    stateRoot,
    registryPath,
    canonicalRegistryPath,
    canonicalShardsPath,
  };
}

async function writeCanonical(canonicalRegistryPath, body) {
  await fs.writeFile(canonicalRegistryPath, body.trimStart(), "utf8");
}

async function writeCanonicalShard(canonicalShardsPath, hostId, body) {
  const shardPath = path.join(canonicalShardsPath, hostId, "hosts.toml");
  await fs.mkdir(path.dirname(shardPath), { recursive: true });
  await fs.writeFile(shardPath, body.trimStart(), "utf8");
}

test("HostRegistryService creates a flat TOML fallback for the current host", async () => {
  const { registryPath } = await makeRegistryPaths();
  const service = new HostRegistryService({
    registryPath,
    currentHostId: "local",
  });

  const hosts = await service.listHosts();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host_id, "local");
  assert.equal(hosts[0].enabled, true);

  const stored = parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(stored.sync.status, "default");
  assert.equal(stored.hosts[0].host_id, "local");
});

test("HostRegistryService loads valid canonical hosts.toml and writes registry-state.toml", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, `
[[hosts]]
id = "local"
label = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true

[[hosts]]
id = "workera"
label = "workera"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.215"
host_user = "workera"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workera"
repo_root = "/path/to/worker-workspace/apps/teledex"
worker_runtime_root = "/path/to/worker-workspace-state/apps/teledex"
codex_bin_path = "codex"
enabled = true
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });
  await service.patchHost("workera", {
    last_health: "ready",
    last_ready_at: "2026-04-21T18:00:00.000Z",
  });

  const resolved = await service.resolveSessionExecution({
    execution_host_id: "workera",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.hostId, "workera");
  assert.equal(resolved.host.repo_root, "/path/to/worker-workspace/apps/teledex");

  const stored = parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(stored.sync.status, "ok");
  assert.equal(stored.sync.source_path, canonicalRegistryPath);
  assert.deepEqual(stored.hosts.map((host) => host.host_id), ["local", "workera"]);
});

test("HostRegistryService rejects single-file canonical hosts with mutable state", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true
last_health = "ready"
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });

  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /mutable host state belongs in runtime fallback only: last_health/u,
  );
});

test("HostRegistryService rejects single-file canonical hosts missing required keys", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
ssh_target = "local"
enabled = true
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });

  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /`state_root` must be a non-empty string/u,
  );
});

test("HostRegistryService reads fleet shards instead of stale aggregate hosts.toml", async () => {
  const { registryPath, canonicalRegistryPath, canonicalShardsPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true
`);
  await writeCanonicalShard(canonicalShardsPath, "local", `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true
`);
  await writeCanonicalShard(canonicalShardsPath, "workerz", `
[[hosts]]
id = "workerz"
role = "personal"
availability = "offline_ok"
lan_ipv4 = "192.168.1.182"
host_user = "workerz"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workerz"
enabled = true
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath: path.dirname(canonicalRegistryPath),
    currentHostId: "local",
  });

  const hosts = await service.listHosts();
  assert.deepEqual(hosts.map((host) => host.host_id), ["local", "workerz"]);

  const stored = parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(stored.sync.source_path, path.dirname(canonicalRegistryPath));
  assert.deepEqual(stored.hosts.map((host) => host.host_id), ["local", "workerz"]);
});

test("HostRegistryService rejects malformed fleet shards without overwriting fallback", async () => {
  const { registryPath, canonicalShardsPath } = await makeRegistryPaths();
  const fallbackText = `
[sync]
schema_version = 2
updated_at = "2026-04-21T18:00:00.000Z"
status = "ok"
source_path = "${canonicalShardsPath}"
source_mtime_ms = 1
source_sha256 = "abc"
error = ""

[[hosts]]
host_id = "local"
label = "local"
ssh_target = "local"
enabled = true
last_health = "ready"
last_ready_at = "2026-04-21T18:00:00.000Z"
`;
  await fs.writeFile(registryPath, fallbackText.trimStart(), "utf8");
  await writeCanonicalShard(canonicalShardsPath, "workera", `
[[hosts]]
label = "workera"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.215"
host_user = "workera"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workera"
enabled = true
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath: canonicalShardsPath,
    currentHostId: "local",
  });

  const hosts = await service.listHosts();
  assert.deepEqual(hosts.map((host) => host.host_id), ["local"]);
  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /`id` must be a non-empty string/u,
  );
  assert.equal(await fs.readFile(registryPath, "utf8"), fallbackText.trimStart());
});

test("HostRegistryService rejects shard owner mismatches", async () => {
  const { registryPath, canonicalShardsPath } = await makeRegistryPaths();
  await writeCanonicalShard(canonicalShardsPath, "workera", `
[[hosts]]
id = "local"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.215"
host_user = "workera"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workera"
enabled = true
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath: canonicalShardsPath,
    currentHostId: "local",
  });

  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /does not match shard owner `workera`/u,
  );
});

test("HostRegistryService rejects duplicate host ids in canonical shards", async () => {
  const { registryPath, canonicalShardsPath } = await makeRegistryPaths();
  await writeCanonicalShard(canonicalShardsPath, "local", `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true

[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath: canonicalShardsPath,
    currentHostId: "local",
  });

  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /duplicate host id: local/u,
  );
});

test("HostRegistryService rejects mutable runtime state in canonical shards", async () => {
  const { registryPath, canonicalShardsPath } = await makeRegistryPaths();
  await writeCanonicalShard(canonicalShardsPath, "local", `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"
enabled = true
last_health = "ready"
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath: canonicalShardsPath,
    currentHostId: "local",
  });

  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /mutable host state belongs in runtime fallback only: last_health/u,
  );
});

test("HostRegistryService preserves fallback when canonical hosts.toml is invalid", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  const fallbackText = `
[sync]
schema_version = 2
updated_at = "2026-04-21T18:00:00.000Z"
status = "ok"
source_path = "${canonicalRegistryPath}"
source_mtime_ms = 1
source_sha256 = "abc"
error = ""

[[hosts]]
host_id = "local"
label = "local"
ssh_target = "local"
enabled = true
role = "infrastructure"
workspace_root = "/path/to/worker-workspace"
repo_root = "/path/to/worker-workspace/apps/teledex"
default_binding_path = "/path/to/worker-workspace"
worker_runtime_root = "/path/to/worker-workspace-state/apps/teledex"
codex_bin_path = "codex"
codex_config_path = "~/.codex/config.toml"
codex_auth_path = "~/.codex/auth.json"
profile_id = "workspace-controller"
suffix_id = "local"
mcp_mode = "local"
required_capabilities = ["codex"]
supports_root_mesh = true
last_health = "ready"
last_health_checked_at = "2026-04-21T18:00:00.000Z"
failure_reason = ""
last_ready_at = "2026-04-21T18:00:00.000Z"
`;
  await fs.writeFile(registryPath, fallbackText.trimStart(), "utf8");
  await writeCanonical(canonicalRegistryPath, "[[registry.hosts]]\nid = \"bad\"\n");
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });

  const hosts = await service.listHosts();
  assert.deepEqual(hosts.map((host) => host.host_id), ["local"]);
  await assert.rejects(
    service.syncFromCanonical({ allowStaleFallback: false }),
    /nested registry/u,
  );
  assert.equal(await fs.readFile(registryPath, "utf8"), fallbackText.trimStart());
});

test("HostRegistryService rejects nested registry and raw_toml when no fallback exists", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, "[[registry.hosts]]\nid = \"local\"\n");
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });
  await assert.rejects(service.listHosts(), /nested registry/u);

  await fs.rm(registryPath, { force: true });
  await writeCanonical(canonicalRegistryPath, "raw_toml = \"bad\"\n[[hosts]]\nid = \"local\"\n");
  await assert.rejects(service.listHosts(), /raw_toml/u);
});

test("HostRegistryService keeps mutable health from fallback when canonical refreshes", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"

[[hosts]]
id = "workera"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.215"
host_user = "workera"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workera"
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });
  await service.patchHost("workera", {
    last_health: "ready",
    last_health_checked_at: "2026-04-21T18:00:00.000Z",
    last_ready_at: "2026-04-21T18:00:00.000Z",
  });

  const workera = await service.getHost("workera");
  assert.equal(workera.last_health, "ready");
  assert.equal(workera.last_ready_at, "2026-04-21T18:00:00.000Z");
});

test("HostRegistryService serializes concurrent mutable host updates", async () => {
  const { registryPath, canonicalRegistryPath } = await makeRegistryPaths();
  await writeCanonical(canonicalRegistryPath, `
[[hosts]]
id = "local"
role = "infrastructure"
availability = "always_on"
lan_ipv4 = "192.168.1.50"
host_user = "local"
host_root = "/path/to/workspace"
state_root = "/path/to/teledex-state"
ssh_target = "local"

[[hosts]]
id = "workera"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.215"
host_user = "workera"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workera"

[[hosts]]
id = "workerb"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.216"
host_user = "workerb"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workerb"

[[hosts]]
id = "workerc"
role = "worker"
availability = "always_on"
lan_ipv4 = "192.168.1.217"
host_user = "workerc"
host_root = "/path/to/worker-workspace"
state_root = "/path/to/worker-workspace-state"
ssh_target = "workerc"
`);
  const service = new HostRegistryService({
    registryPath,
    canonicalRegistryPath,
    currentHostId: "local",
  });

  await Promise.all([
    service.patchHost("workera", {
      last_health: "ready",
      last_health_checked_at: "2026-04-21T18:00:01.000Z",
      last_ready_at: "2026-04-21T18:00:01.000Z",
    }),
    service.patchHost("workerb", {
      last_health: "ready",
      last_health_checked_at: "2026-04-21T18:00:02.000Z",
      last_ready_at: "2026-04-21T18:00:02.000Z",
    }),
    service.patchHost("workerc", {
      last_health: "ready",
      last_health_checked_at: "2026-04-21T18:00:03.000Z",
      last_ready_at: "2026-04-21T18:00:03.000Z",
    }),
  ]);

  const hosts = await service.listHosts({ allowStaleFallback: false });
  const byId = new Map(hosts.map((host) => [host.host_id, host]));
  assert.equal(byId.get("workera").last_health, "ready");
  assert.equal(byId.get("workera").last_ready_at, "2026-04-21T18:00:01.000Z");
  assert.equal(byId.get("workerb").last_health, "ready");
  assert.equal(byId.get("workerb").last_ready_at, "2026-04-21T18:00:02.000Z");
  assert.equal(byId.get("workerc").last_health, "ready");
  assert.equal(byId.get("workerc").last_ready_at, "2026-04-21T18:00:03.000Z");
});

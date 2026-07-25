import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadVisibleCodexModelsForSession,
  resolveCodexCatalogPathsForSession,
} from "../src/session-manager/codex-runtime-host.js";
import { BUILTIN_CODEX_MODELS } from "../src/session-manager/codex-runtime-settings.js";

async function makeRegistryLayout() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-host-"));
  const registryPath = path.join(stateRoot, "hosts", "registry-state.toml");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  return {
    stateRoot,
    registryPath,
    mirrorPath: path.join(
      stateRoot,
      "teledex-context",
      "hosts",
      "workera",
      "rendered",
      "models_cache.json",
    ),
  };
}

test("resolveCodexCatalogPathsForSession uses the host mirror for remote model catalogs", async () => {
  const { registryPath, mirrorPath } = await makeRegistryLayout();
  const paths = await resolveCodexCatalogPathsForSession({
    session: {
      execution_host_id: "workera",
    },
    defaultConfigPath: "/home/example/.codex/config.toml",
    hostRegistryService: {
      currentHostId: "local",
      registryPath,
      async getHost(hostId) {
        assert.equal(hostId, "workera");
        return {
          host_id: "workera",
          codex_config_path: "/home/workera/.codex/config.toml",
        };
      },
    },
  });

  assert.equal(paths.configPath, "/home/example/.codex/config.toml");
  assert.equal(paths.modelsCachePath, mirrorPath);
  assert.equal(paths.modelsCachePath.includes("/home/workera/"), false);
});

test("loadVisibleCodexModelsForSession falls back to builtins when a remote mirror is missing", async () => {
  const { registryPath } = await makeRegistryLayout();
  const models = await loadVisibleCodexModelsForSession({
    session: {
      execution_host_id: "workera",
    },
    defaultConfigPath: "/home/example/.codex/config.toml",
    hostRegistryService: {
      currentHostId: "local",
      registryPath,
      async getHost() {
        return {
          host_id: "workera",
          codex_config_path: "/home/workera/.codex/config.toml",
        };
      },
    },
  });

  assert.deepEqual(models, BUILTIN_CODEX_MODELS);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { HostRegistryService } from "../src/hosts/host-registry-service.js";
import { runHostSync } from "../src/hosts/host-sync.js";
import { mkdtempForTest } from "../test-support/tmp.js";

test("runHostSync rejects non-local controllers", async (t) => {
  const stateRoot = await mkdtempForTest(t, "teledex-host-sync-");
  const registryService = new HostRegistryService({
    registryPath: path.join(stateRoot, "hosts", "registry-state.toml"),
    currentHostId: "workera",
  });

  await assert.rejects(
    runHostSync({
      codexSpaceRoot: path.join(stateRoot, "teledex-context"),
      connectTimeoutSecs: 5,
      currentHostId: "workera",
      hostsRoot: path.join(stateRoot, "hosts"),
      registryService,
    }),
    /only supported from local/u,
  );
});

test("runHostSync renders and syncs host outputs over ssh and rsync", async (t) => {
  const stateRoot = await mkdtempForTest(t, "teledex-host-sync-");
  const registryService = new HostRegistryService({
    registryPath: path.join(stateRoot, "hosts", "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({
      command,
      args,
    });
    if (
      command === "ssh"
      && Array.isArray(args)
      && String(args.at(-1) || "").includes("models_cache.json")
    ) {
      callback(
        null,
        `${JSON.stringify({
          models: [
            {
              slug: "gpt-5.5",
              display_name: "GPT-5.5",
              visibility: "list",
              priority: 0,
            },
          ],
        }, null, 2)}\n`,
        "",
      );
      return;
    }
    if (
      command === "ssh"
      && Array.isArray(args)
      && String(args.at(-1) || "").includes("/path/to/worker-workspace")
      && !String(args.at(-1) || "").includes("mkdir -p")
    ) {
      callback(null, "/path/to/worker-workspace\n", "");
      return;
    }
    if (
      command === "ssh"
      && Array.isArray(args)
      && String(args.at(-1) || "").includes("mkdir -p")
    ) {
      const script = String(args.at(-1) || "");
      callback(
        null,
        script.includes("shared/rendered")
          ? "/path/to/worker-workspace-state/apps/teledex/teledex-context/shared/rendered\n"
          : "/path/to/worker-workspace-state/apps/teledex/teledex-context/hosts/workera/rendered\n",
        "",
      );
      return;
    }

    callback(null, "", "");
  };

  const results = await runHostSync({
    registryMirrorRoot: path.join(stateRoot, "project-scout", "mounts"),
    codexSpaceRoot: path.join(stateRoot, "teledex-context"),
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl,
    hostsRoot: path.join(stateRoot, "hosts"),
    registryService,
    targetHostId: "workera",
  });

  assert.deepEqual(results, [
    {
      host_id: "workera",
      status: "synced",
      reason: null,
    },
  ]);
  assert.equal(
    calls.some((call) => call.command === "ssh"),
    true,
  );
  assert.equal(
    calls.some((call) => call.command === "rsync"),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.command === "rsync"
      && call.args.includes("--include=project.toml")
      && call.args.some((arg) => String(arg).includes("workera:/path/to/worker-workspace/"))
      && call.args.some((arg) => String(arg).includes("/project-scout/mounts/workera/"))),
    true,
  );
  assert.equal(
    calls.some((call) =>
      call.command === "rsync"
      && call.args.includes("-s")
      && call.args.includes("-e")
      && call.args.includes("'ssh' '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=5' '-o' 'ServerAliveInterval=30' '-o' 'ServerAliveCountMax=6'")),
    true,
  );
  assert.equal(
    calls
      .filter((call) => call.command === "rsync")
      .every((call) => !call.args.some((arg) => String(arg).includes("/~/"))),
    true,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(
          stateRoot,
          "teledex-context",
          "hosts",
          "workera",
          "rendered",
          "models_cache.json",
        ),
        "utf8",
      ),
    ).models.map((entry) => entry.slug),
    ["gpt-5.5"],
  );
});

test("runHostSync fails closed when configured workspace skills root is missing", async (t) => {
  const stateRoot = await mkdtempForTest(t, "teledex-host-sync-");
  const registryService = new HostRegistryService({
    registryPath: path.join(stateRoot, "hosts", "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });

  await assert.rejects(
    runHostSync({
      workspaceSkillsRoot: path.join(stateRoot, "workspace", ".teledex", "workflow-skills"),
      codexSpaceRoot: path.join(stateRoot, "teledex-context"),
      connectTimeoutSecs: 5,
      currentHostId: "local",
      execFileImpl: () => {
        throw new Error("sync should fail before host commands");
      },
      hostsRoot: path.join(stateRoot, "hosts"),
      registryService,
      targetHostId: "workera",
    }),
    /workspace skills root does not exist/u,
  );
});

test("runHostSync syncs repo-local workspace skills into worker workspace", async (t) => {
  const stateRoot = await mkdtempForTest(t, "teledex-host-sync-");
  const workspaceSkillsRoot = path.join(stateRoot, "workspace", ".teledex", "workflow-skills");
  await fs.mkdir(path.join(workspaceSkillsRoot, "workspace-lookup"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceSkillsRoot, "workspace-lookup", "SKILL.md"),
    "---\nname: workspace-lookup\ndescription: workspace lookup\n---\n",
  );

  const registryService = new HostRegistryService({
    registryPath: path.join(stateRoot, "hosts", "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });

  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({
      command,
      args,
    });
    if (
      command === "ssh"
      && Array.isArray(args)
      && String(args.at(-1) || "").includes("models_cache.json")
    ) {
      callback(null, '{"models":[]}\n', "");
      return;
    }
    if (
      command === "ssh"
      && Array.isArray(args)
      && String(args.at(-1) || "").includes("mkdir -p")
    ) {
      const script = String(args.at(-1) || "");
      if (script.includes(".teledex/workflow-skills")) {
        callback(null, "/path/to/worker-workspace/.teledex/workflow-skills\n", "");
        return;
      }
      callback(
        null,
        script.includes("shared/rendered")
          ? "/path/to/worker-workspace-state/apps/teledex/teledex-context/shared/rendered\n"
          : "/path/to/worker-workspace-state/apps/teledex/teledex-context/hosts/workera/rendered\n",
        "",
      );
      return;
    }

    callback(null, "", "");
  };

  const results = await runHostSync({
    workspaceSkillsRoot,
    codexSpaceRoot: path.join(stateRoot, "teledex-context"),
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl,
    hostsRoot: path.join(stateRoot, "hosts"),
    registryService,
    targetHostId: "workera",
  });

  assert.deepEqual(results, [
    {
      host_id: "workera",
      status: "synced",
      reason: null,
    },
  ]);
  assert.equal(
    calls.some((call) =>
      call.command === "rsync"
      && call.args.some((arg) => String(arg).includes("/.teledex/workflow-skills/"))),
    true,
  );
});

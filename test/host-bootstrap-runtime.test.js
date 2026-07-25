import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runHostBootstrapRuntime } from "../src/hosts/host-bootstrap-runtime.js";
import { HostRegistryService } from "../src/hosts/host-registry-service.js";
import {
  RTK_CODEX_PLUGIN_CONFIG_KEY,
  RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH,
} from "../src/runtime/rtk-codex-plugin.js";
import {
  PITLANE_CODEX_PLUGIN_CONFIG_KEY,
  PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH,
} from "../src/runtime/pitlane-codex-plugin.js";

function resolveRsyncLocalPathForTest(filePath) {
  if (process.platform !== "win32") {
    return filePath;
  }

  const drivePath = String(filePath || "").match(/^\/([a-z])(?:\/(.*))?$/iu);
  if (!drivePath) {
    return String(filePath || "").replace(/\//gu, "\\");
  }

  const [, drive, rest = ""] = drivePath;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//gu, "\\")}`;
}

function createExecFileRecorder() {
  const calls = [];
  let capturedConfigText = null;
  let capturedAgentsText = null;
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args });
    if (command === "npm") {
      callback(null, JSON.stringify({
        dependencies: {
          "@openai/codex": { version: "0.121.0" },
        },
      }), "");
      return;
    }
    if (command === "ssh") {
      const script = Array.isArray(args) ? args.at(-1) : "";
      if (script.includes('cache_path="$(dirname "$config_path")/models_cache.json"')) {
        callback(null, '{"models":[{"slug":"gpt-5.5","visibility":"list"}]}\n', "");
        return;
      }
      if (script.includes("pitlane-mcp-linux-${asset_arch}.tar.gz")) {
        callback(null, "status=installed\npath=/usr/local/bin/pitlane\nversion=pitlane 0.10.2\n", "");
        return;
      }
      if (script.includes("sudo -n install -m 0755")) {
        callback(null, "status=installed\npath=/usr/local/bin/codex\n", "");
        return;
      }
      if (script.includes("for name in") && script.includes("mcp-docker")) {
        callback(null, "mcp-docker\nmcp-requests\n", "");
        return;
      }
      if (script.includes("node_path=")) {
        callback(
          null,
          [
            "home_path=/home/workera",
            "node_path=/usr/bin/node",
            "node_version=v18.19.1",
            "npm_path=/usr/bin/npm",
            "npm_version=9.2.0",
            "codex_path=/usr/local/bin/codex",
            "configured_codex_present=1",
            "configured_codex_path=/path/to/worker-workspace-state/external/forks/codex/bin/codex",
            "docker_path=/usr/bin/docker",
            "rtk_path=/usr/local/bin/rtk",
            "rtk_version=rtk 0.38.0",
            "pitlane_path=/usr/local/bin/pitlane",
            "pitlane_version=pitlane 0.10.2",
            "workspace_root_exists=1",
            "repo_root_exists=1",
            "runtime_root_exists=1",
            "config_present=1",
            "auth_present=1",
          ].join("\n"),
          "",
        );
        return;
      }
      if (script.includes('printf "%s\\n" "$target"')) {
        if (script.includes("~/.codex/models_cache.json")) {
          callback(null, "/home/workera/.codex/models_cache.json\n", "");
          return;
        }
        if (script.includes("~/.codex/config.toml")) {
          callback(null, "/home/workera/.codex/config.toml\n", "");
          return;
        }
        if (script.includes("~/.codex/WORKSPACE_GUIDE.md")) {
          callback(null, "/home/workera/.codex/WORKSPACE_GUIDE.md\n", "");
          return;
        }
        if (script.includes("~/.codex/auth.json")) {
          callback(null, "/home/workera/.codex/auth.json\n", "");
          return;
        }
        if (script.includes(`~/.codex/${RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH}`)) {
          callback(
            null,
            `/home/workera/.codex/${RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH}\n`,
            "",
          );
          return;
        }
        if (script.includes(`~/.codex/${PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH}`)) {
          callback(
            null,
            `/home/workera/.codex/${PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH}\n`,
            "",
          );
          return;
        }
        if (script.includes("/path/to/worker-workspace-state/external/forks/codex/bin/codex")) {
          callback(null, "/path/to/worker-workspace-state/external/forks/codex/bin/codex\n", "");
          return;
        }
        if (script.includes("/path/to/worker-workspace/tools/mcp-gateway")) {
          callback(null, "/path/to/worker-workspace/tools/mcp-gateway\n", "");
          return;
        }
        if (script.includes("/path/to/worker-workspace/apps/teledex")) {
          callback(null, "/path/to/worker-workspace/apps/teledex\n", "");
          return;
        }
        if (script.includes("/path/to/worker-workspace/tools/docker-socket-proxy")) {
          callback(null, "/path/to/worker-workspace/tools/docker-socket-proxy\n", "");
          return;
        }
        if (script.includes("~/.codex")) {
          callback(null, "/home/workera/.codex\n", "");
          return;
        }
      }
      callback(null, "", "");
      return;
    }
    if (command === "rsync") {
      const destination = Array.isArray(args) ? args.at(-1) : "";
      if (destination === "workera:/home/workera/.codex/config.toml") {
        const localPath = args.at(-2);
        capturedConfigText = fsSync.readFileSync(
          resolveRsyncLocalPathForTest(localPath),
          "utf8",
        );
      }
      if (destination === "workera:/home/workera/.codex/WORKSPACE_GUIDE.md") {
        const localPath = args.at(-2);
        capturedAgentsText = fsSync.readFileSync(
          resolveRsyncLocalPathForTest(localPath),
          "utf8",
        );
      }
      callback(null, "", "");
      return;
    }

    callback(null, "", "");
  };

  return {
    calls,
    getCapturedConfigText() {
      return capturedConfigText;
    },
    getCapturedAgentsText() {
      return capturedAgentsText;
    },
    execFileImpl,
  };
}

test("runHostBootstrapRuntime mirrors the usable Codex profile subset and optional custom binary", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-host-bootstrap-runtime-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "local",
    label: "local",
    ssh_target: "local",
    enabled: true,
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    capabilities: ["mcp-requests"],
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    capabilities: ["mcp-requests"],
  });

  const localHomeRoot = path.join(stateRoot, "home", "local");
  const sourceWorkspaceRoot = path.join(localHomeRoot, "workspace");
  const codexRoot = path.join(localHomeRoot, ".codex");
  const rtkPluginPath = path.join(stateRoot, "fixtures", "rtk-codex-plugin");
  const pitlanePluginPath = path.join(stateRoot, "fixtures", "pitlane-codex-plugin");
  await fs.mkdir(
    path.join(sourceWorkspaceRoot, "apps", "teledex"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(sourceWorkspaceRoot, "tools", "mcp-gateway"),
    { recursive: true },
  );
  await fs.mkdir(
    path.join(sourceWorkspaceRoot, "tools", "docker-socket-proxy"),
    { recursive: true },
  );
  await fs.mkdir(path.join(rtkPluginPath, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(rtkPluginPath, "hooks"), { recursive: true });
  await fs.writeFile(
    path.join(rtkPluginPath, ".codex-plugin", "plugin.json"),
    '{"name":"rtk-codex-plugin"}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(rtkPluginPath, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "^(Bash|exec_command|functions\\.exec_command)$",
          hooks: [{
            type: "command",
            command: "${PLUGIN_ROOT}/hooks/rtk-codex-hook",
            timeout: 5,
            statusMessage: "RTK command rewrite",
          }],
        }],
        PostToolUse: [{
          matcher: "^Bash$",
          hooks: [{
            type: "command",
            command: "${PLUGIN_ROOT}/hooks/rtk-output-post-hook",
            timeout: 8,
            statusMessage: "RTK output budget guard",
          }],
        }],
      },
    }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(rtkPluginPath, "hooks", "rtk-codex-hook"),
    "#!/bin/sh\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await fs.writeFile(
    path.join(rtkPluginPath, "hooks", "rtk-output-guard"),
    "#!/usr/bin/env python3\nraise SystemExit(0)\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await fs.writeFile(
    path.join(rtkPluginPath, "hooks", "rtk-output-post-hook"),
    "#!/usr/bin/env python3\nraise SystemExit(0)\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await fs.mkdir(path.join(pitlanePluginPath, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(pitlanePluginPath, "hooks"), { recursive: true });
  await fs.writeFile(
    path.join(pitlanePluginPath, ".codex-plugin", "plugin.json"),
    '{"name":"pitlane-codex-plugin"}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(pitlanePluginPath, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "^(Bash|exec_command|functions\\.exec_command)$",
          hooks: [{
            type: "command",
            command: "${PLUGIN_ROOT}/hooks/pitlane-codex-hook",
            timeout: 5,
            statusMessage: "Pitlane code navigation rewrite",
          }],
        }],
      },
    }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(pitlanePluginPath, "hooks", "pitlane-codex-hook"),
    "#!/usr/bin/env python3\nraise SystemExit(0)\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await fs.mkdir(path.join(codexRoot, "skills", "vercel-deploy"), { recursive: true });
  await fs.mkdir(path.join(codexRoot, "sessions"), { recursive: true });
  const configPath = path.join(codexRoot, "config.toml");
  const authPath = path.join(codexRoot, "auth.json");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.4"',
      '',
      `[projects."${sourceWorkspaceRoot}"]`,
      'trust_level = "trusted"',
      '',
      '[[skills.config]]',
      `path = "${path.join(codexRoot, "skills", "vercel-deploy", "SKILL.md")}"`,
      'enabled = true',
      '',
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(authPath, '{"token":"secret"}\n', "utf8");
  await fs.writeFile(
    path.join(codexRoot, "WORKSPACE_GUIDE.md"),
    `@${path.join(codexRoot, "RTK.md")}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(codexRoot, "RTK.md"),
    "# RTK\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(codexRoot, "models_cache.json"),
    '{"models":[{"slug":"gpt-5.5","visibility":"list"}]}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(codexRoot, "skills", "vercel-deploy", "SKILL.md"),
    "# skill\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(codexRoot, "sessions", "skip-me.json"),
    "{}\n",
    "utf8",
  );
  const customBinPath = path.join(
    localHomeRoot,
    "teledex-state",
    "external",
    "forks",
    "codex",
    "bin",
    "codex",
  );
  await fs.mkdir(path.dirname(customBinPath), { recursive: true });
  await fs.writeFile(customBinPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  const recorder = createExecFileRecorder();

  const result = await runHostBootstrapRuntime({
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: recorder.execFileImpl,
    hostsRoot,
    registryService,
    mcpPreset: "workspace",
    rtkPluginMode: "github",
    rtkPluginPath,
    pitlanePluginMode: "github",
    pitlanePluginPath,
    sourceBinPath: customBinPath,
    sourceCodexRoot: codexRoot,
    sourceAuthPath: authPath,
    sourceConfigPath: configPath,
    sourceStateRoot: path.join(localHomeRoot, "teledex-state"),
    sourceWorkspaceRoot,
    targetHostId: "workera",
  });

  assert.equal(result.host_id, "workera");
  assert.equal(result.codex_npm_spec, "@openai/codex@0.121.0");
  assert.equal(
    result.probe.codex_path,
    "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
  );
  assert.equal(result.remote_bin_path, "/path/to/worker-workspace-state/external/forks/codex/bin/codex");
  assert.equal(result.path_codex_install.status, "installed");
  assert.equal(result.path_codex_install.path, "/usr/local/bin/codex");
  assert.equal(result.pitlane_cli.status, "installed");
  assert.equal(result.pitlane_cli.path, "/usr/local/bin/pitlane");
  assert.equal(result.pitlane_cli.version, "pitlane 0.10.2");
  assert.equal(result.models_cache_sync.status, "copied");
  assert.equal(result.agents_sync.status, "copied-normalized");
  assert.equal(result.agents_sync.path, "/home/workera/.codex/WORKSPACE_GUIDE.md");
  assert.equal(result.models_cache_snapshot.status, "captured");
  assert.deepEqual(result.operator_toolbelt.missing, []);
  assert.equal(result.operator_toolbelt.commands.includes("jq"), true);
  assert.equal(result.operator_toolbelt.commands.includes("gh"), true);
  assert.equal(result.rtk_codex_plugin.status, "synced");
  assert.equal(result.rtk_codex_plugin.config_key, RTK_CODEX_PLUGIN_CONFIG_KEY);
  assert.equal(result.rtk_codex_plugin.rtk_path, "/usr/local/bin/rtk");
  assert.equal(result.rtk_codex_plugin.rtk_version, "rtk 0.38.0");
  assert.equal(result.probe.pitlane_path, "/usr/local/bin/pitlane");
  assert.equal(result.probe.pitlane_version, "pitlane 0.10.2");
  assert.equal(result.pitlane_codex_plugin.status, "synced");
  assert.equal(result.pitlane_codex_plugin.config_key, PITLANE_CODEX_PLUGIN_CONFIG_KEY);
  assert.match(recorder.getCapturedConfigText(), /^\[features\]$/mu);
  assert.match(recorder.getCapturedConfigText(), /^plugins = true$/mu);
  assert.match(recorder.getCapturedConfigText(), /^plugin_hooks = true$/mu);
  assert.match(
    recorder.getCapturedConfigText(),
    new RegExp(`^\\[plugins\\."${RTK_CODEX_PLUGIN_CONFIG_KEY}"\\]\\nenabled = true$`, "mu"),
  );
  assert.match(
    recorder.getCapturedConfigText(),
    new RegExp(`^\\[plugins\\."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"\\]\\nenabled = true$`, "mu"),
  );
  assert.match(
    recorder.getCapturedConfigText(),
    /^\[hooks\.state\."rtk-codex-plugin@community-local:hooks\/hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"$/mu,
  );
  assert.match(
    recorder.getCapturedConfigText(),
    /^\[hooks\.state\."rtk-codex-plugin@community-local:hooks\/hooks\.json:post_tool_use:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"$/mu,
  );
  assert.match(
    recorder.getCapturedConfigText(),
    /^\[hooks\.state\."pitlane-codex-plugin@community-local:hooks\/hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:[0-9a-f]{64}"$/mu,
  );
  assert.equal(result.hook_trust.rtk.length, 2);
  assert.equal(result.hook_trust.pitlane.length, 1);
  assert.match(recorder.getCapturedConfigText(), /model = "gpt-5\.4"/u);
  assert.match(recorder.getCapturedConfigText(), /\[projects\."\/path\/to\/worker-workspace"\]/u);
  assert.match(recorder.getCapturedConfigText(), /path = "\/home\/workera\/\.codex\/skills\/vercel-deploy\/SKILL\.md"/u);
  assert.equal(recorder.getCapturedAgentsText(), "@/home/workera/.codex/RTK.md\n");
  assert.match(recorder.getCapturedConfigText(), /^\[mcp_servers\.scout\]$/mu);
  assert.match(recorder.getCapturedConfigText(), /^\[mcp_servers\.requests\]$/mu);
  assert.match(recorder.getCapturedConfigText(), /^\[mcp_servers\.playwright\]$/mu);
  assert.match(recorder.getCapturedConfigText(), /^\[mcp_servers\.docker\]$/mu);
  assert.match(recorder.getCapturedConfigText(), /^\[mcp_servers\.workera-requests\]$/mu);
  assert.match(recorder.getCapturedConfigText(), /^\[mcp_servers\.agent_secret_broker\]$/mu);
  assert.match(
    recorder.getCapturedConfigText(),
    /^\[mcp_servers\.docker\]\ncommand = "docker"\nargs = \["exec", "-i", "mcp-docker", "mcp-server-docker"\]$/mu,
  );
  assert.match(
    recorder.getCapturedConfigText(),
    /^\[mcp_servers\.workera-requests\]\ncommand = "docker"\nargs = \["exec", "-i", "mcp-requests", "mcp-server-requests"\]$/mu,
  );
  assert.match(
    recorder.getCapturedConfigText(),
    /"local", "docker", "exec", "-i", "mcp-requests", "mcp-server-requests"/u,
  );
  assert.doesNotMatch(recorder.getCapturedConfigText(), /mcp-stdio-bridge/u);
  assert.equal(
    recorder.calls.some((call) => call.command === "npm"),
    true,
  );
  assert.equal(
    recorder.calls.filter((call) => call.command === "rsync").length,
    11,
  );
  assert.equal(
    recorder.calls.filter((call) =>
      call.command === "rsync"
      && call.args.includes("-s")
      && call.args.includes("-e")
      && call.args.includes("'ssh' '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=5' '-o' 'ServerAliveInterval=30' '-o' 'ServerAliveCountMax=6'")).length,
    11,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === "workera:/path/to/worker-workspace/apps/teledex/"
      && call.args.includes("--exclude")
      && call.args.includes("node_modules/")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.includes("workera:/home/workera/.codex/")
      && call.args.includes("--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=")
      && call.args.includes("--exclude")
      && call.args.includes("sessions/")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === "workera:/path/to/worker-workspace/tools/mcp-gateway/"
      && call.args.includes("--delete")
      && call.args.includes("--delete-excluded")
      && call.args.includes("--filter")
      && call.args.includes("P .env")
      && call.args.includes("P .env.*")
      && call.args.includes("node_modules/")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === "workera:/path/to/worker-workspace/tools/docker-socket-proxy/"
      && call.args.includes("--delete")
      && call.args.includes("--delete-excluded")
      && call.args.includes("--filter")
      && call.args.includes("P .env")
      && call.args.includes("P .env.*")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === "workera:/home/workera/.codex/models_cache.json"),
    true,
  );
  assert.deepEqual(result.mcp_profile.detected_local_containers, [
    "mcp-docker",
    "mcp-requests",
  ]);
  assert.deepEqual(result.mcp_profile.rendered_local_containers, [
    "mcp-docker",
    "mcp-requests",
  ]);
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === `workera:/home/workera/.codex/${RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH}/`
      && call.args.includes("--delete")
      && call.args.includes("--delete-excluded")
      && call.args.includes("--exclude")
      && call.args.includes("WORKSPACE_GUIDE.md")
      && call.args.includes("__pycache__/")
      && call.args.includes("node_modules/")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.at(-1) === `workera:/home/workera/.codex/${PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH}/`
      && call.args.includes("--delete")
      && call.args.includes("--delete-excluded")
      && call.args.includes("--exclude")
      && call.args.includes("WORKSPACE_GUIDE.md")
      && call.args.includes("__pycache__/")
      && call.args.includes("node_modules/")),
    true,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && call.args.includes("--copy-links")
      && call.args.at(-1) === "workera:/path/to/worker-workspace-state/external/forks/codex/bin/codex"),
    true,
  );
  assert.equal(
    recorder.calls
      .filter((call) => call.command === "rsync")
      .every((call) => !String(call.args.at(-1)).includes(":~")),
    true,
  );
  assert.equal(
    await fs
      .access(path.join(hostsRoot, "workera-bootstrap-config.toml"))
      .then(() => true)
      .catch(() => false),
    false,
  );
  assert.equal(
    await fs
      .access(path.join(
        stateRoot,
        "teledex-context",
        "hosts",
        "workera",
        "rendered",
        "models_cache.json",
      ))
      .then(() => true)
      .catch(() => false),
    true,
  );
  assert.equal(
    await fs
      .access(path.join(hostsRoot, "bootstrap-last-run.json"))
      .then(() => true)
      .catch(() => false),
    true,
  );
});

test("runHostBootstrapRuntime defaults to standalone MCP and RTK disabled", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-host-bootstrap-runtime-defaults-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "local",
    label: "local",
    ssh_target: "local",
    enabled: true,
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    capabilities: ["mcp-requests"],
  });

  const localHomeRoot = path.join(stateRoot, "home", "local");
  const sourceWorkspaceRoot = path.join(localHomeRoot, "workspace");
  const codexRoot = path.join(localHomeRoot, ".codex");
  await fs.mkdir(
    path.join(sourceWorkspaceRoot, "apps", "teledex"),
    { recursive: true },
  );
  await fs.mkdir(codexRoot, { recursive: true });
  const configPath = path.join(codexRoot, "config.toml");
  const authPath = path.join(codexRoot, "auth.json");
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-5.4"',
      "",
      "[features]",
      "plugins = true",
      "plugin_hooks = true",
      "",
      `[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`,
      "enabled = true",
      "",
      `[plugins."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"]`,
      "enabled = true",
      "",
      "[mcp_servers.scout]",
      'command = "stale"',
      "",
      "[mcp_servers.requests]",
      'command = "stale"',
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(authPath, '{"token":"secret"}\n', "utf8");
  const recorder = createExecFileRecorder();

  const result = await runHostBootstrapRuntime({
    codexNpmSpec: "@openai/codex@0.124.0",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: recorder.execFileImpl,
    hostsRoot,
    registryService,
    sourceAuthPath: authPath,
    sourceCodexRoot: codexRoot,
    sourceConfigPath: configPath,
    sourceWorkspaceRoot,
    targetHostId: "workera",
  });

  assert.equal(result.rtk_codex_plugin.status, "disabled");
  assert.equal(result.rtk_codex_plugin.mode, "off");
  assert.equal(result.rtk_codex_plugin.reason, "disabled-by-config");
  assert.equal(result.pitlane_codex_plugin.status, "disabled");
  assert.equal(result.pitlane_codex_plugin.mode, "off");
  assert.equal(result.pitlane_codex_plugin.reason, "disabled-by-config");
  assert.deepEqual(result.mcp_profile.detected_local_containers, []);
  assert.deepEqual(result.mcp_profile.rendered_local_containers, []);
  assert.equal(result.mcp_profile.preset, "none");
  assert.match(result.rtk_codex_plugin.warning, /TELEDEX_RTK_PLUGIN_MODE=off/u);
  assert.match(result.pitlane_codex_plugin.warning, /TELEDEX_PITLANE_PLUGIN_MODE=off/u);
  assert.doesNotMatch(recorder.getCapturedConfigText(), /\[mcp_servers\./u);
  assert.doesNotMatch(recorder.getCapturedConfigText(), new RegExp(RTK_CODEX_PLUGIN_CONFIG_KEY, "u"));
  assert.doesNotMatch(recorder.getCapturedConfigText(), new RegExp(PITLANE_CODEX_PLUGIN_CONFIG_KEY, "u"));
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && String(call.args.at(-1)).includes(RTK_CODEX_PLUGIN_CACHE_RELATIVE_PATH)),
    false,
  );
  assert.equal(
    recorder.calls.some((call) =>
      call.command === "rsync"
      && String(call.args.at(-1)).includes(PITLANE_CODEX_PLUGIN_CACHE_RELATIVE_PATH)),
    false,
  );
  assert.equal(
    recorder.calls.some((call) =>
      String(call.args.at(-1)).includes("tools/mcp-gateway")
      || String(call.args.at(-1)).includes("tools/docker-socket-proxy")
      || String(call.args.at(-1)).includes("worker-local-up")),
    false,
  );
});

test("runHostBootstrapRuntime rejects ranged Codex npm specs without a copied binary", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-host-bootstrap-runtime-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "local",
    label: "local",
    ssh_target: "local",
    enabled: true,
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
  });

  const codexRoot = path.join(stateRoot, "home", "local", ".codex");
  await fs.mkdir(codexRoot, { recursive: true });
  const configPath = path.join(codexRoot, "config.toml");
  const authPath = path.join(codexRoot, "auth.json");
  await fs.writeFile(configPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(authPath, '{"token":"secret"}\n', "utf8");

  await assert.rejects(
    () => runHostBootstrapRuntime({
      codexNpmSpec: "@openai/codex@^0.124.0",
      connectTimeoutSecs: 5,
      currentHostId: "local",
      execFileImpl: (command, args, options, callback) => {
        callback(new Error(`unexpected command: ${command}`), "", "");
      },
      hostsRoot,
      registryService,
      sourceAuthPath: authPath,
      sourceCodexRoot: codexRoot,
      sourceConfigPath: configPath,
      targetHostId: "workera",
    }),
    /pinned codexNpmSpec/u,
  );
});

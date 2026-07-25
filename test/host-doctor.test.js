import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildHybridCodexMcpConfigText } from "../src/hosts/codex-mcp-config.js";
import {
  buildCodexPitlaneCleanupScript,
  buildCodexPluginHooksTrustedScript,
  buildWorkerMcpConfigScript,
  hostDoctorResultsHaveFailures,
  inspectHostReadiness,
  resolveCodexSpaceFreshnessMaxAgeSecs,
  runHostDoctor,
} from "../src/hosts/host-doctor.js";
import {
  discoverCodexPluginHookTrustEntries,
  ensureCodexPluginHookTrustConfigText,
} from "../src/runtime/codex-plugin-hook-trust.js";
import {
  RTK_CODEX_PLUGIN_CONFIG_KEY,
  resolveWorkspaceRtkCodexPluginCachePath,
} from "../src/runtime/rtk-codex-plugin.js";
import {
  PITLANE_CODEX_PLUGIN_CONFIG_KEY,
  resolvePitlaneCodexPluginCachePath,
} from "../src/runtime/pitlane-codex-plugin.js";
import { HostRegistryService } from "../src/hosts/host-registry-service.js";

const execFileAsync = promisify(execFile);

function createExecFileStub({ failScripts = [] } = {}) {
  return (command, args, options, callback) => {
    const script = Array.isArray(args) ? args.at(-1) : "";
    const matchedFailure = failScripts.find((entry) => script.includes(entry));
    if (matchedFailure) {
      const error = new Error(`failed: ${matchedFailure}`);
      error.code = 1;
      callback(error, "", matchedFailure);
      return;
    }

    callback(null, "", "");
  };
}

test("inspectHostReadiness fails early for remote hosts without ssh_target", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: null,
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "missing-ssh-target");
});

test("hostDoctorResultsHaveFailures treats any not-ready snapshot as a CLI failure", () => {
  assert.equal(hostDoctorResultsHaveFailures([]), false);
  assert.equal(
    hostDoctorResultsHaveFailures([
      { snapshot: { ready: true } },
      { snapshot: { ready: false, failure_reason: "operator-toolbelt" } },
    ]),
    true,
  );
});

test("runHostDoctor persists ready snapshots and updates registry health", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-host-doctor-"),
  );
  const registryPath = path.join(stateRoot, "hosts", "registry-state.toml");
  const registryService = new HostRegistryService({
    registryPath,
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "local",
    label: "local",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_bin_path: "codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    required_capabilities: ["codex", "docker"],
  });

  const results = await runHostDoctor({
    codexSpaceRoot: path.join(stateRoot, "teledex-context"),
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub(),
    hostsRoot: path.join(stateRoot, "hosts"),
    registryService,
    targetHostId: "local",
  });
  const stored = await registryService.getHost("local");

  assert.equal(results.length, 1);
  assert.equal(results[0].snapshot.ready, true);
  assert.match(results[0].snapshot.generated_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(stored.last_health, "ready");
  assert.equal(
    await fs
      .access(path.join(stateRoot, "hosts", "doctor", "local.json"))
      .then(() => true)
      .catch(() => false),
    true,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(stateRoot, "teledex-context", "hosts", "local", "rendered", "health.json"),
        "utf8",
      ),
    ).generated_at,
    results[0].snapshot.generated_at,
  );
});

test("inspectHostReadiness reports docker as not ready when a local-MCP host lacks docker", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["docker info"] }),
    host: {
      host_id: "workerz",
      label: "workerz",
      enabled: true,
      ssh_target: "workerz",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      capabilities: ["mcp-docker"],
      required_capabilities: ["codex", "docker"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "docker");
  assert.equal(snapshot.checks.some((check) => check.id === "docker" && check.ok === false), true);
});

test("inspectHostReadiness requires the operator CLI toolbelt", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["operator_toolbelt_missing"] }),
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "operator-toolbelt");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "operator-toolbelt" && check.ok === false,
    ),
    true,
  );
});

test("inspectHostReadiness fails when Codex RTK plugin readiness fails", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["rtk-codex-hook"] }),
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "codex-rtk-plugin");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "codex-rtk-plugin" && check.ok === false,
    ),
    true,
  );
  assert.deepEqual(snapshot.warnings.map((warning) => warning.id), []);
});

test("inspectHostReadiness verifies host-local Pitlane command smoke", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["pitlane --version"] }),
    mcpPreset: "workspace",
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      capabilities: ["mcp-docker"],
      required_capabilities: ["codex", "docker"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "host-local-pitlane");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "host-local-pitlane" && check.ok === false,
    ),
    true,
  );
});

test("buildCodexPitlaneCleanupScript rejects stale pitlane MCP config and bad plugin order", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pitlane-cleanup-"));
  const configPath = path.join(tempDir, "config.toml");
  const pitlanePluginRoot = resolvePitlaneCodexPluginCachePath(tempDir);
  const pitlaneHookPath = path.join(pitlanePluginRoot, "hooks", "pitlane-codex-hook");
  const validConfig = [
    'model = "gpt-5.4"',
    "",
    '[plugins."rtk-codex-plugin@community-local"]',
    "enabled = true",
    "",
    '[plugins."pitlane-codex-plugin@community-local"]',
    "enabled = true",
    "",
  ].join("\n");
  const script = buildCodexPitlaneCleanupScript(configPath);

  await fs.mkdir(path.join(pitlanePluginRoot, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(pitlanePluginRoot, "hooks"), { recursive: true });
  await fs.writeFile(path.join(pitlanePluginRoot, ".codex-plugin", "plugin.json"), "{}\n");
  await fs.writeFile(path.join(pitlanePluginRoot, "hooks", "hooks.json"), "{}\n");
  await fs.writeFile(pitlaneHookPath, "#!/usr/bin/env sh\nexit 0\n");
  await fs.chmod(pitlaneHookPath, 0o700);
  await fs.writeFile(configPath, validConfig);
  await execFileAsync("bash", ["-c", script]);

  await fs.rename(pitlaneHookPath, `${pitlaneHookPath}.disabled`);
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /pitlane-codex-hook/u,
  );
  await fs.rename(`${pitlaneHookPath}.disabled`, pitlaneHookPath);

  await fs.writeFile(configPath, [
    validConfig,
    "",
    `[mcp_servers.${["pit", "lane"].join("")}]`,
    'command = "docker"',
    "",
  ].join("\n"));
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /reserved or legacy pitlane MCP config remains/u,
  );

  await fs.writeFile(configPath, [
    validConfig,
    "",
    "[mcp_servers.old_code_intel]",
    'command = "docker"',
    `args = ["exec", "-i", "${["mcp", "pitlane"].join("-")}"]`,
    "",
  ].join("\n"));
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /reserved or legacy pitlane MCP config remains/u,
  );

  await fs.writeFile(configPath, [
    'model = "gpt-5.4"',
    "",
    '[plugins."pitlane-codex-plugin@community-local"]',
    "enabled = true",
    "",
    '[plugins."rtk-codex-plugin@community-local"]',
    "enabled = true",
    "",
  ].join("\n"));
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /RTK plugin must be configured before Pitlane plugin/u,
  );
});

test("buildCodexPluginHooksTrustedScript rejects enabled plugins without trusted hook state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-hook-trust-"));
  const configPath = path.join(tempDir, "config.toml");
  const rtkPluginRoot = resolveWorkspaceRtkCodexPluginCachePath(tempDir);
  const pitlanePluginRoot = resolvePitlaneCodexPluginCachePath(tempDir);
  const rtkHooksJson = {
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
  };
  const pitlaneHooksJson = {
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
  };
  for (const [pluginRoot, hooksJson] of [
    [rtkPluginRoot, rtkHooksJson],
    [pitlanePluginRoot, pitlaneHooksJson],
  ]) {
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      '{"hooks":"./hooks/hooks.json"}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify(hooksJson, null, 2),
      "utf8",
    );
  }
  for (const filePath of [
    path.join(rtkPluginRoot, "hooks", "rtk-codex-hook"),
    path.join(rtkPluginRoot, "hooks", "rtk-output-post-hook"),
    path.join(pitlanePluginRoot, "hooks", "pitlane-codex-hook"),
  ]) {
    await fs.writeFile(filePath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
    await fs.chmod(filePath, 0o700);
  }
  const baseConfig = [
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
  ].join("\n");
  const script = buildCodexPluginHooksTrustedScript(configPath);

  await fs.writeFile(configPath, baseConfig, "utf8");
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /Codex plugin hook is untrusted/u,
  );

  await fs.writeFile(configPath, [
    "[features]",
    "plugins = true",
    "plugin_hooks = true",
    "",
    `[plugins . "${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`,
    "enabled = true",
    "",
  ].join("\n"), "utf8");
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /Codex plugin hook is untrusted/u,
  );

  const trustedConfig = ensureCodexPluginHookTrustConfigText(baseConfig, [
    {
      key: "rtk-codex-plugin@community-local:hooks/hooks.json:pre_tool_use:0:0",
      trustedHash: "sha256:wrong",
    },
  ]);
  await fs.writeFile(configPath, trustedConfig, "utf8");
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /trusted_hash mismatch/u,
  );

  const allTrustEntries = [
    ...(await discoverCodexPluginHookTrustEntries({
      pluginId: RTK_CODEX_PLUGIN_CONFIG_KEY,
      pluginRoot: rtkPluginRoot,
    })),
    ...(await discoverCodexPluginHookTrustEntries({
      pluginId: PITLANE_CODEX_PLUGIN_CONFIG_KEY,
      pluginRoot: pitlanePluginRoot,
    })),
  ];
  const fullyTrustedConfig = ensureCodexPluginHookTrustConfigText(
    baseConfig.replace("plugins = true", "plugins = true # inline comment"),
    allTrustEntries,
  );
  await fs.writeFile(configPath, fullyTrustedConfig, "utf8");
  await assert.doesNotReject(execFileAsync("bash", ["-c", script]));

  const disabledPluginConfig = ensureCodexPluginHookTrustConfigText([
    "[features]",
    "plugins = true",
    "plugin_hooks = true",
    "",
    `[plugins."${RTK_CODEX_PLUGIN_CONFIG_KEY}"]`,
    "enabled = false # temporarily disabled",
    "",
    `[plugins."${PITLANE_CODEX_PLUGIN_CONFIG_KEY}"]`,
    "enabled = true",
    "",
  ].join("\n"), allTrustEntries);
  await fs.writeFile(configPath, disabledPluginConfig, "utf8");
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /inactive/u,
  );

  const disabledHookKey =
    "rtk-codex-plugin@community-local:hooks/hooks.json:pre_tool_use:0:0";
  const disabledHookConfig = fullyTrustedConfig.replace(
    `[hooks.state."${disabledHookKey}"]\ntrusted_hash`,
    `[hooks.state."${disabledHookKey}"]\nenabled = false # temporarily disabled\ntrusted_hash`,
  );
  await fs.writeFile(configPath, disabledHookConfig, "utf8");
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /disabled/u,
  );

  const disabledSpacedHookConfig = fullyTrustedConfig.replace(
    `[hooks.state."${disabledHookKey}"]\ntrusted_hash`,
    `[hooks . state . "${disabledHookKey}"]\nenabled = false # temporarily disabled\ntrusted_hash`,
  );
  await fs.writeFile(configPath, disabledSpacedHookConfig, "utf8");
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /disabled/u,
  );

  await fs.writeFile(configPath, fullyTrustedConfig, "utf8");
  await fs.chmod(path.join(rtkPluginRoot, "hooks", "rtk-codex-hook"), 0o600);
  await assert.rejects(
    execFileAsync("bash", ["-c", script]),
    /not executable/u,
  );
});

test("inspectHostReadiness verifies local docker MCP smoke on the current host", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["docker exec docker-socket-proxy"] }),
    mcpPreset: "workspace",
    host: {
      host_id: "local",
      label: "local",
      enabled: true,
      ssh_target: "local",
      mcp_mode: "local",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex", "docker"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "host-local-docker-mcp");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "host-local-docker-mcp" && check.ok === false,
    ),
    true,
  );
});

test("inspectHostReadiness verifies worker docker MCP smoke without optional capabilities", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["docker exec docker-socket-proxy"] }),
    mcpPreset: "workspace",
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      capabilities: [],
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "host-local-docker-mcp");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "host-local-docker-mcp" && check.ok === false,
    ),
    true,
  );
});

test("worker MCP profile doctor rejects stale shared profiles and wrong local names", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-mcp-doctor-"));
  const validConfig = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workera", capabilities: ["mcp-requests"] },
    localMcpContainers: new Set(["mcp-docker", "mcp-requests"]),
    mcpPreset: "workspace",
  });
  const validPath = path.join(tempDir, "valid.toml");
  const quotedDockerPath = path.join(tempDir, "quoted-docker.toml");
  const wrongTargetPath = path.join(tempDir, "wrong-target.toml");
  const wrongRequestsPath = path.join(tempDir, "wrong-requests.toml");
  const missingRequestsPath = path.join(tempDir, "missing-requests.toml");
  const undeclaredPlaywrightPath = path.join(tempDir, "undeclared-playwright.toml");
  const staleSsePath = path.join(tempDir, "stale-sse.toml");
  const stalePitlanePath = path.join(tempDir, "stale-pitlane.toml");
  const staleLegacyPitlanePath = path.join(tempDir, "stale-legacy-pitlane.toml");
  const customSharedTargetPath = path.join(tempDir, "custom-shared-target.toml");
  const noMcpPath = path.join(tempDir, "no-mcp.toml");

  await fs.writeFile(validPath, validConfig);
  await fs.writeFile(noMcpPath, 'model = "gpt-5.4"\n');
  await fs.writeFile(
    quotedDockerPath,
    [
      validConfig.trimEnd(),
      "",
      '[mcp_servers."docker"]',
      'command = "docker"',
      'args = ["exec", "-i", "mcp-requests", "mcp-server-requests"]',
      "",
    ].join("\n"),
  );
  await fs.writeFile(wrongTargetPath, validConfig.replace(/"-T", "local"/u, '"-T", "workera"'));
  await fs.writeFile(
    missingRequestsPath,
    buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
      host: { host_id: "workera", capabilities: ["mcp-requests"] },
      localMcpContainers: new Set(["mcp-docker"]),
      mcpPreset: "workspace",
    }),
  );
  await fs.writeFile(
    wrongRequestsPath,
    [
      validConfig.trimEnd(),
      "",
      '[mcp_servers."workerz-requests"]',
      'command = "docker"',
      'args = ["exec", "-i", "mcp-requests", "mcp-server-requests"]',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    undeclaredPlaywrightPath,
    [
      validConfig.trimEnd(),
      "",
      '[mcp_servers."workera-playwright"]',
      'command = "docker"',
      'args = ["exec", "-i", "-e", "PLAYWRIGHT_USER_DATA_DIR=/data/playwright-profile/profile-codex", "mcp-playwright", "start-playwright-mcp"]',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    staleSsePath,
    validConfig.replace(
      /"docker", "exec", "-i", "mcp-requests", "mcp-server-requests"/u,
      '"node", "/path/to/workspace/tools/mcp-gateway/mcp-stdio-bridge.js", "http://127.0.0.1:3102/sse"',
    ),
  );
  await fs.writeFile(
    stalePitlanePath,
    [
      validConfig.trimEnd(),
      "",
      `[mcp_servers.${["pit", "lane"].join("")}]`,
      'command = "pitlane"',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    staleLegacyPitlanePath,
    [
      validConfig.trimEnd(),
      "",
      "[mcp_servers.old_code_intel]",
      'command = "docker"',
      `args = ["exec", "-i", "${["mcp", "pitlane"].join("-")}", "node", "/opt/${["pitlane", "compact"].join("-")}/${["pitlane", "compact", "mcp"].join("-")}.mjs"]`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(customSharedTargetPath, validConfig.replaceAll('"-T", "local"', '"-T", "local-lan"'));

  const buildWorkspaceMcpScript = (
    targetPath,
    capabilities = ["mcp-requests"],
    sharedTarget = "local",
  ) => buildWorkerMcpConfigScript(targetPath, "workera", capabilities, sharedTarget, {
    mcpPreset: "workspace",
  });

  await execFileAsync("bash", ["-c", buildWorkspaceMcpScript(validPath)]);
  await execFileAsync("bash", [
    "-c",
    buildWorkerMcpConfigScript(noMcpPath, "workera", ["mcp-requests"], "local", {
      mcpPreset: "none",
    }),
  ]);
  await execFileAsync("bash", [
    "-c",
    buildWorkspaceMcpScript(customSharedTargetPath, ["mcp-requests"], "local-lan"),
  ]);
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(quotedDockerPath)]),
    /host-local MCP entry does not use local docker command: docker/u,
  );
  await assert.rejects(
    execFileAsync("bash", [
      "-c",
      buildWorkerMcpConfigScript(validPath, "workera", ["mcp-requests"], "local", {
        mcpPreset: "none",
      }),
    ]),
    /unexpected MCP entries for TELEDEX_MCP_PRESET=none/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(wrongTargetPath)]),
    /shared MCP entry does not use direct local stdio command/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(missingRequestsPath)]),
    /missing optional host-local MCP entry for declared host capability: workera-requests/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(wrongRequestsPath)]),
    /host-local MCP entry is not prefixed with workera: workerz-requests/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(undeclaredPlaywrightPath)]),
    /optional host-local MCP entry is not declared by host capability: workera-playwright/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(staleSsePath)]),
    /shared MCP entry does not use direct local stdio command/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(stalePitlanePath)]),
    /worker profile must not include reserved or legacy pitlane server: pitlane/u,
  );
  await assert.rejects(
    execFileAsync("bash", ["-c", buildWorkspaceMcpScript(staleLegacyPitlanePath)]),
    /worker profile must not include reserved or legacy pitlane server: old_code_intel/u,
  );
});

test("inspectHostReadiness skips workspace MCP smoke checks for MCP preset none", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["docker exec mcp-docker"] }),
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      capabilities: ["mcp-docker"],
      required_capabilities: ["codex"],
    },
    mcpPreset: "none",
  });

  assert.equal(snapshot.ready, true);
  assert.equal(
    snapshot.checks.some((check) => check.id === "host-local-pitlane"),
    true,
  );
  assert.equal(
    snapshot.checks.some((check) => check.id === "host-local-docker-mcp"),
    false,
  );
  assert.equal(
    snapshot.checks.some((check) => check.id === "codex-mcp-profile"),
    true,
  );
});

test("inspectHostReadiness fails when synced teledex-context is stale", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceMaxAgeSecs: resolveCodexSpaceFreshnessMaxAgeSecs(15),
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["shared/rendered/manifest.json"] }),
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.failure_reason, "shared-teledex-context-fresh");
  assert.equal(
    snapshot.checks.some(
      (check) => check.id === "shared-teledex-context-fresh" && check.ok === false,
    ),
    true,
  );
});

test("inspectHostReadiness treats missing passwordless sudo as advisory for normal execution", async () => {
  const snapshot = await inspectHostReadiness({
    codexSpaceRoot: "/tmp/teledex-context",
    connectTimeoutSecs: 5,
    currentHostId: "local",
    execFileImpl: createExecFileStub({ failScripts: ["sudo -n true"] }),
    host: {
      host_id: "workera",
      label: "workera",
      enabled: true,
      ssh_target: "workera",
      workspace_root: "/path/to/worker-workspace",
      repo_root: "/path/to/worker-workspace/apps/teledex",
      worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
      codex_bin_path: "codex",
      codex_config_path: "~/.codex/config.toml",
      codex_auth_path: "~/.codex/auth.json",
      required_capabilities: ["codex"],
    },
  });

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.failure_reason, null);
  assert.equal(snapshot.checks.some((check) => check.id === "sudo" && check.ok === false), true);
  assert.deepEqual(
    snapshot.warnings.map((warning) => warning.id),
    ["sudo"],
  );
});

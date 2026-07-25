import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHybridCodexMcpConfigText,
  parseLocalMcpContainerProbeOutput,
  validateHybridWorkerMcpConfigText as validateHybridWorkerMcpConfigTextBase,
} from "../src/hosts/codex-mcp-config.js";

function validateHybridWorkerMcpConfigText(configText, hostId, options = {}) {
  return validateHybridWorkerMcpConfigTextBase(configText, hostId, {
    mcpPreset: "workspace",
    ...options,
  });
}

test("buildHybridCodexMcpConfigText replaces copied local MCP entries with direct shared stdio entries", () => {
  const rendered = buildHybridCodexMcpConfigText(
    [
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.docker]",
      'command = "docker"',
      'args = ["exec", "-i", "mcp-docker", "mcp-server-docker"]',
      "",
      "[mcp_servers.requests]",
      'command = "docker"',
      'args = ["exec", "-i", "mcp-requests", "/opt/venv/bin/mcp-server-requests"]',
      "",
      '[projects."/path/to/worker-workspace"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
    {
      connectTimeoutSecs: 5,
      host: { host_id: "workera" },
      localMcpContainers: new Set(["mcp-docker"]),
      mcpPreset: "workspace",
      sharedHostSshTarget: "local",
    },
  );

  assert.match(rendered, /^\[mcp_servers\.scout\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.requests\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.playwright\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.docker\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.tavily\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.context7\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.agent_secret_broker\]$/mu);
  assert.match(rendered, /command = "ssh"/u);
  assert.match(rendered, /"ControlMaster=auto"/u);
  assert.match(rendered, /"ControlPersist=10m"/u);
  assert.match(rendered, /"ConnectTimeout=5"/u);
  assert.match(rendered, /"mcp-playwright", "start-playwright-mcp"/u);
  assert.match(rendered, /^\[mcp_servers\.docker\]\ncommand = "docker"\nargs = \["exec", "-i", "mcp-docker", "mcp-server-docker"\]$/mu);
  assert.match(rendered, /"mcp-project-scout", "node", "src\/index\.js", "--stdio"/u);
  assert.match(rendered, /"agent-secret-broker"/u);
  assert.doesNotMatch(rendered, /mcp-stdio-bridge/u);
  assert.doesNotMatch(rendered, /127\.0\.0\.1:310[2-8]\/sse/u);
  assert.match(rendered, /^\[projects\."\/path\/to\/worker-workspace"\]$/mu);
  assert.equal(validateHybridWorkerMcpConfigText(rendered, "workera").ok, true);
});

test("buildHybridCodexMcpConfigText supports TELEDEX_MCP_PRESET=none", () => {
  const rendered = buildHybridCodexMcpConfigText([
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.requests]",
    'command = "docker"',
    'args = ["exec", "-i", "mcp-requests", "mcp-server-requests"]',
    "",
    "[projects.\"/workspace/example\"]",
    'trust_level = "trusted"',
    "",
  ].join("\n"), {
    mcpPreset: "none",
  });

  assert.doesNotMatch(rendered, /^\[mcp_servers\./mu);
  assert.match(rendered, /^model = "gpt-5\.4"$/mu);
  assert.match(rendered, /^\[projects\."\/workspace\/example"\]$/mu);
  assert.equal(
    validateHybridWorkerMcpConfigText(rendered, "workera", { mcpPreset: "none" }).ok,
    true,
  );
});

test("buildHybridCodexMcpConfigText keeps only detected optional host-local MCP entries with host prefix", () => {
  const rendered = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workerz", capabilities: ["mcp-playwright", "mcp-requests"] },
    localMcpContainers: new Set([
      "mcp-docker",
      "mcp-playwright",
      "mcp-requests",
    ]),
    mcpPreset: "workspace",
  });

  assert.match(rendered, /^\[mcp_servers\.docker\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.workerz-playwright\]$/mu);
  assert.match(rendered, /^\[mcp_servers\.workerz-requests\]$/mu);
  assert.doesNotMatch(rendered, /^\[mcp_servers\.workerz-docker\]$/mu);
  assert.equal(
    validateHybridWorkerMcpConfigText(rendered, "workerz", {
      hostCapabilities: ["mcp-playwright", "mcp-requests"],
    }).ok,
    true,
  );
});

test("buildHybridCodexMcpConfigText ignores running optional MCP containers without host capability", () => {
  const rendered = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workera", capabilities: ["mcp-requests"] },
    localMcpContainers: new Set([
      "mcp-docker",
      "mcp-playwright",
      "mcp-requests",
    ]),
    mcpPreset: "workspace",
  });

  assert.match(rendered, /^\[mcp_servers\.workera-requests\]$/mu);
  assert.doesNotMatch(rendered, /^\[mcp_servers\.workera-playwright\]$/mu);
  assert.equal(
    validateHybridWorkerMcpConfigText(rendered, "workera", {
      hostCapabilities: ["mcp-requests"],
    }).ok,
    true,
  );
});

test("validateHybridWorkerMcpConfigText requires optional entries for declared host capabilities", () => {
  const rendered = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workera", capabilities: ["mcp-requests"] },
    localMcpContainers: new Set(["mcp-docker"]),
    mcpPreset: "workspace",
  });

  const result = validateHybridWorkerMcpConfigText(rendered, "workera", {
    hostCapabilities: ["mcp-requests"],
  });

  assert.equal(result.ok, false);
  assert.match(
    result.reason,
    /missing optional host-local MCP entry for declared host capability: workera-requests/u,
  );
});

test("validateHybridWorkerMcpConfigText requires docker to be host-local", () => {
  const missingDocker = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workerz" },
    localMcpContainers: new Set(),
    mcpPreset: "workspace",
  });
  const sharedDocker = [
    missingDocker.trimEnd(),
    "",
    "[mcp_servers.docker]",
    'command = "ssh"',
    'args = ["-T", "local", "docker", "exec", "-i", "mcp-docker", "mcp-server-docker"]',
    "",
  ].join("\n");

  assert.equal(validateHybridWorkerMcpConfigText(missingDocker, "workerz").ok, false);
  assert.match(
    validateHybridWorkerMcpConfigText(missingDocker, "workerz").reason,
    /missing host-local MCP entry: docker/u,
  );
  assert.equal(validateHybridWorkerMcpConfigText(sharedDocker, "workerz").ok, false);
  assert.match(
    validateHybridWorkerMcpConfigText(sharedDocker, "workerz").reason,
    /host-local MCP entry does not use local docker command: docker/u,
  );
});

test("validateHybridWorkerMcpConfigText rejects the reserved pitlane server name in worker profiles", () => {
  const rendered = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workera" },
    localMcpContainers: new Set(["mcp-docker"]),
    mcpPreset: "workspace",
  });
  const reservedServerName = ["pit", "lane"].join("");
  const stalePitlane = [
    rendered.trimEnd(),
    "",
    `[mcp_servers.${reservedServerName}]`,
    'command = "pitlane"',
    "",
  ].join("\n");

  const result = validateHybridWorkerMcpConfigText(stalePitlane, "workera");

  assert.equal(result.ok, false);
  assert.match(result.reason, /worker profile must not include reserved or legacy pitlane server: pitlane/u);
});

test("validateHybridWorkerMcpConfigText rejects renamed legacy pitlane server commands", () => {
  const rendered = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workera" },
    localMcpContainers: new Set(["mcp-docker"]),
    mcpPreset: "workspace",
  });
  const legacyContainer = ["mcp", "pitlane"].join("-");
  const legacyEntrypoint = ["pitlane", "compact", "mcp"].join("-");
  const staleLegacyServer = [
    rendered.trimEnd(),
    "",
    "[mcp_servers.old_code_intel]",
    'command = "docker"',
    `args = ["exec", "-i", "${legacyContainer}", "node", "/opt/${["pitlane", "compact"].join("-")}/${legacyEntrypoint}.mjs"]`,
    "",
  ].join("\n");

  const result = validateHybridWorkerMcpConfigText(staleLegacyServer, "workera");

  assert.equal(result.ok, false);
  assert.match(result.reason, /worker profile must not include reserved or legacy pitlane server: old_code_intel/u);
});

test("validateHybridWorkerMcpConfigText rejects legacy worker MCP profiles", () => {
  const legacyConfig = [
    "[mcp_servers.docker]",
    'command = "docker"',
    'args = ["exec", "-i", "mcp-docker", "mcp-server-docker"]',
    "",
    "[mcp_servers.requests]",
    'command = "docker"',
    'args = ["exec", "-i", "mcp-requests", "/opt/venv/bin/mcp-server-requests"]',
    "",
  ].join("\n");

  const result = validateHybridWorkerMcpConfigText(legacyConfig, "workera");

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing shared MCP entries|unqualified worker-local/u);
});

test("validateHybridWorkerMcpConfigText rejects non-local shared bridges and quoted local names", () => {
  const rendered = buildHybridCodexMcpConfigText('model = "gpt-5.4"\n', {
    host: { host_id: "workera" },
    localMcpContainers: new Set(["mcp-docker"]),
    mcpPreset: "workspace",
  });

  const wrongSharedTarget = rendered.replace(/"-T", "local"/u, '"-T", "workera"');
  const staleSseBridge = rendered.replace(
    /"docker", "exec", "-i", "mcp-requests", "mcp-server-requests"/u,
    '"node", "/path/to/workspace/tools/mcp-gateway/mcp-stdio-bridge.js", "http://127.0.0.1:3102/sse"',
  );
  const quotedDocker = [
    rendered.trimEnd(),
    "",
    '[mcp_servers."docker"]',
    'command = "docker"',
    'args = ["exec", "-i", "mcp-requests", "mcp-server-requests"]',
    "",
  ].join("\n");
  const quotedWrongLocal = [
    rendered.trimEnd(),
    "",
    '[mcp_servers."workerz-docker"]',
    'command = "docker"',
    'args = ["exec", "-i", "mcp-docker", "mcp-server-docker"]',
    "",
  ].join("\n");
  const wrongOptionalLocal = [
    rendered.trimEnd(),
    "",
    '[mcp_servers."workera-requests"]',
    'command = "docker"',
    'args = ["exec", "-i", "mcp-docker", "mcp-server-docker"]',
    "",
  ].join("\n");

  assert.equal(validateHybridWorkerMcpConfigText(wrongSharedTarget, "workera").ok, false);
  assert.match(
    validateHybridWorkerMcpConfigText(wrongSharedTarget, "workera").reason,
    /shared MCP entry does not use direct local stdio command/u,
  );
  assert.equal(validateHybridWorkerMcpConfigText(staleSseBridge, "workera").ok, false);
  assert.match(
    validateHybridWorkerMcpConfigText(staleSseBridge, "workera").reason,
    /shared MCP entry does not use direct local stdio command/u,
  );
  assert.equal(validateHybridWorkerMcpConfigText(quotedDocker, "workera").ok, false);
  assert.match(validateHybridWorkerMcpConfigText(quotedDocker, "workera").reason, /host-local MCP entry/u);
  assert.equal(validateHybridWorkerMcpConfigText(quotedWrongLocal, "workera").ok, false);
  assert.match(
    validateHybridWorkerMcpConfigText(quotedWrongLocal, "workera").reason,
    /worker docker MCP must be the unqualified host-local entry/u,
  );
  assert.equal(validateHybridWorkerMcpConfigText(wrongOptionalLocal, "workera").ok, false);
  assert.match(
    validateHybridWorkerMcpConfigText(wrongOptionalLocal, "workera").reason,
    /optional host-local MCP entry does not use local docker command: workera-requests/u,
  );

  const undeclaredOptionalLocal = [
    rendered.trimEnd(),
    "",
    '[mcp_servers."workera-playwright"]',
    'command = "docker"',
    'args = ["exec", "-i", "-e", "PLAYWRIGHT_USER_DATA_DIR=/data/playwright-profile/profile-codex", "mcp-playwright", "start-playwright-mcp"]',
    "",
  ].join("\n");
  assert.equal(
    validateHybridWorkerMcpConfigText(undeclaredOptionalLocal, "workera", {
      hostCapabilities: [],
    }).ok,
    false,
  );
  assert.match(
    validateHybridWorkerMcpConfigText(undeclaredOptionalLocal, "workera", {
      hostCapabilities: [],
    }).reason,
    /optional host-local MCP entry is not declared by host capability: workera-playwright/u,
  );
});

test("parseLocalMcpContainerProbeOutput ignores unrelated containers", () => {
  assert.deepEqual(
    Array.from(parseLocalMcpContainerProbeOutput([
      "mcp-docker",
      "mcp-requests",
      "docker-socket-proxy",
      "",
    ].join("\n"))).sort(),
    ["mcp-docker", "mcp-requests"],
  );
});

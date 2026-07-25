const SHARED_STDIO_MCP_SERVERS = [
  ["requests", ["docker", "exec", "-i", "mcp-requests", "mcp-server-requests"]],
  ["playwright", ["docker", "exec", "-i", "mcp-playwright", "start-playwright-mcp"]],
  ["scout", ["docker", "exec", "-i", "mcp-project-scout", "node", "src/index.js", "--stdio"]],
  ["context7", ["docker", "exec", "-i", "mcp-context7", "context7-mcp"]],
  ["tavily", ["docker", "exec", "-i", "mcp-tavily", "tavily-mcp"]],
];
const REQUIRED_LOCAL_MCP_SERVERS = new Map([
  ["mcp-docker", {
    name: "docker",
    args: ["exec", "-i", "mcp-docker", "mcp-server-docker"],
  }],
]);
const SHARED_MCP_NAMES = [
  ...SHARED_STDIO_MCP_SERVERS.map(([name]) => name),
  "agent_secret_broker",
];
const SHARED_MCP_COMMAND_ARGS = new Map([
  ...SHARED_STDIO_MCP_SERVERS,
  [
    "agent_secret_broker",
    ["docker", "exec", "-i", "agent-secret-broker", "node", "src/index.js"],
  ],
]);
const RESERVED_PITLANE_MCP_SERVER_NAME = "pitlane";
const LEGACY_PITLANE_MCP_BLOCK_MARKERS = [
  ["mcp", "pitlane"].join("-"),
  ["pitlane", "compact", "mcp"].join("-"),
  ["pitlane", "sse", "gateway"].join("-"),
];

const HOST_LOCAL_MCP_CONTAINERS = new Map([
  ...Array.from(REQUIRED_LOCAL_MCP_SERVERS, ([containerName, spec]) => [
    containerName,
    {
      ...spec,
      required: true,
    },
  ]),
  ["mcp-playwright", {
    capability: "mcp-playwright",
    suffix: "playwright",
    args: [
      "exec",
      "-i",
      "-e",
      "PLAYWRIGHT_USER_DATA_DIR=/data/playwright-profile/profile-codex",
      "mcp-playwright",
      "start-playwright-mcp",
    ],
  }],
  ["mcp-requests", {
    capability: "mcp-requests",
    suffix: "requests",
    args: [
      "exec",
      "-i",
      "mcp-requests",
      "mcp-server-requests",
    ],
  }],
]);

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function tomlTableKey(value) {
  const normalized = String(value || "");
  return /^[A-Za-z0-9_-]+$/u.test(normalized)
    ? normalized
    : tomlString(normalized);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseTomlTableKey(rawKey) {
  const raw = String(rawKey || "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

function renderMcpServerTable(name, { command, args }) {
  return [
    `[mcp_servers.${tomlTableKey(name)}]`,
    `command = ${tomlString(command)}`,
    `args = ${tomlArray(args)}`,
  ].join("\n");
}

function isTomlTableHeader(line) {
  return /^\s*\[+/u.test(line);
}

function isMcpServerTableHeader(line) {
  return /^\s*\[mcp_servers(?:\.|\])/u.test(line);
}

function parseMcpServerBlocks(text) {
  const blocks = new Map();
  let currentName = null;
  let currentLines = null;

  function flushCurrent() {
    if (currentName != null && currentLines != null) {
      blocks.set(currentName, currentLines.join("\n"));
    }
    currentName = null;
    currentLines = null;
  }

  for (const line of String(text || "").replace(/\r\n/gu, "\n").split("\n")) {
    const header = line.match(
      /^\s*\[mcp_servers\.((?:"(?:\\.|[^"\\])*")|(?:'[^']*')|(?:[A-Za-z0-9_-]+))\]\s*$/u,
    );
    if (header) {
      flushCurrent();
      currentName = parseTomlTableKey(header[1]);
      currentLines = [line];
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      flushCurrent();
      continue;
    }
    if (currentLines != null) {
      currentLines.push(line);
    }
  }

  flushCurrent();
  return blocks;
}

function isReservedPitlaneMcpBlock(name, block) {
  return (
    name === RESERVED_PITLANE_MCP_SERVER_NAME
    || LEGACY_PITLANE_MCP_BLOCK_MARKERS.some((marker) => String(block || "").includes(marker))
  );
}

function hostHasCapability(host, capability) {
  return Array.isArray(host?.capabilities) && host.capabilities.includes(capability);
}

function quotedTomlSequence(values) {
  return values.map((value) => escapeRegExp(tomlString(value))).join("\\s*,\\s*");
}

function mcpBlockUsesLocalDockerCommand(block, commandArgs) {
  const commandPattern = new RegExp(quotedTomlSequence(commandArgs), "u");
  return (
    /^\s*command\s*=\s*"docker"\s*$/mu.test(block || "") &&
    commandPattern.test(block || "")
  );
}

function mcpBlockUsesSharedSshCommand(block, sharedHostSshTarget, commandArgs) {
  const targetPattern = new RegExp(
    `${escapeRegExp(tomlString("-T"))}\\s*,\\s*${escapeRegExp(tomlString(sharedHostSshTarget))}`,
    "u",
  );
  const commandPattern = new RegExp(quotedTomlSequence(commandArgs), "u");
  return (
    /^\s*command\s*=\s*"ssh"\s*$/mu.test(block || "") &&
    targetPattern.test(block || "") &&
    commandPattern.test(block || "")
  );
}

function replaceMcpServerBlocks(configText, renderedMcpText) {
  if (!String(renderedMcpText || "").trim()) {
    return removeMcpServerBlocks(configText);
  }

  const lines = String(configText || "").replace(/\r\n/gu, "\n").split("\n");
  const output = [];
  let inserted = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isMcpServerTableHeader(line)) {
      output.push(line);
      continue;
    }

    if (!inserted) {
      if (output.length > 0 && output.at(-1) !== "") {
        output.push("");
      }
      output.push(renderedMcpText);
      inserted = true;
    }

    index += 1;
    while (index < lines.length && !isTomlTableHeader(lines[index])) {
      index += 1;
    }
    index -= 1;
  }

  if (!inserted) {
    const insertAt = output.findIndex((line) => isTomlTableHeader(line));
    const insertion = ["", renderedMcpText, ""];
    if (insertAt === -1) {
      if (output.length > 0 && output.at(-1) !== "") {
        output.push("");
      }
      output.push(renderedMcpText);
    } else {
      output.splice(insertAt, 0, ...insertion);
    }
  }

  return `${output.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function removeMcpServerBlocks(configText) {
  const lines = String(configText || "").replace(/\r\n/gu, "\n").split("\n");
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isMcpServerTableHeader(line)) {
      output.push(line);
      continue;
    }

    index += 1;
    while (index < lines.length && !isTomlTableHeader(lines[index])) {
      index += 1;
    }
    index -= 1;
  }

  return `${output.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function normalizeMcpPreset(value) {
  const preset = String(value || "none").trim().toLowerCase();
  if (preset === "workspace" || preset === "none") {
    return preset;
  }
  throw new Error(`Invalid TELEDEX_MCP_PRESET: ${value}. Use workspace or none.`);
}

export function buildLocalMcpContainerProbeScript() {
  const containerNames = Array.from(HOST_LOCAL_MCP_CONTAINERS.keys());
  return [
    "set -euo pipefail",
    "command -v docker >/dev/null 2>&1 || exit 0",
    "docker info >/dev/null 2>&1 || exit 0",
    `for name in ${containerNames.map((name) => tomlString(name)).join(" ")}; do`,
    '  if docker inspect -f "{{.State.Running}}" "$name" 2>/dev/null | grep -qx true; then',
    '    printf "%s\\n" "$name"',
    "  fi",
    "done",
  ].join("\n");
}

export function parseLocalMcpContainerProbeOutput(text) {
  return new Set(
    String(text || "")
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => HOST_LOCAL_MCP_CONTAINERS.has(line)),
  );
}

export function resolveRenderedLocalMcpContainers({ host, localMcpContainers = new Set() } = {}) {
  const rendered = [];
  for (const [containerName, spec] of HOST_LOCAL_MCP_CONTAINERS.entries()) {
    if (!localMcpContainers.has(containerName)) {
      continue;
    }
    if (!spec.required && !hostHasCapability(host, spec.capability)) {
      continue;
    }
    rendered.push(containerName);
  }
  return rendered;
}

export function buildHybridCodexMcpConfigText(configText, {
  connectTimeoutSecs = 8,
  host,
  localMcpContainers = new Set(),
  mcpPreset = "none",
  sharedHostSshTarget = "local",
}) {
  if (normalizeMcpPreset(mcpPreset) === "none") {
    return replaceMcpServerBlocks(configText, "");
  }

  if (!host?.host_id) {
    throw new Error("Hybrid Codex MCP config requires host.host_id");
  }

  const sshPrefix = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=10m",
    "-o",
    "ControlPath=~/.ssh/codex-mcp-%r@%h:%p",
    "-o",
    `ConnectTimeout=${connectTimeoutSecs}`,
    "-T",
    sharedHostSshTarget,
  ];
  const serverSpecs = SHARED_STDIO_MCP_SERVERS.map(([name, commandArgs]) => [
    name,
    {
      command: "ssh",
      args: [...sshPrefix, ...commandArgs],
    },
  ]);

  serverSpecs.push([
    "agent_secret_broker",
    {
      command: "ssh",
      args: [
        ...sshPrefix,
        "docker",
        "exec",
        "-i",
        "agent-secret-broker",
        "node",
        "src/index.js",
      ],
    },
  ]);

  const renderedLocalMcpContainers = new Set(
    resolveRenderedLocalMcpContainers({ host, localMcpContainers }),
  );
  for (const [containerName, spec] of HOST_LOCAL_MCP_CONTAINERS.entries()) {
    if (!renderedLocalMcpContainers.has(containerName)) {
      continue;
    }
    const serverName = spec.name || `${host.host_id}-${spec.suffix}`;
    serverSpecs.push([
      serverName,
      {
        command: "docker",
        args: spec.args,
      },
    ]);
  }

  const renderedMcpText = serverSpecs
    .map(([name, spec]) => renderMcpServerTable(name, spec))
    .join("\n\n");

  return replaceMcpServerBlocks(configText, renderedMcpText);
}

export function validateHybridWorkerMcpConfigText(
  configText,
  hostId,
  { hostCapabilities = null, mcpPreset = "none", sharedHostSshTarget = "local" } = {},
) {
  const text = String(configText || "");
  const blocks = parseMcpServerBlocks(text);
  if (normalizeMcpPreset(mcpPreset) === "none") {
    if (blocks.size === 0) {
      return { ok: true, reason: null };
    }
    return {
      ok: false,
      reason: `MCP preset none should not render MCP entries: ${Array.from(blocks.keys()).join(", ")}`,
    };
  }
  const declaredCapabilities = Array.isArray(hostCapabilities)
    ? new Set(hostCapabilities)
    : null;
  const reservedMcpBlock = Array.from(blocks.entries()).find(([name, block]) =>
    isReservedPitlaneMcpBlock(name, block)
  );
  if (reservedMcpBlock) {
    return {
      ok: false,
      reason: `worker profile must not include reserved or legacy pitlane server: ${reservedMcpBlock[0]}`,
    };
  }

  const missingNames = SHARED_MCP_NAMES.filter(
    (name) => !blocks.has(name),
  );
  if (missingNames.length > 0) {
    return {
      ok: false,
      reason: `missing shared MCP entries: ${missingNames.join(", ")}`,
    };
  }

  const nonSshSharedName = SHARED_MCP_NAMES.find((name) => {
    const block = blocks.get(name);
    return !mcpBlockUsesSharedSshCommand(
      block,
      sharedHostSshTarget,
      SHARED_MCP_COMMAND_ARGS.get(name),
    );
  });
  if (nonSshSharedName) {
    return {
      ok: false,
      reason: `shared MCP entry does not use direct ${sharedHostSshTarget} stdio command: ${nonSshSharedName}`,
    };
  }

  const missingLocalName = Array.from(REQUIRED_LOCAL_MCP_SERVERS.values())
    .find((spec) => !blocks.has(spec.name))?.name;
  if (missingLocalName) {
    return {
      ok: false,
      reason: `missing host-local MCP entry: ${missingLocalName}`,
    };
  }

  const wrongLocalSpec = Array.from(REQUIRED_LOCAL_MCP_SERVERS.values())
    .find((spec) => !mcpBlockUsesLocalDockerCommand(blocks.get(spec.name), spec.args));
  if (wrongLocalSpec) {
    return {
      ok: false,
      reason: `host-local MCP entry does not use local docker command: ${wrongLocalSpec.name}`,
    };
  }

  const stalePrefixedDockerName = Array.from(blocks.keys()).find((name) =>
    /-docker$/u.test(name)
  );
  if (stalePrefixedDockerName) {
    return {
      ok: false,
      reason: `worker docker MCP must be the unqualified host-local entry: ${stalePrefixedDockerName}`,
    };
  }

  const hostLocalName = Array.from(blocks.keys()).find((name) =>
    /-(?:playwright|requests)$/u.test(name) && !name.startsWith(`${hostId}-`)
  );
  if (hostLocalName) {
    return {
      ok: false,
      reason: `host-local MCP entry is not prefixed with ${hostId}: ${hostLocalName}`,
    };
  }

  if (declaredCapabilities) {
    const missingDeclaredOptionalLocalSpec = Array.from(HOST_LOCAL_MCP_CONTAINERS.values())
      .filter((spec) => spec.suffix)
      .find((spec) =>
        declaredCapabilities.has(spec.capability)
        && !blocks.has(`${hostId}-${spec.suffix}`)
      );
    if (missingDeclaredOptionalLocalSpec) {
      return {
        ok: false,
        reason: `missing optional host-local MCP entry for declared host capability: ${hostId}-${missingDeclaredOptionalLocalSpec.suffix}`,
      };
    }

    const undeclaredOptionalLocalSpec = Array.from(HOST_LOCAL_MCP_CONTAINERS.values())
      .filter((spec) => spec.suffix)
      .find((spec) =>
        blocks.has(`${hostId}-${spec.suffix}`)
        && !declaredCapabilities.has(spec.capability)
      );
    if (undeclaredOptionalLocalSpec) {
      return {
        ok: false,
        reason: `optional host-local MCP entry is not declared by host capability: ${hostId}-${undeclaredOptionalLocalSpec.suffix}`,
      };
    }
  }

  const wrongOptionalLocalSpec = Array.from(HOST_LOCAL_MCP_CONTAINERS.values())
    .filter((spec) => spec.suffix)
    .find((spec) => {
      const name = `${hostId}-${spec.suffix}`;
      return blocks.has(name) && !mcpBlockUsesLocalDockerCommand(blocks.get(name), spec.args);
    });
  if (wrongOptionalLocalSpec) {
    return {
      ok: false,
      reason: `optional host-local MCP entry does not use local docker command: ${hostId}-${wrongOptionalLocalSpec.suffix}`,
    };
  }

  return {
    ok: true,
    reason: null,
  };
}

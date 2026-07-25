import path from "node:path";

import {
  buildLocalMcpContainerProbeScript,
  parseLocalMcpContainerProbeOutput,
} from "./codex-mcp-config.js";
import {
  assertReadableDirectory,
  syncLocalDirectoryToHost,
} from "./host-bootstrap-file-sync.js";
import { resolveHostStateRoot } from "./host-bootstrap-paths.js";
import { runHostBash, shellQuote } from "./host-command-runner.js";

const MCP_GATEWAY_RELATIVE_PATH = "tools/mcp-gateway";
const DOCKER_SOCKET_PROXY_RELATIVE_PATH = "tools/docker-socket-proxy";
const MCP_GATEWAY_SYNC_EXCLUDES = [
  ".git/",
  ".env",
  ".env.*",
  "node_modules/",
  "playwright-profile/",
];
const WORKER_LOCAL_ENV_PROTECTS = [".env", ".env.*"];
const DOCKER_SOCKET_PROXY_SYNC_EXCLUDES = [
  ".git/",
  ".env",
  ".env.*",
];

function hostHasCapability(host, capability) {
  return Array.isArray(host?.capabilities) && host.capabilities.includes(capability);
}

function resolveWorkerLocalMcpServices(host) {
  const services = ["mcp-docker"];
  if (hostHasCapability(host, "mcp-requests")) {
    services.push("mcp-requests");
  }
  if (hostHasCapability(host, "mcp-playwright")) {
    services.push("mcp-playwright");
  }
  return services;
}

export async function detectHostLocalMcpContainers({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
}) {
  try {
    const { stdout } = await runHostBash({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      script: buildLocalMcpContainerProbeScript(),
      timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
    });
    return parseLocalMcpContainerProbeOutput(stdout);
  } catch {
    return new Set();
  }
}

export async function ensureHostLocalWorkerMcps({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  maxBufferBytes,
  remoteHomePath,
  remoteBootstrapTimeoutMs,
  sourceWorkspaceRoot,
}) {
  if (!sourceWorkspaceRoot) {
    throw new Error("Host-local MCP bootstrap requires sourceWorkspaceRoot");
  }

  const sourceMcpGatewayPath = path.join(sourceWorkspaceRoot, MCP_GATEWAY_RELATIVE_PATH);
  await assertReadableDirectory(sourceMcpGatewayPath, "MCP gateway source");
  const sourceDockerSocketProxyPath = path.join(
    sourceWorkspaceRoot,
    DOCKER_SOCKET_PROXY_RELATIVE_PATH,
  );
  await assertReadableDirectory(sourceDockerSocketProxyPath, "Docker socket proxy source");

  const remoteMcpGatewayPath = path.posix.join(
    host.workspace_root || "~/workspace",
    MCP_GATEWAY_RELATIVE_PATH,
  );
  const remoteDockerSocketProxyPath = path.posix.join(
    host.workspace_root || "~/workspace",
    DOCKER_SOCKET_PROXY_RELATIVE_PATH,
  );
  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: sourceMcpGatewayPath,
    remotePath: remoteMcpGatewayPath,
    exclude: MCP_GATEWAY_SYNC_EXCLUDES,
    protect: WORKER_LOCAL_ENV_PROTECTS,
    deleteExtra: true,
    deleteExcluded: true,
  });
  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: sourceDockerSocketProxyPath,
    remotePath: remoteDockerSocketProxyPath,
    exclude: DOCKER_SOCKET_PROXY_SYNC_EXCLUDES,
    protect: WORKER_LOCAL_ENV_PROTECTS,
    deleteExtra: true,
    deleteExcluded: true,
  });

  const workerLocalMcpServices = resolveWorkerLocalMcpServices(host);
  const stateRoot = resolveHostStateRoot(host, remoteHomePath);
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    maxBufferBytes,
    script: [
      "set -euo pipefail",
      "expand_path() {",
      '  local value="$1"',
      '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
      '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
      '  printf "%s\\n" "$value"',
      "}",
      `mcp_gateway_path=$(expand_path ${shellQuote(remoteMcpGatewayPath)})`,
      `docker_socket_proxy_path=$(expand_path ${shellQuote(remoteDockerSocketProxyPath)})`,
      `host_root=$(expand_path ${shellQuote(host.workspace_root || "~/workspace")})`,
      `state_root=$(expand_path ${shellQuote(stateRoot)})`,
      `worker_services=(${workerLocalMcpServices.map((name) => shellQuote(name)).join(" ")})`,
      'playwright_state="$state_root/tools/mcp-gateway/playwright-profile"',
      'if [[ " ${worker_services[*]} " == *" mcp-playwright "* ]]; then',
      '  mkdir -p "$playwright_state"',
      '  if ! touch "$playwright_state/.permission-test" >/dev/null 2>&1; then',
      '    sudo -n chown -R "$(id -u):$(id -g)" "$playwright_state"',
      "  fi",
      '  rm -f "$playwright_state/.permission-test"',
      '  chmod u+rwx "$playwright_state"',
      "fi",
      'cd "$mcp_gateway_path"',
      "if ! command -v make >/dev/null 2>&1; then",
      '  echo "make is unavailable" >&2',
      "  exit 1",
      "fi",
      'cd "$docker_socket_proxy_path"',
      "make up",
      "for _ in {1..60}; do",
      "  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' docker-socket-proxy 2>/dev/null || true)",
      '  if [[ "$status" == "healthy" || "$status" == "true" ]]; then',
      '    docker exec docker-socket-proxy wget -qO- http://localhost:2375/_ping >/dev/null',
      '    printf "docker-socket-proxy=%s\\n" "$status"',
      "    break",
      "  fi",
      "  sleep 2",
      "done",
      "status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' docker-socket-proxy 2>/dev/null || true)",
      'if [[ "$status" != "healthy" && "$status" != "true" ]]; then',
      '  docker ps --filter name=docker-socket-proxy --format "table {{.Names}}\\t{{.Status}}" >&2 || true',
      "  exit 1",
      "fi",
      'cd "$mcp_gateway_path"',
      'WORKER_LOCAL_SERVICES="${worker_services[*]}" WORKSPACE_ROOT="$host_root" TELEDEX_STATE_ROOT="$state_root" make worker-local-up',
      "for _ in {1..60}; do",
      "  ready=1",
      '  for service in "${worker_services[@]}"; do',
      "    service_status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' \"$service\" 2>/dev/null || true)",
      '    if [[ "$service_status" != "healthy" && "$service_status" != "true" ]]; then',
      "      ready=0",
      "      break",
      "    fi",
      "  done",
      '  if [[ "$ready" == "1" ]]; then',
      '    for service in "${worker_services[@]}"; do',
      "      service_status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Running}}{{end}}' \"$service\" 2>/dev/null || true)",
      '      printf "%s=%s\\n" "$service" "$service_status"',
      "    done",
      "    exit 0",
      "  fi",
      "  sleep 2",
      "done",
      'docker ps "${worker_services[@]/#/--filter=name=}" --format "table {{.Names}}\\t{{.Status}}" >&2 || true',
      "exit 1",
    ].join("\n"),
    timeoutMs: remoteBootstrapTimeoutMs,
  });
}

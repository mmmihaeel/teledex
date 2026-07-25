import process from "node:process";
import path from "node:path";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { runHostBootstrapRuntime } from "../hosts/host-bootstrap-runtime.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";
import { ensureStateLayout } from "../state/layout.js";

function parseArgs(argv) {
  let hostId = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--host") {
      hostId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown host-bootstrap-runtime arg: ${arg}`);
  }

  return {
    hostId,
    json,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const registryService = new HostRegistryService({
    registryPath: config.hostRegistryPath,
    canonicalRegistryPath: config.hostRegistryCanonicalPath,
    currentHostId: config.currentHostId,
  });
  const result = await runHostBootstrapRuntime({
    connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
    currentHostId: config.currentHostId,
    hostsRoot: layout.hosts,
    registryService,
    rtkPluginMode: config.rtkPluginMode,
    rtkPluginPath: config.rtkPluginPath,
    pitlanePluginMode: config.pitlanePluginMode,
    pitlanePluginPath: config.pitlanePluginPath,
    sourceBinPath: path.isAbsolute(config.codexBinPath)
      ? config.codexBinPath
      : null,
    sourceCodexRoot: path.dirname(config.codexConfigPath),
    sourceStateRoot: config.stateRoot,
    targetHostId: args.hostId,
    sourceWorkspaceRoot: config.workspaceRootPath,
    mcpPreset: config.mcpPreset,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${result.host_id}: ${result.status}`);
  console.log(`node: ${result.probe.node_version || "missing"}`);
  console.log(`codex: ${result.probe.codex_path || "missing"}`);
  const missingTools = Array.isArray(result.operator_toolbelt?.missing)
    ? result.operator_toolbelt.missing
    : [];
  console.log(
    `operator_toolbelt: ${missingTools.length > 0 ? `missing ${missingTools.join(",")}` : "ready"}`,
  );
  if (result.rtk_codex_plugin?.warning) {
    console.warn(`rtk: ${result.rtk_codex_plugin.warning}`);
  }
  if (result.pitlane_codex_plugin?.warning) {
    console.warn(`pitlane: ${result.pitlane_codex_plugin.warning}`);
  }
}

main().catch((error) => {
  console.error(`host runtime bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});

import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";
import { runHostSync } from "../hosts/host-sync.js";
import { ensureStateLayout } from "../state/layout.js";
import {
  setExitCodeForSyncResults,
  syncResultsHaveFailures,
} from "./sync-results.js";

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

    throw new Error(`Unknown registry-sync arg: ${arg}`);
  }

  return {
    hostId,
    json,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const registryService = new HostRegistryService({
    registryPath: config.hostRegistryPath,
    canonicalRegistryPath: config.hostRegistryCanonicalPath,
    currentHostId: config.currentHostId,
  });

  await registryService.syncFromCanonical({ allowStaleFallback: false });
  const results = await runHostSync({
    registryMirrorRoot: config.registryMirrorRoot,
    workspaceSkillsRoot: `${config.workspaceRootPath}/.teledex/workflow-skills`,
    codexSpaceRoot: layout.codexSpace,
    connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
    currentHostId: config.currentHostId,
    hostsRoot: layout.hosts,
    registryService,
    targetHostId: args.hostId,
  });

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    setExitCodeForSyncResults(results);
    return;
  }

  console.log(`registry: ${config.hostRegistryCanonicalPath} -> ${config.hostRegistryPath}`);
  for (const result of results) {
    console.log(`${result.host_id}: ${result.status} (${result.reason || "ok"})`);
  }
  setExitCodeForSyncResults(results);
}

export { syncResultsHaveFailures };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`registry sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

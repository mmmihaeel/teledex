import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { HostRegistryService } from "../hosts/host-registry-service.js";

function parseArgs(argv) {
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new Error(`Unknown host-bootstrap arg: ${arg}`);
  }

  return {
    json,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  const registryService = new HostRegistryService({
    registryPath: config.hostRegistryPath,
    canonicalRegistryPath: config.hostRegistryCanonicalPath,
    currentHostId: config.currentHostId,
  });
  const registry = await registryService.syncFromCanonical({ allowStaleFallback: false });
  const hosts = registry.hosts;

  if (args.json) {
    console.log(JSON.stringify({
      registry: config.hostRegistryCanonicalPath,
      hosts,
    }, null, 2));
    return;
  }

  console.log(`registry: ${config.hostRegistryCanonicalPath} -> ${config.hostRegistryPath}`);
  console.log(`hosts: ${hosts.map((host) => host.host_id).join(", ")}`);
}

main().catch((error) => {
  console.error(`host bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});

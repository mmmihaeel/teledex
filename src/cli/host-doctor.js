import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  hostDoctorResultsHaveFailures,
  resolveCodexSpaceFreshnessMaxAgeSecs,
  runHostDoctor,
} from "../hosts/host-doctor.js";
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

    throw new Error(`Unknown host-doctor arg: ${arg}`);
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
  const results = await runHostDoctor({
    codexSpaceMaxAgeSecs: resolveCodexSpaceFreshnessMaxAgeSecs(
      config.hostSyncIntervalMinutes,
    ),
    codexSpaceRoot: layout.codexSpace,
    connectTimeoutSecs: config.hostSshConnectTimeoutSecs,
    currentHostId: config.currentHostId,
    hostsRoot: layout.hosts,
    mcpPreset: config.mcpPreset,
    registryService,
    targetHostId: args.hostId,
  });

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    if (hostDoctorResultsHaveFailures(results)) {
      process.exitCode = 1;
    }
    return;
  }

  for (const result of results) {
    const failedCheck = Array.isArray(result.snapshot.checks)
      ? result.snapshot.checks.find(
          (check) => check.id === result.snapshot.failure_reason,
        )
      : null;
    const warnings = Array.isArray(result.snapshot.warnings)
      ? result.snapshot.warnings
      : [];
    const detailSource = failedCheck || warnings[0];
    const detail = detailSource?.detail ? ` - ${detailSource.detail}` : "";
    const warningText = warnings.length > 0
      ? ` warn:${warnings.map((warning) => warning.id).join(",")}`
      : "";
    console.log(
      `${result.snapshot.host_id}: ${result.snapshot.status} (${result.snapshot.failure_reason || "ok"})${warningText}${detail}`,
    );
  }
  if (hostDoctorResultsHaveFailures(results)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`host doctor failed: ${error.message}`);
  process.exitCode = 1;
});

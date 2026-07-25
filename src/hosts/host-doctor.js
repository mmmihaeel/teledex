import path from "node:path";
import { execFile } from "node:child_process";

import { writeTextAtomic } from "../state/file-utils.js";
import {
  buildCodexExecHelpScript,
  buildCodexPitlaneCleanupScript,
  buildCodexPluginHooksTrustedScript,
  buildCodexRtkPluginReadinessScript,
  buildDockerRuntimeScript,
  buildExistsScript,
  buildHostLocalDockerMcpScript,
  buildHostLocalMcpContainerScript,
  buildHostLocalPitlaneScript,
  buildJsonTimestampFreshnessScript,
  buildOperatorToolbeltScript,
  buildSupportedNodeRuntimeScript,
  buildWorkerMcpConfigScript,
  resolveCodexSpaceFreshnessMaxAgeSecs,
} from "./host-doctor/check-scripts.js";
import { ensureCodexSpaceLayout, getCodexSpaceLayout } from "./teledex-context.js";
import { runHostBash } from "./host-command-runner.js";

export {
  buildCodexPitlaneCleanupScript,
  buildCodexPluginHooksTrustedScript,
  buildWorkerMcpConfigScript,
  resolveCodexSpaceFreshnessMaxAgeSecs,
} from "./host-doctor/check-scripts.js";

const NON_BLOCKING_CHECK_IDS = new Set(["sudo"]);

function buildCheck(id, label, ok, detail = null) {
  return {
    id,
    label,
    ok,
    detail,
  };
}

function hostRequiresDocker(host) {
  if (Array.isArray(host?.required_capabilities)) {
    return host.required_capabilities.includes("docker");
  }

  return host?.mcp_mode === "local";
}

function hostHasCapability(host, capability) {
  return Array.isArray(host?.capabilities) && host.capabilities.includes(capability);
}

function hostShouldCheckLocalDockerMcp(host, currentHostId) {
  return host?.mcp_mode === "local"
    || host?.host_id !== currentHostId
    || hostHasCapability(host, "mcp-docker")
    || hostRequiresDocker(host);
}

async function runDoctorCheck({
  host,
  currentHostId,
  connectTimeoutSecs,
  execFileImpl,
  label,
  id,
  script,
}) {
  try {
    await runHostBash({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      script,
      timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
    });
    return buildCheck(id, label, true);
  } catch (error) {
    return buildCheck(
      id,
      label,
      false,
      String(error?.stderr || error?.message || "check failed").trim() || null,
    );
  }
}

export async function inspectHostReadiness({
  codexSpaceMaxAgeSecs = resolveCodexSpaceFreshnessMaxAgeSecs(),
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  host,
  mcpPreset = "none",
  sharedHostSshTarget = "local",
}) {
  const checkedAt = new Date().toISOString();
  const checks = [];

  if (host.enabled === false) {
    return {
      checked_at: checkedAt,
      host_id: host.host_id,
      host_label: host.label || host.host_id,
      ready: false,
      status: "disabled",
      failure_reason: host.failure_reason || "host-disabled",
      checks: [
        buildCheck("enabled", "host is enabled", false, "host disabled in registry"),
      ],
    };
  }

  if (host.host_id !== currentHostId && !host.ssh_target) {
    return {
      checked_at: checkedAt,
      host_id: host.host_id,
      host_label: host.label || host.host_id,
      ready: false,
      status: "not-ready",
      failure_reason: "missing-ssh-target",
      checks: [
        buildCheck("ssh", "SSH alias is reachable", false, "ssh_target is missing"),
      ],
    };
  }

  const hostCodexSpaceRoot = `${host.worker_runtime_root || ""}/teledex-context`;
  const hostHealthPath = path.posix.join(
    hostCodexSpaceRoot,
    "hosts",
    host.host_id,
    "rendered",
    "health.json",
  );
  const sharedManifestPath = path.posix.join(
    hostCodexSpaceRoot,
    "shared",
    "rendered",
    "manifest.json",
  );
  const sharedReminderPath = path.posix.join(
    hostCodexSpaceRoot,
    "shared",
    "rendered",
    "fleet-reminder.txt",
  );

  if (host.host_id !== currentHostId && hostRequiresDocker(host)) {
    checks.push(
      await runDoctorCheck({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        id: "ssh",
        label: "SSH alias is reachable",
        script: "true",
      }),
    );
  }

  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "sudo",
      label: "sudo -n true works",
      script: "sudo -n true",
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "operator-toolbelt",
      label: "operator CLI toolbelt is installed",
      script: buildOperatorToolbeltScript(),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-rtk-plugin",
      label: "Codex RTK plugin is installed and enabled",
      script: buildCodexRtkPluginReadinessScript(host.codex_config_path),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "host-local-pitlane",
      label: "host-local pitlane CLI is available",
      script: buildHostLocalPitlaneScript(),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "workspace-root",
      label: "workspace root exists",
      script: buildExistsScript("d", host.workspace_root),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "repo-root",
      label: "repo root exists",
      script: buildExistsScript("d", host.repo_root),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "runtime-root",
      label: "worker runtime root exists",
      script: buildExistsScript("d", host.worker_runtime_root),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "node-bin",
      label: "node runtime supports exec-json helpers",
      script: buildSupportedNodeRuntimeScript(),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-bin",
      label: "codex exec is available",
      script: buildCodexExecHelpScript(host.codex_bin_path),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-config",
      label: "codex config exists",
      script: buildExistsScript("f", host.codex_config_path),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-pitlane-cleanup",
      label: "codex config has standalone pitlane cleanup",
      script: buildCodexPitlaneCleanupScript(host.codex_config_path),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-plugin-hooks-trusted",
      label: "Codex plugin hooks are trusted and executable",
      script: buildCodexPluginHooksTrustedScript(host.codex_config_path),
    }),
  );
  if (host.host_id !== currentHostId) {
    checks.push(
      await runDoctorCheck({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        id: "codex-mcp-profile",
        label: mcpPreset === "none"
          ? "worker Codex MCP profile has no workspace MCPs"
          : "worker Codex MCP profile uses shared hub plus host-local MCPs",
        script: buildWorkerMcpConfigScript(
          host.codex_config_path,
          host.host_id,
          host.capabilities,
          sharedHostSshTarget,
          { mcpPreset },
        ),
      }),
    );
  }
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "codex-auth",
      label: "codex auth exists",
      script: buildExistsScript("f", host.codex_auth_path),
    }),
  );
  if (hostRequiresDocker(host)) {
    checks.push(
      await runDoctorCheck({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        id: "docker",
        label: "docker runtime is ready",
        script: buildDockerRuntimeScript(),
      }),
    );
  }
  if (mcpPreset !== "none" && hostShouldCheckLocalDockerMcp(host, currentHostId)) {
    checks.push(
      await runDoctorCheck({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host,
        id: "host-local-docker-mcp",
        label: "host-local docker MCP is ready",
        script: buildHostLocalDockerMcpScript(),
      }),
    );
    if (hostHasCapability(host, "mcp-requests")) {
      checks.push(
        await runDoctorCheck({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host,
          id: "host-local-requests",
          label: "host-local requests MCP is ready",
          script: buildHostLocalMcpContainerScript("mcp-requests"),
        }),
      );
    }
    if (hostHasCapability(host, "mcp-playwright")) {
      checks.push(
        await runDoctorCheck({
          connectTimeoutSecs,
          currentHostId,
          execFileImpl,
          host,
          id: "host-local-playwright",
          label: "host-local playwright MCP is ready",
          script: buildHostLocalMcpContainerScript("mcp-playwright"),
        }),
      );
    }
  }
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "shared-teledex-context",
      label: "shared teledex-context was synced",
      script: buildExistsScript("f", sharedReminderPath),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "shared-teledex-context-fresh",
      label: "shared teledex-context is fresh",
      script: buildJsonTimestampFreshnessScript(sharedManifestPath, {
        maxAgeSecs: codexSpaceMaxAgeSecs,
      }),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "host-teledex-context",
      label: "host teledex-context was synced",
      script: buildExistsScript("f", hostHealthPath),
    }),
  );
  checks.push(
    await runDoctorCheck({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      id: "host-teledex-context-fresh",
      label: "host teledex-context is fresh",
      script: buildJsonTimestampFreshnessScript(hostHealthPath, {
        maxAgeSecs: codexSpaceMaxAgeSecs,
      }),
    }),
  );

  const warningChecks = checks.filter(
    (check) => check.ok === false && NON_BLOCKING_CHECK_IDS.has(check.id),
  );
  const failedCheck = checks.find(
    (check) => check.ok === false && !NON_BLOCKING_CHECK_IDS.has(check.id),
  );
  return {
    generated_at: checkedAt,
    checked_at: checkedAt,
    host_id: host.host_id,
    host_label: host.label || host.host_id,
    ready: !failedCheck,
    status: failedCheck ? "not-ready" : "ready",
    failure_reason: failedCheck ? failedCheck.id : null,
    warnings: warningChecks.map((check) => ({
      id: check.id,
      label: check.label,
      detail: check.detail,
    })),
    checks,
  };
}

export async function runHostDoctor({
  codexSpaceMaxAgeSecs = resolveCodexSpaceFreshnessMaxAgeSecs(),
  codexSpaceRoot,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  mcpPreset = "none",
  registryService,
  targetHostId = null,
}) {
  const hosts = await registryService.listHosts({ allowStaleFallback: false });
  const currentHost = hosts.find((host) => host.host_id === currentHostId);
  const sharedHostSshTarget = currentHost?.ssh_target || currentHostId;
  const selectedHosts = targetHostId
    ? hosts.filter((host) => host.host_id === targetHostId)
    : hosts;

  if (selectedHosts.length === 0) {
    throw new Error(`Unknown host for doctor: ${targetHostId}`);
  }

  await ensureCodexSpaceLayout(
    codexSpaceRoot,
    selectedHosts.map((host) => host.host_id),
  );

  const results = [];
  for (const host of selectedHosts) {
    const snapshot = await inspectHostReadiness({
      codexSpaceRoot,
      codexSpaceMaxAgeSecs,
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      mcpPreset,
      sharedHostSshTarget,
    });
    const hostLayout = getCodexSpaceLayout(codexSpaceRoot, host.host_id);
    const snapshotPath = path.join(hostsRoot, "doctor", `${host.host_id}.json`);
    await writeTextAtomic(
      snapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    await writeTextAtomic(
      path.join(hostLayout.hostRendered, "health.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );

    const updatedHost = await registryService.patchHost(host.host_id, {
      last_health: snapshot.status,
      last_health_checked_at: snapshot.checked_at,
      last_ready_at: snapshot.ready
        ? snapshot.checked_at
        : host.last_ready_at ?? null,
      failure_reason: snapshot.failure_reason,
    });
    results.push({
      host: updatedHost,
      snapshot,
      snapshot_path: snapshotPath,
    });
  }

  return results;
}

export function hostDoctorResultsHaveFailures(results) {
  return Array.isArray(results)
    && results.some((result) => result?.snapshot?.ready === false);
}

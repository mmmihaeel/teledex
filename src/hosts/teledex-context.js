import path from "node:path";

import { ensurePrivateDirectory, writeTextAtomic } from "../state/file-utils.js";
import { expandHostHomePath } from "./host-paths.js";

export function getCodexSpaceLayout(codexSpaceRoot, hostId = null) {
  const root = codexSpaceRoot;
  const sharedRoot = path.join(root, "shared");
  const sharedSource = path.join(sharedRoot, "source");
  const sharedRendered = path.join(sharedRoot, "rendered");
  const hostsRoot = path.join(root, "hosts");
  const hostRoot = hostId ? path.join(hostsRoot, hostId) : null;

  return {
    root,
    sharedRoot,
    sharedSource,
    sharedRendered,
    hostsRoot,
    hostRoot,
    hostSource: hostRoot ? path.join(hostRoot, "source") : null,
    hostRendered: hostRoot ? path.join(hostRoot, "rendered") : null,
  };
}

export async function ensureCodexSpaceLayout(codexSpaceRoot, hostIds = []) {
  const layout = getCodexSpaceLayout(codexSpaceRoot);
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.sharedRoot);
  await ensurePrivateDirectory(layout.sharedSource);
  await ensurePrivateDirectory(layout.sharedRendered);
  await ensurePrivateDirectory(layout.hostsRoot);

  for (const hostId of hostIds) {
    const hostLayout = getCodexSpaceLayout(codexSpaceRoot, hostId);
    await ensurePrivateDirectory(hostLayout.hostRoot);
    await ensurePrivateDirectory(hostLayout.hostSource);
    await ensurePrivateDirectory(hostLayout.hostRendered);
  }

  return layout;
}

function buildWorkspaceHostReminder({ currentHostId, hosts }) {
  const enabledHosts = hosts
    .filter((host) => host.enabled !== false)
    .map((host) => host.host_id);

  return [
    `Current controller host: ${currentHostId}`,
    `Known hosts: ${hosts.map((host) => host.host_id).join(", ") || "none"}`,
    `Enabled hosts: ${enabledHosts.join(", ") || "none"}`,
    "Execution host bindings are immutable per topic.",
    "If a bound host is unavailable, fail closed and say which host is unavailable.",
  ].join("\n");
}

function buildOperatorReminder() {
  return [
    "Workspace preferences:",
    "- Avoid overengineering.",
    "- Prefer practical, low-overhead, modular solutions.",
    "- Prioritize efficiency, modularity, security, autonomy, and usability.",
    "- Keep communication concise, direct, and human-readable.",
    "- Preserve host boundaries; shared memory supplements host-local runtime only.",
    "- If a bound host is unavailable, fail closed and say which host is unavailable.",
    "- Use workspace skills and their references for workflows, project registry resolve for structured workspace facts, and targeted host tools for live state.",
    "- Project/service metadata lives in co-located project.toml manifests in owning source directories.",
    "- project registry host and mount metadata comes from the configured project registry host config.",
    "- project.toml ids are host-scoped; repeated logical ids across hosts are expected for shared tracked repos, and project registry disambiguates by derived host/path.",
    "- Dormant shared docs/templates/bootstrap notes are source-maintenance surfaces only, not workflow memory or project/service metadata.",
    "- For project/service metadata changes, use project registry resolve first, edit the owning project.toml on the host/path project registry reports, then commit/push that owning repo. Do not edit skill references or dormant shared docs as a proxy.",
  ].join("\n");
}

function buildHostPromptSnippet(host) {
  const workspaceRoot = expandHostHomePath(host.workspace_root, host);
  const repoRoot = expandHostHomePath(host.repo_root, host);
  const runtimeRoot = expandHostHomePath(host.worker_runtime_root, host);

  return [
    `Execution host: ${host.host_id}`,
    `Label: ${host.label || host.host_id}`,
    `Role: ${host.role || "unspecified"}`,
    `Workspace root: ${workspaceRoot || "unset"}`,
    `Repo root: ${repoRoot || "unset"}`,
    `Runtime root: ${runtimeRoot || "unset"}`,
    `Profile: ${host.profile_id || "unset"}`,
    `Suffix preset: ${host.suffix_id || host.host_id}`,
    "This host keeps its own local Codex auth, config, and runtime state.",
  ].join("\n");
}

const HOST_PATH_FIELDS = [
  "workspace_root",
  "repo_root",
  "default_binding_path",
  "worker_runtime_root",
  "codex_bin_path",
  "codex_config_path",
  "codex_auth_path",
];

function resolveRenderedPathField(value, host) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const expanded = expandHostHomePath(normalized, host);
  if (expanded) {
    return expanded;
  }

  return normalized.startsWith("~") ? null : normalized;
}

function buildRenderedHostProfile(host) {
  const rendered = {
    ...host,
    home_path: expandHostHomePath("~", host),
  };

  for (const field of HOST_PATH_FIELDS) {
    rendered[field] = resolveRenderedPathField(host[field], host);
  }

  return rendered;
}

function buildHostHealthSnapshot(host, generatedAt) {
  return {
    generated_at: generatedAt,
    host_id: host.host_id,
    label: host.label,
    status: host.last_health || "unknown",
    checked_at: host.last_health_checked_at || null,
    last_ready_at: host.last_ready_at || null,
    failure_reason: host.failure_reason || null,
  };
}

export async function renderCodexSpace({
  codexSpaceRoot,
  currentHostId,
  hosts,
}) {
  const hostIds = hosts.map((host) => host.host_id);
  const generatedAt = new Date().toISOString();
  const layout = await ensureCodexSpaceLayout(codexSpaceRoot, hostIds);
  const fleetMapPath = path.join(layout.sharedRendered, "fleet-map.json");
  const fleetReminderPath = path.join(layout.sharedRendered, "fleet-reminder.txt");
  const operatorReminderPath = path.join(layout.sharedRendered, "workspace-reminder.txt");
  const manifestPath = path.join(layout.sharedRendered, "manifest.json");

  await writeTextAtomic(
    fleetMapPath,
    `${JSON.stringify({
      current_host_id: currentHostId,
      generated_at: generatedAt,
      hosts: hosts.map((host) => buildRenderedHostProfile(host)),
    }, null, 2)}\n`,
  );
  await writeTextAtomic(
    fleetReminderPath,
    `${buildWorkspaceHostReminder({ currentHostId, hosts })}\n`,
  );
  await writeTextAtomic(
    operatorReminderPath,
    `${buildOperatorReminder()}\n`,
  );
  await writeTextAtomic(
    manifestPath,
    `${JSON.stringify({
      generated_at: generatedAt,
      current_host_id: currentHostId,
      host_ids: hostIds,
    }, null, 2)}\n`,
  );

  const files = [
    fleetMapPath,
    fleetReminderPath,
    operatorReminderPath,
    manifestPath,
  ];

  for (const host of hosts) {
    const renderedProfile = buildRenderedHostProfile(host);
    const hostLayout = getCodexSpaceLayout(codexSpaceRoot, host.host_id);
    const profilePath = path.join(hostLayout.hostRendered, "profile.json");
    const promptSnippetPath = path.join(hostLayout.hostRendered, "host-context.txt");
    const healthPath = path.join(hostLayout.hostRendered, "health.json");

    await writeTextAtomic(
      profilePath,
      `${JSON.stringify(renderedProfile, null, 2)}\n`,
    );
    await writeTextAtomic(
      promptSnippetPath,
      `${buildHostPromptSnippet(host)}\n`,
    );
    await writeTextAtomic(
      healthPath,
      `${JSON.stringify(buildHostHealthSnapshot(host, generatedAt), null, 2)}\n`,
    );

    files.push(profilePath, promptSnippetPath, healthPath);
  }

  return {
    files,
    layout,
  };
}

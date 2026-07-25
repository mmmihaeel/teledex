import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { RuntimeObserver } from "../runtime/runtime-observer.js";
import { resolveExecutablePathSync } from "../runtime/executable-path.js";
import { ServiceGenerationStore } from "../runtime/service-generation-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { SessionAdmin, buildSessionCounts } from "../session-manager/session-admin.js";
import { SessionStore } from "../session-manager/session-store.js";
import { RolloutCoordinationStore } from "../session-manager/rollout-coordination-store.js";

const HEARTBEAT_STALE_MIN_MS = 60_000;

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

function parseIntegerFlag(name, value) {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Expected ${name} to be a positive integer, got: ${value}`);
  }

  return Number(value);
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parseSelector(args) {
  if (args.length === 1 && args[0].includes(":")) {
    const [chatId, topicId] = args[0].split(":");
    if (!chatId || !topicId) {
      throw new Error("Expected selector as <chat_id>:<topic_id>");
    }

    return { chatId, topicId };
  }

  if (args.length >= 2) {
    return {
      chatId: args[0],
      topicId: args[1],
    };
  }

  throw new Error("Expected <chat_id> <topic_id> or <chat_id>:<topic_id>");
}

function parseAdminArgs(argv) {
  const options = {
    command: argv[0] || "status",
    args: [],
    json: false,
    state: null,
    limit: null,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }

    if (token === "--state") {
      index += 1;
      options.state = argv[index] || null;
      continue;
    }

    if (token.startsWith("--state=")) {
      options.state = token.slice("--state=".length) || null;
      continue;
    }

    if (token === "--limit") {
      index += 1;
      options.limit = parseIntegerFlag("--limit", argv[index] || "");
      continue;
    }

    if (token.startsWith("--limit=")) {
      options.limit = parseIntegerFlag(
        "--limit",
        token.slice("--limit=".length),
      );
      continue;
    }

    options.args.push(token);
  }

  return options;
}

async function readJsonIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return null;
  }
}

export function summarizeHeartbeat(
  heartbeat,
  {
    nowMs = Date.now(),
    pollTimeoutSecs = 30,
  } = {},
) {
  if (!heartbeat || typeof heartbeat !== "object") {
    return {
      observedAt: null,
      lifecycleState: "unknown",
      activeRunCount: 0,
      lastUpdateId: null,
      lastCommandName: null,
      mode: null,
      stale: true,
      fresh: false,
      pidAlive: null,
    };
  }

  const observedAt = heartbeat.observed_at || null;
  const observedMs = Date.parse(observedAt || "");
  const staleAfterMs = Math.max(
    HEARTBEAT_STALE_MIN_MS,
    Number.isFinite(pollTimeoutSecs) && pollTimeoutSecs > 0
      ? Math.trunc(pollTimeoutSecs * 3000)
      : HEARTBEAT_STALE_MIN_MS,
  );
  const stale =
    !Number.isFinite(observedMs) || nowMs - observedMs > staleAfterMs;
  const pidAlive = isPidAlive(heartbeat.pid);
  const lifecycleState =
    stale || pidAlive === false
      ? "stale"
      : heartbeat.lifecycle_state || "unknown";

  return {
    observedAt,
    lifecycleState,
    activeRunCount: heartbeat.service_state?.active_run_count ?? 0,
    lastUpdateId: heartbeat.service_state?.last_update_id ?? null,
    lastCommandName: heartbeat.service_state?.last_command_name ?? null,
    mode: heartbeat.mode ?? null,
    generationId: heartbeat.generation?.id ?? null,
    generationIsLeader: heartbeat.generation?.is_leader ?? null,
    generationRetiring: heartbeat.generation?.retiring ?? null,
    rolloutStatus: heartbeat.generation?.rollout_status ?? null,
    stale,
    fresh: !stale,
    pidAlive,
  };
}

export function summarizeRolloutState(
  state,
  {
    heartbeatSummary = null,
    retiringGenerationLive = null,
    liveRetainedGenerationIds = [],
    liveRetainedSessionKeys = [],
    liveRetiringGenerationIds = [],
  } = {},
) {
  const status = normalizeOptionalText(state?.status) || "idle";
  const currentGenerationId = normalizeOptionalText(state?.current_generation_id);
  const targetGenerationId = normalizeOptionalText(state?.target_generation_id);
  const retiringGenerationId = normalizeOptionalText(state?.retiring_generation_id);
  const liveGenerationId = normalizeOptionalText(heartbeatSummary?.generationId);
  const retainedSessionKeys = Array.isArray(state?.retained_session_keys)
    ? state.retained_session_keys.map((entry) => normalizeOptionalText(entry)).filter(Boolean)
    : [];
  const normalizedLiveRetainedSessionKeys = Array.isArray(liveRetainedSessionKeys)
    ? liveRetainedSessionKeys.map((entry) => normalizeOptionalText(entry)).filter(Boolean)
    : [];
  const normalizedLiveRetiringGenerationIds = Array.isArray(liveRetiringGenerationIds)
    ? liveRetiringGenerationIds.map((entry) => normalizeOptionalText(entry)).filter(Boolean)
    : [];
  const normalizedLiveRetainedGenerationIds = Array.isArray(liveRetainedGenerationIds)
    ? liveRetainedGenerationIds.map((entry) => normalizeOptionalText(entry)).filter(Boolean)
    : [];
  const effectiveRetainedSessionKeys = [
    ...new Set([
      ...retainedSessionKeys,
      ...normalizedLiveRetainedSessionKeys,
    ]),
  ].sort();
  const trafficShifted =
    status === "completed"
    || Boolean(targetGenerationId && liveGenerationId === targetGenerationId);

  return {
    status,
    current_generation_id: currentGenerationId,
    target_generation_id: targetGenerationId,
    retiring_generation_id: retiringGenerationId,
    traffic_shifted: trafficShifted,
    retiring_generation_live: retiringGenerationLive,
    retained_session_count: effectiveRetainedSessionKeys.length,
    retained_session_keys: effectiveRetainedSessionKeys,
    coordination_retained_session_count: retainedSessionKeys.length,
    coordination_retained_session_keys: retainedSessionKeys,
    live_retiring_generation_count: normalizedLiveRetiringGenerationIds.length,
    live_retiring_generation_ids: normalizedLiveRetiringGenerationIds,
    live_retained_generation_count: normalizedLiveRetainedGenerationIds.length,
    live_retained_generation_ids: normalizedLiveRetainedGenerationIds,
    live_retained_session_count: normalizedLiveRetainedSessionKeys.length,
    live_retained_session_keys: normalizedLiveRetainedSessionKeys,
    requested_at: normalizeOptionalText(state?.requested_at),
    started_at: normalizeOptionalText(state?.started_at),
    finished_at: normalizeOptionalText(state?.finished_at),
    last_error: normalizeOptionalText(state?.last_error),
  };
}

export async function collectLiveRetainedRolloutState({
  currentGenerationId = null,
  generationStore,
  sessions = [],
} = {}) {
  if (
    !generationStore
    || typeof generationStore.listGenerations !== "function"
    || typeof generationStore.isGenerationRecordVerifiablyLive !== "function"
  ) {
    return {
      liveRetainedGenerationIds: [],
      liveRetainedSessionKeys: [],
      liveRetiringGenerationIds: [],
    };
  }

  const currentId = normalizeOptionalText(currentGenerationId);
  const liveRetainedGenerationIds = new Set();
  const liveGenerationIds = new Set();
  const generations = await generationStore.listGenerations();
  await Promise.all(
    generations.map(async (record) => {
      const generationId = normalizeOptionalText(record?.generation_id);
      if (!generationId || generationId === currentId || record?.mode !== "retiring") {
        return;
      }
      if (await generationStore.isGenerationRecordVerifiablyLive(record)) {
        liveGenerationIds.add(generationId);
      }
    }),
  );

  const isLiveForeignGeneration = async (generationId) => {
    const normalizedGenerationId = normalizeOptionalText(generationId);
    if (!normalizedGenerationId || normalizedGenerationId === currentId) {
      return false;
    }
    if (liveGenerationIds.has(normalizedGenerationId)) {
      liveRetainedGenerationIds.add(normalizedGenerationId);
      return true;
    }
    if (typeof generationStore.loadGeneration !== "function") {
      return false;
    }
    const record = await generationStore.loadGeneration(normalizedGenerationId);
    if (await generationStore.isGenerationRecordVerifiablyLive(record)) {
      liveRetainedGenerationIds.add(normalizedGenerationId);
      if (record?.mode === "retiring") {
        liveGenerationIds.add(normalizedGenerationId);
      }
      return true;
    }
    return false;
  };

  const liveRetainedSessionKeys = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (
      session?.lifecycle_state !== "active"
      || session?.last_run_status !== "running"
      || !session?.session_key
    ) {
      continue;
    }
    const ownerGenerationId =
      normalizeOptionalText(session.session_owner_generation_id)
      ?? normalizeOptionalText(session.agent_run_owner_generation_id);
    if (await isLiveForeignGeneration(ownerGenerationId)) {
      liveRetainedSessionKeys.push(session.session_key);
    }
  }

  return {
    liveRetainedGenerationIds: [...liveRetainedGenerationIds].sort(),
    liveRetainedSessionKeys: [...new Set(liveRetainedSessionKeys)].sort(),
    liveRetiringGenerationIds: [...liveGenerationIds].sort(),
  };
}

export function resolveCodexBinPathForStatus(config = {}) {
  try {
    return resolveExecutablePathSync(config.codexBinPath, {
      cwd: config.repoRoot,
    });
  } catch {
    return config.codexBinPath || null;
  }
}

function createCliRuntimeObserver({ logsDir, config }) {
  return new RuntimeObserver({
    logsDir,
    config,
    serviceState: {
      startedAt: null,
      botId: null,
      botUsername: null,
      handledUpdates: 0,
      ignoredUpdates: 0,
      handledCommands: 0,
      acceptedPrompts: 0,
      pollErrors: 0,
      knownSessions: 0,
      activeRunCount: 0,
      lastUpdateId: null,
      lastCommandName: null,
      lastCommandAt: null,
      lastPromptAt: null,
      bootstrapDroppedUpdateId: null,
    },
    probe: {
      me: {
        first_name: null,
      },
    },
    mode: "admin",
  });
}

function formatSessionLine(session) {
  const parts = [
    session.session_key,
    `[${session.lifecycle_state}]`,
    `updated=${session.updated_at || "unknown"}`,
  ];

  if (session.topic_name) {
    parts.push(`topic=${JSON.stringify(session.topic_name)}`);
  }
  if (session.retention_pin) {
    parts.push("pinned=true");
  }
  if (session.purge_after) {
    parts.push(`purge_after=${session.purge_after}`);
  }
  if (session.workspace_binding?.cwd) {
    parts.push(`cwd=${session.workspace_binding.cwd}`);
  }

  return parts.join(" ");
}

function buildStatusReport({
  heartbeat,
  counts,
  config,
  liveRetainedGenerationIds = [],
  liveRetainedSessionKeys = [],
  liveRetiringGenerationIds = [],
  rolloutState = null,
  retiringGenerationLive = null,
}) {
  const heartbeatSummary = summarizeHeartbeat(heartbeat, {
    pollTimeoutSecs: config.telegramPollTimeoutSecs,
  });
  const resolvedCodexBinPath = resolveCodexBinPathForStatus(config);
  const rollout = summarizeRolloutState(rolloutState, {
    heartbeatSummary,
    liveRetainedGenerationIds,
    liveRetainedSessionKeys,
    liveRetiringGenerationIds,
    retiringGenerationLive,
  });
  return {
    heartbeat: heartbeat
      ? {
          observed_at: heartbeatSummary.observedAt,
          lifecycle_state: heartbeatSummary.lifecycleState,
          active_run_count: heartbeatSummary.activeRunCount,
          last_update_id: heartbeatSummary.lastUpdateId,
          last_command_name: heartbeatSummary.lastCommandName,
          mode: heartbeatSummary.mode,
          generation_id: heartbeatSummary.generationId,
          generation_is_leader: heartbeatSummary.generationIsLeader,
          generation_retiring: heartbeatSummary.generationRetiring,
          rollout_status: heartbeatSummary.rolloutStatus,
          fresh: heartbeatSummary.fresh,
          stale: heartbeatSummary.stale,
          pid_alive: heartbeatSummary.pidAlive,
        }
      : null,
    codex: {
      backend: config.codexGatewayBackend,
      bin_path: resolvedCodexBinPath,
      configured_bin_path: config.codexBinPath,
      config_path: config.codexConfigPath,
      mcp_servers: Array.isArray(config.codexMcpServerNames)
        ? config.codexMcpServerNames
        : [],
    },
    rollout,
    sessions: counts,
  };
}

async function runStatus({ sessionAdmin, layout, config, json }) {
  const sessions = await sessionAdmin.listSessions();
  const counts = buildSessionCounts(sessions);
  const heartbeat = await readJsonIfExists(
    path.join(layout.logs, "runtime-heartbeat.json"),
  );
  const heartbeatSummary = summarizeHeartbeat(heartbeat, {
    pollTimeoutSecs: config.telegramPollTimeoutSecs,
  });
  const rolloutCoordinationStore = new RolloutCoordinationStore(layout.settings);
  const rolloutState = await rolloutCoordinationStore.load({ force: true });
  const generationStore = new ServiceGenerationStore({
    indexesRoot: layout.indexes,
    tmpRoot: layout.tmp,
    serviceKind: "agent",
    generationId: "admin",
  });
  const retiringGenerationId = normalizeOptionalText(
    rolloutState?.retiring_generation_id,
  );
  let retiringGenerationLive = null;
  if (retiringGenerationId) {
    const retiringGeneration = await generationStore.loadGeneration(
      retiringGenerationId,
    );
    retiringGenerationLive =
      await generationStore.isGenerationRecordVerifiablyLive(retiringGeneration);
  }
  const liveRetainedRollout = await collectLiveRetainedRolloutState({
    currentGenerationId: heartbeatSummary.generationId,
    generationStore,
    sessions,
  });
  const rolloutSummary = summarizeRolloutState(rolloutState, {
    heartbeatSummary,
    ...liveRetainedRollout,
    retiringGenerationLive,
  });
  const resolvedCodexBinPath = resolveCodexBinPathForStatus(config);
  const report = buildStatusReport({
    heartbeat,
    counts,
    config,
    ...liveRetainedRollout,
    rolloutState,
    retiringGenerationLive,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printLine(
    "service_state",
    heartbeatSummary.lifecycleState,
  );
  printLine(
    "heartbeat_observed_at",
    heartbeatSummary.observedAt || "missing",
  );
  printLine(
    "heartbeat_fresh",
    String(heartbeatSummary.fresh),
  );
  printLine(
    "heartbeat_pid_alive",
    heartbeatSummary.pidAlive === null ? "unknown" : String(heartbeatSummary.pidAlive),
  );
  printLine(
    "active_run_count",
    String(heartbeatSummary.activeRunCount),
  );
  printLine(
    "last_update_id",
    heartbeatSummary.lastUpdateId ?? "none",
  );
  printLine("codex_backend", config.codexGatewayBackend || "unknown");
  printLine("codex_bin_path", resolvedCodexBinPath || "unknown");
  printLine("codex_configured_bin_path", config.codexBinPath || "unknown");
  printLine("codex_config_path", config.codexConfigPath || "unknown");
  printLine(
    "codex_mcp_servers",
    Array.isArray(config.codexMcpServerNames) && config.codexMcpServerNames.length > 0
      ? config.codexMcpServerNames.join(",")
      : "none",
  );
  printLine("rollout_status", rolloutSummary.status);
  printLine("rollout_traffic_shifted", String(rolloutSummary.traffic_shifted));
  printLine("rollout_current_generation", rolloutSummary.current_generation_id || "none");
  printLine("rollout_target_generation", rolloutSummary.target_generation_id || "none");
  printLine("rollout_retiring_generation", rolloutSummary.retiring_generation_id || "none");
  printLine(
    "rollout_retiring_generation_live",
    rolloutSummary.retiring_generation_live === null
      ? "unknown"
      : String(rolloutSummary.retiring_generation_live),
  );
  printLine("rollout_retained_sessions", String(rolloutSummary.retained_session_count));
  printLine(
    "rollout_live_retiring_generations",
    String(rolloutSummary.live_retiring_generation_count),
  );
  printLine(
    "rollout_live_retained_generations",
    String(rolloutSummary.live_retained_generation_count),
  );
  printLine(
    "rollout_live_retained_sessions",
    String(rolloutSummary.live_retained_session_count),
  );
  printLine("rollout_requested_at", rolloutSummary.requested_at || "none");
  printLine("rollout_started_at", rolloutSummary.started_at || "none");
  printLine("rollout_finished_at", rolloutSummary.finished_at || "none");
  printLine("rollout_last_error", rolloutSummary.last_error || "none");
  printLine("sessions_total", counts.total);
  printLine("sessions_active", counts.active);
  printLine("sessions_parked", counts.parked);
  printLine("sessions_purged", counts.purged);
  printLine("sessions_pinned", counts.pinned);
}

async function runSessions({ sessionAdmin, state, limit, json }) {
  const sessions = await sessionAdmin.listSessions({ state });
  const limited = Number.isInteger(limit) ? sessions.slice(0, limit) : sessions;

  if (json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }

  if (limited.length === 0) {
    console.log("no sessions");
    return;
  }

  for (const session of limited) {
    console.log(formatSessionLine(session));
  }
}

async function runShow({ sessionAdmin, args, json }) {
  const { chatId, topicId } = parseSelector(args);
  const session = await sessionAdmin.getSession(chatId, topicId);

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(JSON.stringify(session, null, 2));
}

async function runMutation({ sessionAdmin, command, args, json }) {
  const { chatId, topicId } = parseSelector(args);
  let session;

  if (command === "pin") {
    session = await sessionAdmin.setRetentionPin(
      chatId,
      topicId,
      true,
      "admin/pin",
    );
  } else if (command === "unpin") {
    session = await sessionAdmin.setRetentionPin(
      chatId,
      topicId,
      false,
      "admin/unpin",
    );
  } else if (command === "reactivate") {
    session = await sessionAdmin.reactivateSession(chatId, topicId);
  } else if (command === "purge") {
    session = await sessionAdmin.purgeSession(chatId, topicId);
  } else {
    throw new Error(`Unsupported admin command: ${command}`);
  }

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  printLine("session_key", session.session_key);
  printLine("lifecycle_state", session.lifecycle_state);
  printLine("retention_pin", String(Boolean(session.retention_pin)));
  printLine("purge_after", session.purge_after ?? "none");
}

async function main() {
  const parsed = parseAdminArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const sessionStore = new SessionStore(layout.sessions);
  const sessionAdmin = new SessionAdmin({
    sessionStore,
    config,
    runtimeObserver: createCliRuntimeObserver({
      logsDir: layout.logs,
      config,
    }),
  });

  if (parsed.command === "status") {
    await runStatus({
      sessionAdmin,
      layout,
      config,
      json: parsed.json,
    });
    return;
  }

  if (parsed.command === "sessions") {
    await runSessions({
      sessionAdmin,
      state: parsed.state,
      limit: parsed.limit,
      json: parsed.json,
    });
    return;
  }

  if (parsed.command === "show") {
    await runShow({
      sessionAdmin,
      args: parsed.args,
      json: parsed.json,
    });
    return;
  }

  if (
    parsed.command === "pin" ||
    parsed.command === "unpin" ||
    parsed.command === "reactivate" ||
    parsed.command === "purge"
  ) {
    await runMutation({
      sessionAdmin,
      command: parsed.command,
      args: parsed.args,
      json: parsed.json,
    });
    return;
  }

  throw new Error(`Unknown admin command: ${parsed.command}`);
}

const isDirectRun =
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(`admin failed: ${error.message}`);
    process.exitCode = 1;
  });
}

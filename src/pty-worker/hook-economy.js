const LATEST_HOOK_EVENTS_LIMIT = 8;

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeInteger(value) {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  }
  if (Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function incrementCounter(target, key) {
  const normalized = normalizeText(key) || "unknown";
  target[normalized] = (target[normalized] || 0) + 1;
}

function addNumber(target, key, value) {
  const normalized = normalizeInteger(value);
  if (normalized === null) {
    return;
  }
  target[key] = (target[key] || 0) + normalized;
}

function normalizeEconomy(economy) {
  if (!economy || typeof economy !== "object") {
    return null;
  }

  return {
    decisionType: normalizeText(economy.decisionType),
    commandClass: normalizeText(economy.commandClass),
    bypassReason: normalizeText(economy.bypassReason),
    exactOutputReason: normalizeText(economy.exactOutputReason),
    originalBytes: normalizeInteger(economy.originalBytes),
    replacementBytes: normalizeInteger(economy.replacementBytes),
    modelVisibleBytes: normalizeInteger(economy.modelVisibleBytes),
    outputOriginalBytes: normalizeInteger(economy.outputOriginalBytes),
    outputModelVisibleBytes: normalizeInteger(economy.outputModelVisibleBytes),
    tokenBudget: normalizeInteger(economy.tokenBudget),
    originalTokenCount: normalizeInteger(economy.originalTokenCount),
    estimatedSavedTokens: normalizeInteger(economy.estimatedSavedTokens),
    artifactRefs: Array.isArray(economy.artifactRefs)
      ? economy.artifactRefs.filter((entry) => typeof entry === "string")
      : [],
  };
}

export function summarizeHookRun(run) {
  if (!run || typeof run !== "object") {
    return null;
  }

  return {
    id: normalizeText(run.id),
    eventName: normalizeText(run.eventName),
    handlerType: normalizeText(run.handlerType),
    executionMode: normalizeText(run.executionMode),
    source: normalizeText(run.source),
    key: normalizeText(run.key),
    pluginId: normalizeText(run.pluginId),
    currentHash: normalizeText(run.currentHash),
    trustStatus: normalizeText(run.trustStatus),
    status: normalizeText(run.status),
    durationMs: normalizeInteger(run.durationMs),
    economy: normalizeEconomy(run.economy),
  };
}

export function createHookEconomySummary() {
  return {
    startedRuns: 0,
    completedRuns: 0,
    byEventName: {},
    byPlugin: {},
    byDecision: {},
    byTrustStatus: {},
    totals: {
      originalBytes: 0,
      replacementBytes: 0,
      modelVisibleBytes: 0,
      outputOriginalBytes: 0,
      outputModelVisibleBytes: 0,
      estimatedSavedTokens: 0,
    },
    latest: [],
  };
}

export function recordHookEconomyEvent(currentSummary, hookEvent) {
  const next = currentSummary
    ? JSON.parse(JSON.stringify(currentSummary))
    : createHookEconomySummary();
  const hook = hookEvent?.hook || hookEvent;
  if (!hook) {
    return next;
  }

  if (hookEvent?.eventType === "hook.started") {
    next.startedRuns += 1;
    return next;
  }

  if (hookEvent?.eventType !== "hook.completed") {
    return next;
  }

  next.completedRuns += 1;
  incrementCounter(next.byEventName, hook.eventName);
  incrementCounter(next.byPlugin, hook.pluginId || hook.source);
  incrementCounter(next.byTrustStatus, hook.trustStatus);

  const economy = hook.economy || {};
  const decision = economy.decisionType || hook.status || "unknown";
  incrementCounter(next.byDecision, decision);

  addNumber(next.totals, "originalBytes", economy.originalBytes);
  addNumber(next.totals, "replacementBytes", economy.replacementBytes);
  addNumber(next.totals, "modelVisibleBytes", economy.modelVisibleBytes);
  addNumber(next.totals, "outputOriginalBytes", economy.outputOriginalBytes);
  addNumber(next.totals, "outputModelVisibleBytes", economy.outputModelVisibleBytes);
  addNumber(next.totals, "estimatedSavedTokens", economy.estimatedSavedTokens);

  next.latest = [
    {
      observedAt: new Date().toISOString(),
      eventName: hook.eventName,
      pluginId: hook.pluginId,
      key: hook.key,
      trustStatus: hook.trustStatus,
      status: hook.status,
      decisionType: economy.decisionType,
      commandClass: economy.commandClass,
      estimatedSavedTokens: economy.estimatedSavedTokens,
      outputOriginalBytes: economy.outputOriginalBytes,
      outputModelVisibleBytes: economy.outputModelVisibleBytes,
    },
    ...next.latest,
  ].slice(0, LATEST_HOOK_EVENTS_LIMIT);

  return next;
}

export function buildRuntimeHookEventDetails({ session, summary }) {
  const hook = summary?.hook;
  if (!hook) {
    return null;
  }

  return {
    session_key: session?.session_key || null,
    chat_id: session?.chat_id || null,
    topic_id: session?.topic_id || null,
    topic_name: session?.topic_name || null,
    thread_id: summary.threadId || null,
    turn_id: summary.turnId || null,
    hook: {
      id: hook.id,
      event_name: hook.eventName,
      plugin_id: hook.pluginId,
      key: hook.key,
      trust_status: hook.trustStatus,
      status: hook.status,
      duration_ms: hook.durationMs,
      economy: hook.economy,
    },
  };
}

export function buildHookEconomyStatusLines(summary, _language = "eng") {
  if (!summary || !summary.completedRuns) {
    return [];
  }

  const outputOriginal = summary.totals?.outputOriginalBytes || 0;
  const outputVisible = summary.totals?.outputModelVisibleBytes || 0;
  const decisionSaved = Math.max(0, summary.totals?.estimatedSavedTokens || 0);
  const outputSavedBytes = Math.max(0, outputOriginal - outputVisible);
  const outputSavedTokens = Math.round(outputSavedBytes / 4);
  const saved = Math.max(decisionSaved, outputSavedTokens);
  const decisions = Object.entries(summary.byDecision || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
  const plugins = Object.entries(summary.byPlugin || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");

  return [
    `hook economy: ${summary.completedRuns} completed, ~${saved} saved tokens`,
    ...(outputOriginal || outputVisible
      ? [`hook output bytes: ${outputVisible} / ${outputOriginal} visible`]
      : []),
    ...(decisions ? [`hook decisions: ${decisions}`] : []),
    ...(plugins ? [`hook plugins: ${plugins}`] : []),
  ];
}

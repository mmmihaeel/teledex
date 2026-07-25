import {
  addTokenUsage,
  normalizeTokenUsage,
  subtractTokenUsage,
} from "../codex-runtime/token-usage.js";

function publishCurrentSegment(state, segment) {
  if (!state || !segment) {
    return;
  }

  state.currentRunCumulativeTokenUsageSegment = segment;
  state.currentRunTokenUsage =
    addTokenUsage(state.currentRunClosedTokenUsage, segment)
    ?? segment
    ?? state.currentRunClosedTokenUsage
    ?? null;
}

function fillMissingTokenUsageFields(usage, fallback) {
  const normalizedUsage = normalizeTokenUsage(usage, { synthesizeTotal: false });
  const normalizedFallback = normalizeTokenUsage(fallback, { synthesizeTotal: false });
  if (!normalizedUsage) {
    return normalizedFallback;
  }
  if (!normalizedFallback) {
    return normalizedUsage;
  }

  return {
    input_tokens:
      normalizedUsage.input_tokens ?? normalizedFallback.input_tokens,
    cached_input_tokens:
      normalizedUsage.cached_input_tokens ?? normalizedFallback.cached_input_tokens,
    output_tokens:
      normalizedUsage.output_tokens ?? normalizedFallback.output_tokens,
    reasoning_tokens:
      normalizedUsage.reasoning_tokens ?? normalizedFallback.reasoning_tokens,
    total_tokens:
      normalizedUsage.total_tokens ?? normalizedFallback.total_tokens,
  };
}

export function resetRunTokenUsageCumulativeDomain(state) {
  if (!state) {
    return;
  }

  const closed = addTokenUsage(
    state.currentRunClosedTokenUsage,
    state.currentRunCumulativeTokenUsageSegment,
  );
  if (closed) {
    state.currentRunClosedTokenUsage = closed;
  }
  state.currentRunCumulativeTokenUsageBaseline = null;
  state.currentRunCumulativeTokenUsageSegment = null;
  state.currentRunTokenUsage =
    state.currentRunClosedTokenUsage
    ?? state.currentRunTokenUsage
    ?? null;
}

export function applyRunTokenUsageSummary(state, summary) {
  if (!state || !summary || typeof summary !== "object") {
    return;
  }

  const usageForSnapshot = summary.usage
    ? normalizeTokenUsage(summary.usage)
    : null;
  const usage = summary.usage
    ? normalizeTokenUsage(summary.usage, { synthesizeTotal: false })
    : null;
  if (usageForSnapshot) {
    state.lastTokenUsage = usageForSnapshot;
  }
  if (usage) {
    publishCurrentSegment(state, usage);
  }

  const totalUsage = summary.totalUsage
    ? normalizeTokenUsage(summary.totalUsage, { synthesizeTotal: false })
    : null;
  if (!totalUsage) {
    return;
  }

  if (!state.currentRunCumulativeTokenUsageBaseline) {
    state.currentRunCumulativeTokenUsageBaseline =
      state.activeTurnId && usage
        ? (subtractTokenUsage(totalUsage, usage) ?? totalUsage)
        : totalUsage;
  }

  const segment = fillMissingTokenUsageFields(
    subtractTokenUsage(
      totalUsage,
      state.currentRunCumulativeTokenUsageBaseline,
    ),
    usage,
  );
  if (segment) {
    publishCurrentSegment(state, segment);
  }
}

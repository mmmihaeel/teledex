function normalizeUsageCount(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.trunc(value);
}

export { normalizeUsageCount };

export function normalizeTokenUsage(usage, { synthesizeTotal = true } = {}) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = normalizeUsageCount(usage.input_tokens);
  const cachedInputTokens = normalizeUsageCount(
    usage.cached_input_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens,
  );
  const outputTokens = normalizeUsageCount(usage.output_tokens);
  const reasoningTokens = normalizeUsageCount(
    usage.reasoning_output_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens,
  );
  const totalTokens = normalizeUsageCount(
    usage.total_tokens ??
      (synthesizeTotal && (inputTokens !== null || outputTokens !== null)
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : null),
  );

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningTokens === null &&
    totalTokens === null
  ) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
  };
}

// Native Codex goal accounting: billable/fresh input plus output. Raw
// total_tokens is a different context/accounting surface, so callers choose
// their own fallback when the input/output breakdown is incomplete.
export function computeNonCachedInputOutputTokenTotal(usage) {
  const normalizedUsage = normalizeTokenUsage(usage);
  if (!normalizedUsage) {
    return null;
  }

  const inputTokens = normalizedUsage.input_tokens;
  const cachedInputTokens = normalizedUsage.cached_input_tokens;
  const outputTokens = normalizedUsage.output_tokens;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    return null;
  }

  const nonCachedInputTokens = Math.max(inputTokens - (cachedInputTokens ?? 0), 0);
  const safeOutputTokens = Math.max(outputTokens, 0);
  return normalizeUsageCount(nonCachedInputTokens + safeOutputTokens);
}

export function addTokenUsage(left, right) {
  const normalizedLeft = normalizeTokenUsage(left, { synthesizeTotal: false });
  const normalizedRight = normalizeTokenUsage(right, { synthesizeTotal: false });
  if (!normalizedLeft) {
    return normalizedRight;
  }
  if (!normalizedRight) {
    return normalizedLeft;
  }

  const addField = (field) => {
    const leftValue = normalizedLeft[field];
    const rightValue = normalizedRight[field];
    if (!Number.isFinite(leftValue) && !Number.isFinite(rightValue)) {
      return null;
    }
    return normalizeUsageCount((leftValue ?? 0) + (rightValue ?? 0));
  };

  const result = {
    input_tokens: addField("input_tokens"),
    cached_input_tokens: addField("cached_input_tokens"),
    output_tokens: addField("output_tokens"),
    reasoning_tokens: addField("reasoning_tokens"),
    total_tokens: addField("total_tokens"),
  };

  if (Object.values(result).every((value) => value === null)) {
    return null;
  }

  return result;
}

export function subtractTokenUsage(usage, baseline) {
  const normalizedUsage = normalizeTokenUsage(usage, { synthesizeTotal: false });
  const normalizedBaseline = normalizeTokenUsage(baseline, { synthesizeTotal: false });
  if (!normalizedUsage || !normalizedBaseline) {
    return null;
  }

  const subtractField = (field) => {
    const value = normalizedUsage[field];
    const base = normalizedBaseline[field];
    if (!Number.isFinite(value) || !Number.isFinite(base)) {
      return null;
    }
    return normalizeUsageCount(value - base);
  };

  const result = {
    input_tokens: subtractField("input_tokens"),
    cached_input_tokens: subtractField("cached_input_tokens"),
    output_tokens: subtractField("output_tokens"),
    reasoning_tokens: subtractField("reasoning_tokens"),
    total_tokens: subtractField("total_tokens"),
  };

  if (Object.values(result).every((value) => value === null)) {
    return null;
  }

  return result;
}

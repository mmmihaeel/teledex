function formatTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlValue(value) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return formatTomlString(value);
}

function formatTomlInlineTable(value) {
  const entries = Object.entries(value || {})
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)
    .map(([key, entryValue]) => `${key}=${formatTomlValue(entryValue)}`);
  return `{ ${entries.join(", ")} }`;
}

function normalizeProviderId(value) {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]+$/u.test(normalized) ? normalized : null;
}

function normalizeConfigOverrideKey(value) {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9_.-]+$/u.test(normalized) ? normalized : null;
}

function normalizePositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return null;
}

export function appendCodexRuntimeConfigArgs(
  args,
  {
    model = null,
    reasoningEffort = null,
    contextWindow = null,
    autoCompactTokenLimit = null,
    sandboxMode = null,
    approvalPolicy = null,
    developerInstructions = null,
    modelProvider = null,
    modelProviderConfig = null,
    configOverrides = null,
  } = {},
) {
  const nextArgs = Array.isArray(args) ? args : [];

  if (model) {
    nextArgs.push("-c", `model=${formatTomlString(model)}`);
  }

  const normalizedModelProvider = normalizeProviderId(modelProvider);
  if (normalizedModelProvider) {
    nextArgs.push("-c", `model_provider=${formatTomlString(normalizedModelProvider)}`);
    if (
      modelProviderConfig
      && typeof modelProviderConfig === "object"
      && !Array.isArray(modelProviderConfig)
    ) {
      nextArgs.push(
        "-c",
        `model_providers.${normalizedModelProvider}=${formatTomlInlineTable(modelProviderConfig)}`,
      );
    }
  }

  if (reasoningEffort) {
    nextArgs.push(
      "-c",
      `model_reasoning_effort=${formatTomlString(reasoningEffort)}`,
    );
  }

  const normalizedContextWindow = normalizePositiveInteger(contextWindow);
  if (normalizedContextWindow !== null) {
    nextArgs.push("-c", `model_context_window=${normalizedContextWindow}`);
  }

  const normalizedAutoCompactTokenLimit =
    normalizePositiveInteger(autoCompactTokenLimit);
  if (normalizedAutoCompactTokenLimit !== null) {
    nextArgs.push(
      "-c",
      `model_auto_compact_token_limit=${normalizedAutoCompactTokenLimit}`,
    );
  }

  if (sandboxMode) {
    nextArgs.push(
      "-c",
      `sandbox_mode=${formatTomlString(sandboxMode)}`,
    );
  }

  if (approvalPolicy) {
    nextArgs.push(
      "-c",
      `approval_policy=${formatTomlString(approvalPolicy)}`,
    );
  }

  if (
    configOverrides
    && typeof configOverrides === "object"
    && !Array.isArray(configOverrides)
  ) {
    for (const [key, value] of Object.entries(configOverrides)) {
      const normalizedKey = normalizeConfigOverrideKey(key);
      if (!normalizedKey || value === undefined || value === null) {
        continue;
      }
      nextArgs.push("-c", `${normalizedKey}=${formatTomlValue(value)}`);
    }
  }

  const normalizedDeveloperInstructions =
    typeof developerInstructions === "string"
      ? developerInstructions.trim()
      : "";
  if (normalizedDeveloperInstructions) {
    nextArgs.push(
      "-c",
      `developer_instructions=${formatTomlString(normalizedDeveloperInstructions)}`,
    );
  }

  return nextArgs;
}

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";

export function buildCodexAppServerV2Args({
  model = null,
  modelProvider = null,
  modelProviderConfig = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  configOverrides = null,
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
  enableGoals = true,
} = {}) {
  const args = [
    "app-server",
    "--listen",
    "stdio://",
  ];
  if (enableGoals) {
    args.push("--enable", "goals");
  }
  return appendCodexRuntimeConfigArgs(args, {
    model,
    modelProvider,
    modelProviderConfig,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    configOverrides,
    sandboxMode,
    approvalPolicy,
  });
}

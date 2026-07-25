import { DEEPSEEK_HTTP_BACKEND } from "../../deepseek-runtime/deepseek-http-runner.js";
import { loadAvailableCodexModelsForSession } from "../../session-manager/codex-runtime-host.js";
import {
  resolveCodexRuntimeProfile,
} from "../../session-manager/codex-runtime-settings.js";

export function resolveStoredSessionBackend(session) {
  return session?.last_run_backend ?? session?.codex_backend ?? null;
}

export function resolveDisplayBackend({
  activeBackend = null,
  stateBackend = null,
  storedBackend = null,
  isDeepSeekRuntime = false,
} = {}) {
  if (activeBackend) {
    if (activeBackend === "codex") {
      return stateBackend ?? storedBackend ?? activeBackend;
    }
    return activeBackend;
  }
  if (isDeepSeekRuntime && storedBackend === DEEPSEEK_HTTP_BACKEND) {
    return storedBackend;
  }
  return stateBackend ?? storedBackend ?? "unknown";
}

export async function resolveStatusRuntimeProfile(
  sessionService,
  session,
  state,
  target,
) {
  if (typeof sessionService.resolveCodexRuntimeProfile === "function") {
    return sessionService.resolveCodexRuntimeProfile(session, { target });
  }

  const globalSettings =
    typeof sessionService.getGlobalCodexSettings === "function"
      ? await sessionService.getGlobalCodexSettings()
      : null;
  const availableModels =
    typeof sessionService.loadAvailableCodexModels === "function"
      ? await sessionService.loadAvailableCodexModels(session)
      : await loadAvailableCodexModelsForSession({
        session,
        defaultConfigPath: state.codexConfigPath,
        hostRegistryService: sessionService.hostRegistryService,
      });
  return resolveCodexRuntimeProfile({
    session,
    globalSettings,
    config: state,
    target,
    availableModels,
  });
}

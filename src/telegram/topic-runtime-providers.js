import {
  normalizeSessionRuntimeProvider,
  SESSION_PROVIDER_DEEPSEEK,
  SESSION_PROVIDER_OPENROUTER,
} from "../session-manager/codex-runtime-profiles.js";

export function isDeepSeekTopic(session) {
  return normalizeSessionRuntimeProvider(session?.session_runtime_provider)
    === SESSION_PROVIDER_DEEPSEEK;
}

export function isOpenRouterTopic(session) {
  return normalizeSessionRuntimeProvider(session?.session_runtime_provider)
    === SESSION_PROVIDER_OPENROUTER;
}

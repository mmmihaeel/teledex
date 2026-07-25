import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_REASONING_EFFORT,
  DEEPSEEK_REASONING_EFFORTS,
  DEEPSEEK_MODELS,
  OPENROUTER_MODELS,
  OPENROUTER_REASONING_EFFORTS,
  formatDeepSeekReasoningEffort,
  formatOpenRouterReasoningEffort,
  normalizeDeepSeekModel,
  normalizeDeepSeekReasoningEffort,
  normalizeOpenRouterModel,
  normalizeOpenRouterReasoningEffort,
} from "../../session-manager/codex-runtime-profiles.js";
import {
  formatReasoningValue,
  isEnglish,
} from "../control-panel-view-common.js";

export { DEEPSEEK_REASONING_EFFORTS, OPENROUTER_REASONING_EFFORTS };
export { isDeepSeekTopic, isOpenRouterTopic } from "../topic-runtime-providers.js";

export function deepSeekModelEntries() {
  return DEEPSEEK_MODELS.map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
  }));
}

export function openRouterModelEntries(session = null) {
  const entries = OPENROUTER_MODELS.map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
  }));
  const currentModel = normalizeOpenRouterModel(session?.session_runtime_model);
  if (currentModel && !entries.some((entry) => entry.slug === currentModel)) {
    entries.push({
      slug: currentModel,
      displayName: currentModel,
    });
  }
  return entries;
}

export function resolveDeepSeekTopicModel(session) {
  return normalizeDeepSeekModel(session?.session_runtime_model) || DEFAULT_DEEPSEEK_MODEL;
}

export function resolveOpenRouterTopicModel(session) {
  return normalizeOpenRouterModel(session?.session_runtime_model) || DEFAULT_OPENROUTER_MODEL;
}

export function resolveDeepSeekTopicReasoning(session) {
  return normalizeDeepSeekReasoningEffort(session?.agent_reasoning_effort_override)
    || DEFAULT_DEEPSEEK_REASONING_EFFORT;
}

export function resolveOpenRouterTopicReasoning(session) {
  return normalizeOpenRouterReasoningEffort(session?.agent_reasoning_effort_override)
    || DEFAULT_OPENROUTER_REASONING_EFFORT;
}

function formatDeepSeekReasoningShortLabel(value) {
  const normalized = normalizeDeepSeekReasoningEffort(value);
  const entry = DEEPSEEK_REASONING_EFFORTS.find((level) => level.value === normalized);
  return entry?.label || normalized || "default";
}

function formatOpenRouterReasoningShortLabel(value) {
  const normalized = normalizeOpenRouterReasoningEffort(value);
  const entry = OPENROUTER_REASONING_EFFORTS.find((level) => level.value === normalized);
  return entry?.label || normalized || "default";
}

export function formatDeepSeekTopicRuntimeSummary(session) {
  const model = resolveDeepSeekTopicModel(session);
  const reasoning = formatDeepSeekReasoningShortLabel(resolveDeepSeekTopicReasoning(session));
  return `${model} (${reasoning})`;
}

export function formatOpenRouterTopicRuntimeSummary(session) {
  const model = resolveOpenRouterTopicModel(session);
  const reasoning = formatOpenRouterReasoningShortLabel(
    resolveOpenRouterTopicReasoning(session),
  );
  return `${model} (${reasoning})`;
}

export function formatTopicReasoningValue(
  value,
  { deepSeekTopic = false, openRouterTopic = false } = {},
  language = DEFAULT_UI_LANGUAGE,
) {
  if (deepSeekTopic) {
    return formatDeepSeekReasoningEffort(value) || (isEnglish(language) ? "default" : "default");
  }
  if (openRouterTopic) {
    return formatOpenRouterReasoningEffort(value) || (isEnglish(language) ? "default" : "default");
  }
  return formatReasoningValue(value, language);
}

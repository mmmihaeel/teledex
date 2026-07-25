import { DEFAULT_UI_LANGUAGE } from "../../../i18n/ui-language.js";
import {
  formatReasoningEffort,
} from "../../../session-manager/codex-runtime-settings.js";

function formatCodexSettingValue(kind, value, _language = DEFAULT_UI_LANGUAGE) {
  if (!value) {
    return "default";
  }

  if (kind === "reasoning") {
    return formatReasoningEffort(value) ?? value;
  }

  return value;
}

function formatCodexSettingSource(source, _language = DEFAULT_UI_LANGUAGE) {
  switch (source) {
    case "topic":
      return "topic";
    case "global":
      return "global";
    case "default":
      return "default";
    default:
      return "unset";
  }
}

export function buildCodexSettingUsageMessage(
  commandName,
  _language = DEFAULT_UI_LANGUAGE,
) {
  return [
    `Usage: /${commandName}`,
    `/${commandName} list`,
    `/${commandName} <value>`,
    `/${commandName} clear`,
    `/${commandName} global`,
    `/${commandName} global list`,
    `/${commandName} global <value>`,
    `/${commandName} global clear`,
  ].join("\n");
}

export function buildCodexSettingStateMessage({
  title,
  commandName,
  kind,
  language = DEFAULT_UI_LANGUAGE,
  topicValue = null,
  globalValue = null,
  effectiveValue = null,
  effectiveSource = "unset",
  showTopicValue = true,
}) {
  return [
    title,
    "",
    ...(showTopicValue
      ? [
          `topic override: ${formatCodexSettingValue(kind, topicValue, language)}`,
        ]
      : []),
    `global default: ${formatCodexSettingValue(kind, globalValue, language)}`,
    `effective: ${formatCodexSettingValue(kind, effectiveValue, language)} (${formatCodexSettingSource(effectiveSource, language)})`,
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

export function buildCodexSettingListMessage({
  title,
  commandName,
  entries,
  language = DEFAULT_UI_LANGUAGE,
}) {
  return [
    title,
    "",
    ...(entries.length > 0
      ? entries
      : ["No values discovered."]),
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

export function formatCodexModelListEntry(model) {
  const details = [];
  if (model.displayName && model.displayName !== model.slug) {
    details.push(model.displayName);
  }
  if (model.defaultReasoningLevel) {
    details.push(`default ${model.defaultReasoningLevel}`);
  }

  return details.length > 0
    ? `- ${model.slug} — ${details.join(" · ")}`
    : `- ${model.slug}`;
}

export function formatCodexReasoningListEntry(entry) {
  const base = `- ${entry.label} (${entry.value})`;
  return entry.description ? `${base} — ${entry.description}` : base;
}

export function buildInvalidCodexSettingMessage({
  title,
  commandName,
  kind,
  invalidValue,
  entries,
  language = DEFAULT_UI_LANGUAGE,
}) {
  return [
    `${title}: unknown ${kind} "${invalidValue}".`,
    "",
    ...(entries.length > 0
      ? entries
      : ["No values discovered."]),
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

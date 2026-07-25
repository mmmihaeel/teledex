import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { getSupportedReasoningLevelsForModel } from "../../session-manager/codex-runtime-settings.js";
import { OPENROUTER_MODELS } from "../../session-manager/codex-runtime-profiles.js";
import { buildCodexLimitsMenuLines } from "../../codex-runtime/limits.js";
import { normalizePromptSuffixText } from "../../session-manager/prompt-suffix.js";
import {
  buildHostsOverviewMessage,
  formatFailureReason,
} from "../command-handlers/host-commands.js";
import {
  buildControlPanelNoticeText,
  buildBotProfileLine,
  buildInlineKeyboardButton,
  buildLanguageKeyboard as buildSharedLanguageKeyboard,
  buildPendingInputLabel as buildSharedPendingInputLabel,
  buildRootSummaryLine,
  buildSuffixPreview,
  buildWaitKeyboard as buildSharedWaitKeyboard,
  chunkIntoRows,
  formatConfiguredValue,
  formatReasoningValue,
  formatWaitDuration,
  getLanguageLabel,
} from "../control-panel-view-common.js";
import {
  GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  SCREEN_CODES,
  TARGET_CODES,
} from "./view-constants.js";

function buildPendingInputLabel(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputLabel(kind, language, {
    wait_custom: "custom global wait; send 45s / 2m / off",
  });
}

function buildStatusLines({
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
}) {
  const noticeText = buildControlPanelNoticeText(notice);
  const lines = [];
  if (pendingInput) {
    lines.push(
      "",
      `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
    );
    if (pendingInput.status_message) {
      lines.push(`status: ${pendingInput.status_message}`);
    }
  } else if (noticeText) {
    lines.push("", `notice: ${noticeText}`);
  }
  return lines;
}

function buildHostButtonLabel(hostStatus) {
  return formatExecutionHostButtonLabel(hostStatus.hostLabel, hostStatus.hostId);
}

function formatExecutionHostButtonLabel(hostLabel, hostId) {
  return String(hostLabel || hostId || "unknown").trim() || "unknown";
}

function formatNotReadyHostsSummary(hosts, language = DEFAULT_UI_LANGUAGE) {
  return hosts
    .map((host) => {
      const label = host?.hostLabel || host?.hostId || "unknown";
      const reason = formatFailureReason(host?.failureReason, language);
      return reason === "none" ? label : `${label} (${reason})`;
    })
    .join(", ");
}

function buildGlobalControlPanelText({
  availableModels,
  globalSettings,
  globalPromptSuffix,
  limitsSummary = null,
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
  profiles,
  newTopicHostSelection = null,
  screen = "root",
  topicCreationHosts = [],
  waitState,
}) {
  const noticeText = buildControlPanelNoticeText(notice);
  const waitSeconds = waitState?.global?.active
    ? Math.round((waitState.global.flushDelayMs ?? 0) / 1000)
    : null;
  const readyHosts = topicCreationHosts.filter((host) => host?.ok);
  const unavailableHosts = topicCreationHosts.filter((host) => !host?.ok);

  if (screen === "hosts") {
    return buildHostsOverviewMessage(topicCreationHosts, language, {
      heading: "Host status",
    });
  }

  if (screen === "new_topic") {
    return [
      buildHostsOverviewMessage(topicCreationHosts, language, {
        heading: "New topic host picker",
        includeCreationHint: true,
      }),
      ...(pendingInput?.kind === "new_topic_title"
        ? [
            "",
            `pending host: ${pendingInput.requested_host_label || pendingInput.requested_host_id || "unknown"}`,
          ]
        : []),
      ...buildStatusLines({ language, notice, pendingInput }),
    ].join("\n");
  }

  if (screen === "new_topic_runtime") {
    const selectedHost = topicCreationHosts.find((host) =>
      host?.hostId === newTopicHostSelection?.host_id
    );
    const hostLabel =
      selectedHost?.hostLabel
      || newTopicHostSelection?.host_label
      || newTopicHostSelection?.host_id
      || "unknown";
    const hostStatus = selectedHost?.ok ? "ready" : "not-ready";
    return [
      "New topic runtime picker",
      "",
      `host: ${hostLabel}`,
      `status: ${hostStatus}`,
      "",
      selectedHost?.ok
        ? "Choose the runtime for this host."
        : "This host is not ready right now.",
      ...buildStatusLines({ language, notice, pendingInput }),
    ].join("\n");
  }

  if (screen === "wait") {
    return [
      "Global wait",
      "",
      `current: ${formatWaitDuration(waitSeconds, language)}`,
      "Tap a preset or choose Custom, then send the next text message.",
      "This is the same persistent /wait global window across topics.",
      ...buildStatusLines({ language, notice, pendingInput }),
    ].join("\n");
  }

  if (screen === "suffix") {
    const suffixText = normalizePromptSuffixText(globalPromptSuffix?.prompt_suffix_text);
    return [
      "Global suffix",
      "",
      `status: ${globalPromptSuffix?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
      `text: ${suffixText ? "set" : "empty"}`,
      "",
      buildSuffixPreview(globalPromptSuffix?.prompt_suffix_text, language),
      ...(pendingInput?.kind === "suffix_text"
        ? [
            "",
            `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
            ...(pendingInput.status_message ? [`status: ${pendingInput.status_message}`] : []),
          ]
        : []),
      ...(pendingInput ? [] : (noticeText ? ["", `notice: ${noticeText}`] : [])),
    ].join("\n");
  }

  if (screen === "language") {
    return [
      "Interface language",
      "",
      `current: ${getLanguageLabel(language)}`,
      "",
      "English is the only supported interface language.",
    ].join("\n");
  }

  if (screen === "bot_settings") {
    return [
      "Bot settings",
      "",
      "Choose what you want to tune.",
      "The /compact profile is used only when the bot rebuilds the brief.",
      "",
      buildBotProfileLine("agent", profiles.agent),
      buildBotProfileLine("/compact", profiles.compact),
    ].join("\n");
  }

  if (
    screen === "agent_model"
    || screen === "compact_model"
  ) {
    const target =
      screen === "agent_model"
        ? "agent"
        : "compact";
    const title =
      target === "agent"
        ? "Agent global model"
        : "Compact summarizer model";
    const configuredValue = globalSettings?.[`${target}_model`] ?? null;
    return [
      title,
      "",
      `configured: ${formatConfiguredValue(configuredValue, language)}`,
      `effective: ${profiles[target].model}`,
      ...(target === "compact"
        ? ["Used only by the temporary /compact summarizer."]
        : []),
      "",
      "Tap a model or clear it.",
      "",
      `models: ${availableModels.length}`,
    ].join("\n");
  }

  if (
    screen === "agent_reasoning"
    || screen === "compact_reasoning"
  ) {
    const target =
      screen === "agent_reasoning"
        ? "agent"
        : "compact";
    const title =
      target === "agent"
        ? "Agent global reasoning"
        : "Compact summarizer reasoning";
    const configuredValue = globalSettings?.[`${target}_reasoning_effort`] ?? null;
    return [
      title,
      "",
      `configured: ${formatReasoningValue(configuredValue, language)}`,
      `effective: ${formatReasoningValue(profiles[target].reasoningEffort, language)}`,
      `model basis: ${profiles[target].model}`,
      ...(target === "compact"
        ? ["Used only by the temporary /compact summarizer."]
        : []),
      "",
      "Tap a supported level or clear it.",
    ].join("\n");
  }

  return [
    "Global control panel",
    "",
    "Buttons change stable values; text values are set by sending the next text message.",
    "",
    `interface language: ${getLanguageLabel(language)}`,
    `topic hosts: ${readyHosts.length} ready / ${topicCreationHosts.length}`,
    ...(unavailableHosts.length > 0
      ? [
          `not-ready hosts: ${formatNotReadyHostsSummary(unavailableHosts, language)}`,
        ]
      : []),
    buildRootSummaryLine(
      "wait global",
      waitState?.global?.active ? formatWaitDuration(waitSeconds, language) : null,
      waitState?.global?.active ? formatWaitDuration(waitSeconds, language) : "off",
    ),
    buildRootSummaryLine(
      "suffix global",
      globalPromptSuffix?.prompt_suffix_enabled
        ? (normalizePromptSuffixText(globalPromptSuffix.prompt_suffix_text) ? "on" : null)
        : null,
      normalizePromptSuffixText(globalPromptSuffix?.prompt_suffix_text)
        ? (globalPromptSuffix?.prompt_suffix_enabled ? "on" : "set / off")
        : "empty",
    ),
    buildBotProfileLine("agent", profiles.agent),
    ...buildCodexLimitsMenuLines(limitsSummary, language),
    ...(pendingInput
      ? [
          "",
          `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
          ...(pendingInput.status_message ? [`status: ${pendingInput.status_message}`] : []),
        ]
      : []),
    ...(pendingInput ? [] : (noticeText ? ["", `notice: ${noticeText}`] : [])),
  ].join("\n");
}

function buildRootKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("New Topic", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
      buildInlineKeyboardButton("Hosts", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.hosts}`),
    ],
    [
      buildInlineKeyboardButton("Bot Settings", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
      buildInlineKeyboardButton("Language", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.language}`),
    ],
    [
      buildInlineKeyboardButton("Guide", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:g:show`),
      buildInlineKeyboardButton("Help", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:h:show`),
    ],
    [
      buildInlineKeyboardButton("Wait", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.wait}`),
      buildInlineKeyboardButton("Suffix", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.suffix}`),
    ],
    [
      buildInlineKeyboardButton("Project Catalog", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:z:show`),
      buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:c:run`),
    ],
    ...(pendingInput
      ? [[buildInlineKeyboardButton("Cancel input", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildHostsKeyboard() {
  return [
    [
      buildInlineKeyboardButton("New Topic", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
      buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`),
    ],
    [buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.hosts}`)],
  ];
}

function canCreateDeepSeekTopic(host, deepSeekRuntimeHostIds = []) {
  const allowedHostIds = Array.isArray(deepSeekRuntimeHostIds)
    ? deepSeekRuntimeHostIds
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  if (allowedHostIds.length === 0) {
    return true;
  }
  return allowedHostIds.includes(String(host?.hostId || "").trim().toLowerCase());
}

function canCreateOpenRouterTopic(host, openRouterRuntimeHostIds = []) {
  const allowedHostIds = Array.isArray(openRouterRuntimeHostIds)
    ? openRouterRuntimeHostIds
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  if (allowedHostIds.length === 0) {
    return true;
  }
  return allowedHostIds.includes(String(host?.hostId || "").trim().toLowerCase());
}

function buildNewTopicKeyboard(topicCreationHosts, pendingInput) {
  const readyButtons = topicCreationHosts
    .filter((host) => host?.ok)
    .map((host) => [
      buildInlineKeyboardButton(
        buildHostButtonLabel(host),
        `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:nh:${host.hostId}`,
      ),
    ]);

  return [
    ...readyButtons,
    ...(pendingInput?.kind === "new_topic_title"
      ? [[buildInlineKeyboardButton("Cancel input", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [
      buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
      buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`),
    ],
  ];
}

function buildNewTopicRuntimeKeyboard(
  topicCreationHosts,
  newTopicHostSelection,
  deepSeekRuntimeHostIds = [],
  openRouterRuntimeHostIds = [],
) {
  const selectedHost = topicCreationHosts.find((host) =>
    host?.hostId === newTopicHostSelection?.host_id
  );
  const runtimeRows = [];
  if (selectedHost?.ok) {
    runtimeRows.push([
      buildInlineKeyboardButton(
        "Codex",
        `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:nh:${selectedHost.hostId}:codex`,
      ),
    ]);
    if (canCreateDeepSeekTopic(selectedHost, deepSeekRuntimeHostIds)) {
      runtimeRows.push([
        buildInlineKeyboardButton(
          "DS Flash",
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:nh:${selectedHost.hostId}:deepseek:flash`,
        ),
        buildInlineKeyboardButton(
          "DS Pro",
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:nh:${selectedHost.hostId}:deepseek:pro`,
        ),
      ]);
    }
    if (canCreateOpenRouterTopic(selectedHost, openRouterRuntimeHostIds)) {
      runtimeRows.push(
        ...chunkIntoRows(
          OPENROUTER_MODELS.map((model) =>
            buildInlineKeyboardButton(
              model.buttonLabel || model.displayName || model.slug,
              `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:nh:${selectedHost.hostId}:openrouter:${model.slug}`,
            ),
          ),
          2,
        ),
      );
    }
  }

  return [
    ...runtimeRows,
    [
      buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic_runtime}`),
      buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
    ],
  ];
}

function buildBotSettingsKeyboard() {
  return [
    [
      buildInlineKeyboardButton("Agent model", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_model}`),
      buildInlineKeyboardButton("Agent reasoning", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_reasoning}`),
    ],
    [
      buildInlineKeyboardButton("/compact model", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.compact_model}`),
      buildInlineKeyboardButton("/compact reasoning", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.compact_reasoning}`),
    ],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildWaitKeyboard() {
  return buildSharedWaitKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildSuffixKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("On", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:on`),
      buildInlineKeyboardButton("Off", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:off`),
    ],
    [
      buildInlineKeyboardButton("Set text", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:input`),
      buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:clear`),
    ],
    ...(pendingInput?.kind === "suffix_text"
      ? [[buildInlineKeyboardButton("Cancel input", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildModelKeyboard(target, availableModels) {
  return [
    ...chunkIntoRows(
      availableModels.map((model) =>
        buildInlineKeyboardButton(
          model.displayName || model.slug,
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:${model.slug}`,
        ),
      ),
      2,
    ),
    [buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:clear`)],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`)],
  ];
}

function buildReasoningKeyboard(target, availableLevels) {
  return [
    ...chunkIntoRows(
      availableLevels.map((entry) =>
        buildInlineKeyboardButton(
          entry.label,
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:${entry.value}`,
        ),
      ),
      2,
    ),
    [buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:clear`)],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`)],
  ];
}

function buildLanguageKeyboard() {
  return buildSharedLanguageKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildGlobalControlPanelMarkup({
  availableModels,
  deepSeekRuntimeHostIds = [],
  openRouterRuntimeHostIds = [],
  runtimeModels = availableModels,
  newTopicHostSelection = null,
  pendingInput = null,
  profiles,
  screen = "root",
  topicCreationHosts = [],
}) {
  if (screen === "hosts") {
    return { inline_keyboard: buildHostsKeyboard() };
  }

  if (screen === "new_topic") {
    return {
      inline_keyboard: buildNewTopicKeyboard(
        topicCreationHosts,
        pendingInput,
      ),
    };
  }

  if (screen === "new_topic_runtime") {
    return {
      inline_keyboard: buildNewTopicRuntimeKeyboard(
        topicCreationHosts,
        newTopicHostSelection,
        deepSeekRuntimeHostIds,
        openRouterRuntimeHostIds,
      ),
    };
  }

  if (screen === "wait") {
    return { inline_keyboard: buildWaitKeyboard() };
  }

  if (screen === "suffix") {
    return { inline_keyboard: buildSuffixKeyboard(pendingInput) };
  }

  if (screen === "language") {
    return { inline_keyboard: buildLanguageKeyboard() };
  }

  if (screen === "bot_settings") {
    return { inline_keyboard: buildBotSettingsKeyboard() };
  }

  if (screen === "agent_model") {
    return { inline_keyboard: buildModelKeyboard("agent", availableModels) };
  }

  if (screen === "compact_model") {
    return { inline_keyboard: buildModelKeyboard("compact", availableModels) };
  }

  if (screen === "agent_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "agent",
        getSupportedReasoningLevelsForModel(runtimeModels, profiles.agent.model),
      ),
    };
  }

  if (screen === "compact_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "compact",
        getSupportedReasoningLevelsForModel(runtimeModels, profiles.compact.model),
      ),
    };
  }

  return {
    inline_keyboard: buildRootKeyboard(pendingInput),
  };
}

export function buildGlobalControlPanelPayload({
  language = DEFAULT_UI_LANGUAGE,
  newTopicHostSelection = null,
  notice = null,
  pendingInput = null,
  screen = "root",
  view,
}) {
  return {
    text: buildGlobalControlPanelText({
      availableModels: view.availableModels,
      globalSettings: view.globalSettings,
      globalPromptSuffix: view.globalPromptSuffix,
      limitsSummary: view.limitsSummary,
      language,
      notice,
      pendingInput,
      profiles: view.profiles,
      newTopicHostSelection,
      screen,
      topicCreationHosts: view.topicCreationHosts,
      waitState: view.waitState,
    }),
    reply_markup: buildGlobalControlPanelMarkup({
      availableModels: view.availableModels,
      deepSeekRuntimeHostIds: view.deepSeekRuntimeHostIds,
      openRouterRuntimeHostIds: view.openRouterRuntimeHostIds,
      runtimeModels: view.runtimeModels,
      newTopicHostSelection,
      pendingInput,
      profiles: view.profiles,
      screen,
      topicCreationHosts: view.topicCreationHosts,
    }),
  };
}

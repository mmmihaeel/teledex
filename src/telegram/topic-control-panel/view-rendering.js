import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { getSupportedReasoningLevelsForModel } from "../../session-manager/codex-runtime-settings.js";
import { buildCodexLimitsMenuLines } from "../../codex-runtime/limits.js";
import { normalizePromptSuffixText } from "../../session-manager/prompt-suffix.js";
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
  formatWaitDuration,
  getLanguageLabel,
} from "../control-panel-view-common.js";
import {
  DEEPSEEK_REASONING_EFFORTS,
  OPENROUTER_REASONING_EFFORTS,
  formatDeepSeekTopicRuntimeSummary,
  formatOpenRouterTopicRuntimeSummary,
  formatTopicReasoningValue,
  isDeepSeekTopic,
  isOpenRouterTopic,
  resolveDeepSeekTopicModel,
  resolveDeepSeekTopicReasoning,
  resolveOpenRouterTopicModel,
  resolveOpenRouterTopicReasoning,
} from "./runtime.js";
import {
  SCREEN_CODES,
  TARGET_CODES,
  TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
} from "./view-constants.js";

function buildPendingInputLabel(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputLabel(kind, language, {
    goal_text: "goal text; send the next text message",
    wait_custom: "custom local wait; send 45s / 2m / off",
  });
}

function isAppServerV2Session(session) {
  const backend = String(
    session?.last_run_backend
    || session?.codex_backend
    || "",
  ).trim().toLowerCase();
  return backend === "app-server-v2";
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

function buildTopicControlPanelText({
  availableModels,
  globalPromptSuffix,
  limitsSummary = null,
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
  profiles,
  screen = "root",
  session,
  statusText = null,
  waitState,
}) {
  const noticeText = buildControlPanelNoticeText(notice);
  const deepSeekTopic = isDeepSeekTopic(session);
  const openRouterTopic = isOpenRouterTopic(session);
  const waitSeconds = waitState?.local?.active
    ? Math.round((waitState.local.flushDelayMs ?? 0) / 1000)
    : null;

  if (screen === "status") {
    return statusText || "Status is unavailable.";
  }

  if (screen === "wait") {
    return [
      "Topic wait",
      "",
      `current: ${formatWaitDuration(waitSeconds, language)}`,
      "Tap a preset or choose Custom, then send the next text message.",
      "This is a one-topic manual collection window.",
      ...buildStatusLines({ language, notice, pendingInput }),
    ].join("\n");
  }

  if (screen === "suffix") {
    const suffixText = normalizePromptSuffixText(session?.prompt_suffix_text);
    const globalSuffixText = normalizePromptSuffixText(globalPromptSuffix?.prompt_suffix_text);
    return [
      "Topic suffix",
      "",
      `status: ${session?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
      `text: ${suffixText ? "set" : "empty"}`,
      `global suffix routing: ${session?.prompt_suffix_topic_enabled !== false ? "on" : "off"}`,
      `global suffix: ${
        globalPromptSuffix?.prompt_suffix_enabled && globalSuffixText ? "on" : "off"
      }`,
      "",
      buildSuffixPreview(session?.prompt_suffix_text, language),
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
    if (deepSeekTopic || openRouterTopic) {
      return [
        "Runtime settings",
        "",
        `runtime: ${deepSeekTopic ? "deepseek" : "openrouter"}`,
        `model: ${
          deepSeekTopic
            ? resolveDeepSeekTopicModel(session)
            : resolveOpenRouterTopicModel(session)
        }`,
      ].join("\n");
    }

    return [
      "Bot settings",
      "",
      "Open the bot you want to tune for this topic.",
      "",
      buildBotProfileLine("agent", profiles.agent),
    ].join("\n");
  }

  if (screen === "agent_model") {
    const target = "agent";
    const title = deepSeekTopic
      ? "DeepSeek topic model"
      : openRouterTopic
        ? "OpenRouter topic model"
        : "Agent topic model";
    const configuredValue = deepSeekTopic || openRouterTopic
      ? session?.session_runtime_model
      : session?.[`${target}_model_override`] ?? null;
    const effectiveModel =
      deepSeekTopic
        ? resolveDeepSeekTopicModel(session)
        : openRouterTopic
          ? resolveOpenRouterTopicModel(session)
          : profiles[target].model;
    return [
      title,
      "",
      `configured: ${formatConfiguredValue(configuredValue)}`,
      `effective: ${effectiveModel}`,
      "",
      "Tap a model or clear it.",
      "",
      `models: ${availableModels.length}`,
    ].join("\n");
  }

  if (screen === "agent_reasoning") {
    const target = "agent";
    const deepSeekTopic = isDeepSeekTopic(session);
    const openRouterTopic = isOpenRouterTopic(session);
    const title = deepSeekTopic
      ? "DeepSeek topic reasoning"
      : openRouterTopic
        ? "OpenRouter topic reasoning"
        : "Agent topic reasoning";
    const configuredValue = session?.[`${target}_reasoning_effort_override`] ?? null;
    const modelBasis =
      deepSeekTopic
        ? resolveDeepSeekTopicModel(session)
        : openRouterTopic
          ? resolveOpenRouterTopicModel(session)
          : profiles[target].model;
    const effectiveReasoning =
      deepSeekTopic
        ? resolveDeepSeekTopicReasoning(session)
        : openRouterTopic
          ? resolveOpenRouterTopicReasoning(session)
          : profiles[target].reasoningEffort;
    return [
      title,
      "",
      `configured: ${formatTopicReasoningValue(configuredValue, { deepSeekTopic, openRouterTopic }, language)}`,
      `effective: ${formatTopicReasoningValue(effectiveReasoning, { deepSeekTopic, openRouterTopic }, language)}`,
      `model basis: ${modelBasis}`,
      "",
      "Tap a supported level or clear it.",
    ].join("\n");
  }

  return [
    "Topic control panel",
    "",
    "Buttons change values for this topic; text values are set by sending the next text message.",
    "",
    `interface language: ${getLanguageLabel(language)}`,
    buildRootSummaryLine(
      "wait topic",
      waitState?.local?.active ? formatWaitDuration(waitSeconds, language) : null,
      waitState?.local?.active
        ? formatWaitDuration(waitSeconds, language)
        : "off",
    ),
    buildRootSummaryLine(
      "suffix topic",
      session?.prompt_suffix_enabled
        ? (normalizePromptSuffixText(session?.prompt_suffix_text) ? "on" : null)
        : null,
      normalizePromptSuffixText(session?.prompt_suffix_text)
        ? (session?.prompt_suffix_enabled ? "on" : "set / off")
        : "empty",
    ),
    `global suffix routing: ${session?.prompt_suffix_topic_enabled !== false ? "on" : "off"}`,
    deepSeekTopic
      ? `runtime: ${formatDeepSeekTopicRuntimeSummary(session)}`
      : openRouterTopic
        ? `runtime: ${formatOpenRouterTopicRuntimeSummary(session)}`
        : buildBotProfileLine("agent", profiles.agent),
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

function buildRootKeyboard(pendingInput, session) {
  const goalAvailable =
    isAppServerV2Session(session)
    && !isDeepSeekTopic(session)
    && !isOpenRouterTopic(session);
  return [
    [
      buildInlineKeyboardButton("Bot Settings", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
      buildInlineKeyboardButton("Status", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.status}`),
    ],
    [
      buildInlineKeyboardButton("Suffix", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.suffix}`),
      buildInlineKeyboardButton("Wait", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.wait}`),
    ],
    [
      buildInlineKeyboardButton("Purge", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:purge`),
      buildInlineKeyboardButton("Interrupt", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:interrupt`),
    ],
    goalAvailable
      ? [
          buildInlineKeyboardButton("Goal", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:g:input`),
          buildInlineKeyboardButton("Compact", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:compact`),
        ]
      : [buildInlineKeyboardButton("Compact", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:compact`)],
    ...(pendingInput
      ? [[buildInlineKeyboardButton("Cancel pending input", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Refresh", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildBotSettingsKeyboard(session) {
  if (isDeepSeekTopic(session)) {
    return [
      [buildInlineKeyboardButton("DeepSeek model", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_model}`)],
      [buildInlineKeyboardButton("DeepSeek reasoning", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_reasoning}`)],
      [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
    ];
  }
  if (isOpenRouterTopic(session)) {
    return [
      [buildInlineKeyboardButton("OpenRouter model", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_model}`)],
      [buildInlineKeyboardButton("OpenRouter reasoning", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_reasoning}`)],
      [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
    ];
  }

  return [
    [
      buildInlineKeyboardButton("Agent model", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_model}`),
      buildInlineKeyboardButton("Agent reasoning", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.agent_reasoning}`),
    ],
    [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildStatusKeyboard() {
  return [[
    buildInlineKeyboardButton("Refresh", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.status}`),
    buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`),
  ]];
}

function buildWaitKeyboard() {
  return buildSharedWaitKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildSuffixKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("Set text", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:input`),
      buildInlineKeyboardButton("On", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:on`),
    ],
    [
      buildInlineKeyboardButton("Off", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:off`),
      buildInlineKeyboardButton("Clear", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:clear`),
    ],
    [
      buildInlineKeyboardButton("Global routing on", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:t:on`),
      buildInlineKeyboardButton("Global routing off", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:t:off`),
    ],
    ...(pendingInput?.kind === "suffix_text"
      ? [[buildInlineKeyboardButton("Cancel pending input", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildModelKeyboard(target, availableModels) {
  return [
    ...chunkIntoRows(
      availableModels.map((model) =>
        buildInlineKeyboardButton(
          model.displayName || model.slug,
          `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:${model.slug}`,
        )),
    ),
    [
      buildInlineKeyboardButton("Clear", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:clear`),
      buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
    ],
  ];
}

function buildReasoningKeyboard(target, availableLevels) {
  return [
    ...chunkIntoRows(
      availableLevels.map((entry) =>
        buildInlineKeyboardButton(
          entry.label,
          `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:${entry.value}`,
        )),
    ),
    [
      buildInlineKeyboardButton("Clear", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:clear`),
      buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
    ],
  ];
}

function buildLanguageKeyboard() {
  return buildSharedLanguageKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildTopicControlPanelMarkup({
  availableModels,
  runtimeModels = availableModels,
  pendingInput = null,
  profiles,
  screen = "root",
  session,
}) {
  if (screen === "wait") {
    return { inline_keyboard: buildWaitKeyboard() };
  }

  if (screen === "suffix") {
    return { inline_keyboard: buildSuffixKeyboard(pendingInput) };
  }

  if (screen === "language") {
    return { inline_keyboard: buildLanguageKeyboard() };
  }

  if (screen === "status") {
    return { inline_keyboard: buildStatusKeyboard() };
  }

  if (screen === "bot_settings") {
    return { inline_keyboard: buildBotSettingsKeyboard(session) };
  }

  if (screen === "agent_model") {
    return { inline_keyboard: buildModelKeyboard("agent", availableModels) };
  }

  if (screen === "agent_reasoning") {
    if (isDeepSeekTopic(session)) {
      return {
        inline_keyboard: buildReasoningKeyboard("agent", DEEPSEEK_REASONING_EFFORTS),
      };
    }
    if (isOpenRouterTopic(session)) {
      return {
        inline_keyboard: buildReasoningKeyboard("agent", OPENROUTER_REASONING_EFFORTS),
      };
    }
    return {
      inline_keyboard: buildReasoningKeyboard(
        "agent",
        getSupportedReasoningLevelsForModel(runtimeModels, profiles.agent.model),
      ),
    };
  }

  return {
    inline_keyboard: buildRootKeyboard(pendingInput, session),
  };
}

export function buildTopicControlPanelPayload({
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
  screen = "root",
  session,
  view,
}) {
  return {
    text: buildTopicControlPanelText({
      availableModels: view.availableModels,
      globalPromptSuffix: view.globalPromptSuffix,
      limitsSummary: view.limitsSummary,
      language,
      notice,
      pendingInput,
      profiles: view.profiles,
      screen,
      session,
      statusText: view.statusText,
      waitState: view.waitState,
    }),
    reply_markup: buildTopicControlPanelMarkup({
      availableModels: view.availableModels,
      runtimeModels: view.runtimeModels,
      pendingInput,
      profiles: view.profiles,
      screen,
      session,
    }),
  };
}

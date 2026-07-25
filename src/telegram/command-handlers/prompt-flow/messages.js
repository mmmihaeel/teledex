import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
} from "../../../i18n/ui-language.js";
import { formatExecutionHostName } from "../../../hosts/topic-host.js";
import { summarizeQueuedPrompt } from "../../../session-manager/prompt-queue.js";

function buildQueueEmptyMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "Agent queue is empty.";
}

function formatQueuePreview(preview) {
  const text = String(preview || "").trim();
  if (!text) {
    return "";
  }

  return `\`${text.replace(/`/gu, "ˋ")}\``;
}

export function buildNoSessionTopicMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Use a dedicated work topic for this.",
    "",
    "General is not used as a working session.",
    "Create a new topic with /new.",
  ].join("\n");
}

export function buildAttachmentNeedsCaptionMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Attachment received.",
    "",
    "Add a caption in the same message, or send the task text in the next message in this topic and I will pair it with this attachment.",
  ].join("\n");
}

export function buildQueueAttachmentNeedsPromptMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Queue attachment received.",
    "",
    "Add a caption in the same message, or send the task text in the next message with /q and I will queue it with this attachment.",
  ].join("\n");
}

export function buildQueueUsageMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "Usage:",
    "/q <text>",
    "/q status",
    "/q delete <position>",
  ].join("\n");
}

export function buildQueueQueuedMessage({
  position,
  preview,
  waitingForCapacity = false,
  language: _language = DEFAULT_UI_LANGUAGE,
}) {
  const lines = [
    `Queued at position ${position}.`,
  ];

  if (waitingForCapacity) {
    lines.push(
      "",
      "I will start it as soon as the current run fully clears.",
    );
  }

  if (preview) {
    lines.push(
      "",
      `Summary: ${formatQueuePreview(preview)}`,
    );
  }

  return lines.join("\n");
}

export function buildQueueDeletedMessage(
  entry,
  position,
  remainingCount,
  _language = DEFAULT_UI_LANGUAGE,
) {
  const preview = formatQueuePreview(
    summarizeQueuedPrompt(entry?.raw_prompt || entry?.prompt),
  );
  const lines = [
    `Removed queue item #${position}.`,
  ];

  if (preview) {
    lines.push("", `Preview: ${preview}`);
  }

  lines.push(
    "",
    `Remaining: ${remainingCount}`,
  );

  return lines.join("\n");
}

export function buildQueueDeleteMissingMessage(position, _language = DEFAULT_UI_LANGUAGE) {
  return `There is no queue item ${position}.`;
}

export function buildQueueStatusMessage(entries = [], language = DEFAULT_UI_LANGUAGE) {
  if (!entries.length) {
    return buildQueueEmptyMessage(language);
  }

  const heading = `Agent queue: ${entries.length}`;
  return [
    heading,
    "",
    ...entries.map((entry, index) => {
      const preview = formatQueuePreview(
        summarizeQueuedPrompt(entry?.raw_prompt || entry?.prompt),
      );
      return `${index + 1}. ${preview || "`...`"}`;
    }),
  ].join("\n");
}

export function buildBusyMessage(session, _language = getSessionUiLanguage(session)) {
  return [
    "I am still working in this topic.",
    "",
    "You can wait for the reply or press /interrupt.",
  ].join("\n");
}

export function buildExecutionHostUnavailableMessage(
  session,
  {
    hostId = null,
    hostLabel = null,
  } = {},
  _language = getSessionUiLanguage(session),
) {
  const hostName = formatExecutionHostName(
    hostLabel,
    hostId || session?.execution_host_id,
  );
  return [
    `This topic is bound to host ${hostName}.`,
    "",
    `Host ${hostName} is unavailable right now.`,
    "Wait for it to come back, or create a new topic on another host.",
  ].join("\n");
}

export function buildMissingTopicBindingMessage(_language = DEFAULT_UI_LANGUAGE) {
  return [
    "This topic has no safe saved host binding.",
    "",
    "I will not start a run here because that could rebind the topic to the wrong host.",
    "Restore the topic state, or create a new topic with /new.",
  ].join("\n");
}

export function buildSteerAcceptedMessage(_language = DEFAULT_UI_LANGUAGE) {
  return "Got it. I will steer this into the current run.";
}

export function buildSteerDeferredMessage({
  position = 1,
  preview = "",
  language: _language = DEFAULT_UI_LANGUAGE,
}) {
  const lines = [
    "Live steer is unavailable right now.",
    "",
    position === 1
      ? "Queued this as the next prompt."
      : `Queued this at position ${position}.`,
  ];

  if (position === 1) {
    lines.push(
      "",
      "I will start it as soon as the current run fully clears.",
    );
  }

  if (preview) {
    lines.push(
      "",
      `Summary: ${formatQueuePreview(preview)}`,
    );
  }

  return lines.join("\n");
}

export function buildCapacityMessage(
  maxParallelSessions,
  _language = DEFAULT_UI_LANGUAGE,
) {
  return `The worker pool is at capacity (${maxParallelSessions}).`;
}

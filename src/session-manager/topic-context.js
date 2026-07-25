import path from "node:path";

import {
  SESSION_PROVIDER_DEEPSEEK,
  SESSION_PROVIDER_OPENROUTER,
  normalizeSessionRuntimeProvider,
} from "./codex-runtime-profiles.js";
import {
  WORK_STYLE_HEADING,
  normalizePromptSuffixText,
} from "./prompt-suffix.js";
import { buildTelegramFileDirectiveInstructions } from "../transport/telegram-file-directive.js";

export const TOPIC_CONTEXT_FILE_NAME = "telegram-topic-context.md";
const CODEX_SPACE_RELATIVE_ROOT =
  "state/apps/teledex/teledex-context";

function formatTopicName(session) {
  return session?.topic_name ?? "unknown";
}

function normalizePosixPath(input) {
  return String(input || "").replace(/\\/gu, path.posix.sep);
}

function isWindowsStylePath(input) {
  return /^[A-Za-z]:[\\/]/u.test(String(input || ""))
    || /^\\\\/u.test(String(input || ""));
}

function isContainedRelativePath(relativePath, pathModule) {
  return relativePath === ""
    || (
      !relativePath.startsWith("..")
      && !pathModule.isAbsolute(relativePath)
    );
}

function resolveContainerMirrorPath(session, hostPath) {
  const hostRoot = String(session?.workspace_binding?.workspace_root_path || "").trim();
  const normalizedHostPath = String(hostPath || "").trim();
  if (!hostRoot || !normalizedHostPath) {
    return null;
  }

  if (isWindowsStylePath(hostRoot) || isWindowsStylePath(normalizedHostPath)) {
    const normalizedHostRoot = path.win32.normalize(hostRoot);
    const normalizedTarget = path.win32.normalize(normalizedHostPath);
    const relative = path.win32.relative(normalizedHostRoot, normalizedTarget);
    if (!isContainedRelativePath(relative, path.win32)) {
      return null;
    }

    const rootName = path.win32.basename(normalizedHostRoot).toLowerCase();
    if (!rootName) {
      return null;
    }

    return relative
      ? path.posix.join("/workspace", rootName, normalizePosixPath(relative))
      : path.posix.join("/workspace", rootName);
  }

  const normalizedHostRoot = normalizePosixPath(hostRoot);
  const normalizedTarget = normalizePosixPath(normalizedHostPath);
  const relative = path.posix.relative(normalizedHostRoot, normalizedTarget);
  if (!isContainedRelativePath(relative, path.posix)) {
    return null;
  }

  const rootName = path.posix.basename(normalizedHostRoot);
  if (!rootName) {
    return null;
  }

  return relative
    ? path.posix.join("/workspace", rootName, relative)
    : path.posix.join("/workspace", rootName);
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function isDeepSeekRuntimeSession(session) {
  return normalizeSessionRuntimeProvider(session?.session_runtime_provider)
    === SESSION_PROVIDER_DEEPSEEK;
}

function isOpenRouterRuntimeSession(session) {
  return normalizeSessionRuntimeProvider(session?.session_runtime_provider)
    === SESSION_PROVIDER_OPENROUTER;
}

function formatRootList(roots = []) {
  return roots
    .map((value) => normalizeOptionalText(value))
    .filter(Boolean)
    .join("; ");
}

function buildTopicContextLines(session, topicContextPath = null) {
  const hostHostRoot = session.workspace_binding?.workspace_root_path ?? null;
  const containerHostRoot = resolveContainerMirrorPath(session, hostHostRoot);
  const containerCwd = resolveContainerMirrorPath(
    session,
    session.workspace_binding?.cwd ?? null,
  );
  const hostCodexSpaceRoot = hostHostRoot
    ? path.join(hostHostRoot, CODEX_SPACE_RELATIVE_ROOT)
    : null;
  const hostSharedMemoryPath = hostCodexSpaceRoot
    ? path.join(hostCodexSpaceRoot, "shared", "rendered", "workspace-reminder.txt")
    : null;
  const hostHostMemoryPath = hostCodexSpaceRoot && session?.execution_host_id
    ? path.join(
      hostCodexSpaceRoot,
      "hosts",
      String(session.execution_host_id),
      "rendered",
      "host-context.txt",
    )
    : null;
  const containerSharedMemoryPath = resolveContainerMirrorPath(session, hostSharedMemoryPath);
  const containerHostMemoryPath = resolveContainerMirrorPath(session, hostHostMemoryPath);
  const lines = [
    "# Telegram topic context",
    "",
    "The live user-turn prompt stays small.",
    "Thread developer instructions carry the short Telegram routing contract.",
    "Read this file only when you need fuller routing, shared-memory, or file-delivery detail.",
    "",
    `session_key: ${session.session_key}`,
    `chat_id: ${session.chat_id}`,
    `topic_id: ${session.topic_id}`,
    `topic_name: ${formatTopicName(session)}`,
    `execution_host_id: ${session.execution_host_id ?? "unknown"}`,
    `cwd: ${session.workspace_binding?.cwd ?? "unknown"}`,
  ];

  if (topicContextPath) {
    lines.push(`topic_context_file: ${topicContextPath}`);
  }

  lines.push(
    "",
    "Routing rules:",
    "- This Telegram topic is the current conversation and default delivery target.",
    '- If the user says "this topic" or "here", they mean this topic.',
    "- Do not ask to reconfirm the topic unless the user explicitly requests a different destination.",
    "- Do not call the raw Telegram Bot API directly for normal delivery from Codex.",
    "- For telegram-file, path: must resolve on the bound execution host, not on the Telegram control-plane host.",
    "- These file-delivery roots apply only to telegram-file sends; they are not a general filesystem sandbox.",
    "- The inline Context block lists the allowed telegram-file roots for the current bound host.",
    "- If you need another host file, copy it into one of the listed bound-host roots first, then send it.",
    ...(containerSharedMemoryPath || containerHostMemoryPath
      ? [
          "",
          "Shared memory:",
          ...(containerSharedMemoryPath
            ? [`- Shared workspace reminder: ${containerSharedMemoryPath}`]
            : []),
          ...(containerHostMemoryPath
            ? [`- Bound-host context summary: ${containerHostMemoryPath}`]
            : []),
          "- Shared memory is only a common layer; host-local auth, config, and runtime state stay on the bound host.",
        ]
      : []),
    ...(hostHostRoot && containerHostRoot
      ? [
          "",
          "MCP path mapping:",
          `- Stored workspace root: ${hostHostRoot}`,
          `- Container-backed MCP mirror root: ${containerHostRoot}`,
          ...(containerCwd
            ? [`- Current cwd inside container-backed MCP tools: ${containerCwd}`]
            : []),
          "- On remote runs, the inline Context block is authoritative for bound-host absolute cwd and telegram-file roots; this file may contain control-plane persisted workspace metadata.",
          "- Pitlane is a host-local CLI/hook for worker topics; Docker MCP is host-local there. Prefer bound-host workspace paths when calling Pitlane; use the container mirror only for container-backed MCP tools.",
          "- Optional worker-local Requests/Playwright MCPs are prefixed by host id, such as workerz-requests or workerz-playwright; unprefixed requests/playwright are the shared local tools.",
        ]
      : []),
    "",
    "File delivery:",
    ...buildTelegramFileDirectiveInstructions(),
    "",
  );

  return lines;
}

export function buildTopicContextFileText(session, { topicContextPath = null } = {}) {
  return `${buildTopicContextLines(session, topicContextPath).join("\n")}\n`;
}

export function buildTopicDeveloperInstructions(
  session,
  {
    topicContextPath = null,
    executionCwd = null,
    fileDeliveryRoots = [],
    controlPlaneHostId = null,
    topicContextFileOnControlPlane = false,
    workStyleText = null,
  } = {},
) {
  const containerHostRoot = resolveContainerMirrorPath(
    session,
    session.workspace_binding?.workspace_root_path ?? null,
  );
  const containerCwd = resolveContainerMirrorPath(
    session,
    session.workspace_binding?.cwd ?? null,
  );
  const hostCodexSpaceRoot = session.workspace_binding?.workspace_root_path
    ? path.join(session.workspace_binding.workspace_root_path, CODEX_SPACE_RELATIVE_ROOT)
    : null;
  const containerSharedMemoryPath = resolveContainerMirrorPath(
    session,
    hostCodexSpaceRoot
      ? path.join(hostCodexSpaceRoot, "shared", "rendered", "workspace-reminder.txt")
      : null,
  );
  const containerHostMemoryPath = resolveContainerMirrorPath(
    session,
    hostCodexSpaceRoot && session?.execution_host_id
      ? path.join(
        hostCodexSpaceRoot,
        "hosts",
        String(session.execution_host_id),
        "rendered",
        "host-context.txt",
      )
      : null,
  );
  const normalizedExecutionCwd =
    normalizeOptionalText(executionCwd)
    || session.workspace_binding?.cwd
    || "unknown";
  const topicId = session.topic_id ?? "unknown";
  const sessionKey = session.session_key ?? "unknown";
  const boundHost = session.execution_host_id ?? "unknown";
  const controlPlaneHost = normalizeOptionalText(controlPlaneHostId);
  const formattedDeliveryRoots = formatRootList(fileDeliveryRoots);
  const isDeepSeekRuntime = isDeepSeekRuntimeSession(session);
  const isOpenRouterRuntime = isOpenRouterRuntimeSession(session);
  const baseLines = [
    "Context:",
    `You are operating inside Telegram topic ${topicId} (${sessionKey}). Treat "this topic" and "here" as this Telegram topic.`,
    "",
    "workspace runtime:",
    ...(controlPlaneHost
      ? [`- control-plane host: ${controlPlaneHost}`]
      : []),
    `- bound execution host: ${boundHost}`,
    `- workspace cwd on bound host: ${normalizedExecutionCwd}`,
    "- run host-local shell/git/docker/ssh checks on the bound execution host unless the user explicitly targets another host.",
    "- use workspace skills for workflow guidance, project registry resolve for structured workspace facts, and targeted host tools for live state.",
    "- when consuming subagent file-result paths, inspect size first and read bounded summary/target sections instead of dumping large result files.",
    ...(isDeepSeekRuntime
      ? [
          "- DeepSeek runs through the workspace Codex provider path: use the same skills, project registry/MCP lookups, shell discipline, file delivery rules, and host boundaries as Codex topics.",
        ]
      : []),
    ...(isOpenRouterRuntime
      ? [
          "- OpenRouter runs through the workspace Codex provider path: use the same skills, project registry/MCP lookups, shell discipline, file delivery rules, and host boundaries as Codex topics.",
        ]
      : []),
    "- dormant shared docs/templates/bootstrap notes are source-maintenance surfaces only; do not treat them as workflow memory or project/service metadata.",
    "- if the bound host is unavailable, say so; do not silently rebind to another host.",
    ...(containerHostRoot
      ? [
          `- host-local Pitlane accepts bound-host workspace paths; container-backed tools may expose the mirror root ${containerHostRoot} as a fallback`,
        ]
      : []),
    ...(containerCwd && containerCwd !== containerHostRoot
      ? [`- current cwd inside container-backed MCP tools: ${containerCwd}`]
      : []),
    ...(controlPlaneHost
      ? [
          `- shared MCP and shared operator memory are anchored on ${controlPlaneHost}; host-local auth, config, runtime state, and repo files belong to the bound execution host.`,
        ]
      : []),
    "",
    "Telegram delivery:",
    "- keep Telegram as the delivery surface unless the user explicitly asks for another channel.",
    "- during long or multi-step work, write short natural-language progress notes; do not expose hidden chain-of-thought.",
    "- send files back to this topic unless the user says otherwise.",
    `- telegram-file paths must be absolute paths on the bound host ${boundHost}, not on the Telegram control-plane host.`,
    ...(formattedDeliveryRoots
      ? [`- allowed telegram-file send roots: ${formattedDeliveryRoots}`]
      : []),
    "",
    "Extra context:",
    ...(containerSharedMemoryPath
      ? [
          `- shared operator memory: ${containerSharedMemoryPath}`,
        ]
      : []),
    ...(containerHostMemoryPath
      ? [
          `- bound-host operator memory: ${containerHostMemoryPath}`,
        ]
      : []),
    ...(topicContextFileOnControlPlane
      ? [
          "- topic context file stays on the Telegram control-plane host for this remote run; rely on the inline rules above unless you need extra routing or file-send detail.",
        ]
      : []),
    ...(!topicContextFileOnControlPlane && topicContextPath
      ? [
          `- topic context file: ${topicContextPath}`,
          "- read the topic context file only when you need extra routing, delivery, or continuity details.",
        ]
      : []),
  ];
  const normalizedWorkStyle = normalizePromptSuffixText(workStyleText);
  if (normalizedWorkStyle) {
    baseLines.push("", WORK_STYLE_HEADING, normalizedWorkStyle);
  }

  return baseLines.join("\n");
}

export function buildTopicContextPrompt(session, options = {}) {
  return buildTopicDeveloperInstructions(session, options);
}

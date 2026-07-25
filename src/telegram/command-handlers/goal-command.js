import { runCodexAppServerV2GoalRpc } from "../../app-server-v2/goal-client.js";
import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
} from "../../i18n/ui-language.js";
import {
  normalizeSessionRuntimeProvider,
  resolveSessionCodexRuntimeProfile,
  SESSION_PROVIDER_CODEX,
} from "../../session-manager/codex-runtime-profiles.js";
import { extractBotCommand } from "../command-parsing.js";
import { extractPromptText } from "../incoming-attachments.js";

const GOAL_OBJECTIVE_PREVIEW_CHARS = 1800;

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function isAppServerV2Session(session) {
  const backend = String(
    session?.last_run_backend
    || session?.codex_backend
    || "",
  ).trim().toLowerCase();
  return backend === "app-server-v2";
}

function isAppServerV2Enabled(config) {
  return config?.codexEnableAppServerV2 === true;
}

function isConfiguredAppServerV2Backend(config) {
  return String(config?.codexGatewayBackend || "").trim().toLowerCase() === "app-server-v2";
}

function isCodexProviderSession(session) {
  const provider = normalizeSessionRuntimeProvider(session?.session_runtime_provider);
  return !provider || provider === SESSION_PROVIDER_CODEX;
}

export function parseGoalCommandArgs(args = "") {
  const normalized = normalizeOptionalText(args);
  if (!normalized) {
    return { action: "get" };
  }

  const match = normalized.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  const first = String(match?.[1] || "").toLowerCase();
  const remainder = String(match?.[2] || "").trim();
  if (first === "get" || first === "status" || first === "show") {
    return { action: "get" };
  }
  if (first === "clear" || first === "reset") {
    return { action: "clear" };
  }
  if (first === "pause" || first === "paused") {
    return { action: "set", status: "paused" };
  }
  if (first === "resume" || first === "active") {
    return { action: "set", status: "active" };
  }
  if (first === "complete" || first === "done") {
    return { action: "set", status: "complete" };
  }
  if (first === "budget") {
    const budget = Number.parseInt(remainder.split(/\s+/u)[0] || "", 10);
    if (!Number.isFinite(budget) || budget < 0) {
      return { action: "invalid", reason: "invalid-budget" };
    }
    return { action: "set", tokenBudget: budget };
  }
  if (first === "set") {
    const objective = normalizeOptionalText(remainder);
    return objective
      ? { action: "set", objective, status: "active" }
      : { action: "invalid", reason: "empty-objective" };
  }

  return { action: "set", objective: normalized, status: "active" };
}

export function buildGoalCommandArgsFromMessages(messages, botUsername = null) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (promptMessages.length === 0) {
    return "";
  }

  const parts = [];
  const firstMessage = promptMessages[0];
  const parsedCommand = extractBotCommand(firstMessage, botUsername);
  if (parsedCommand?.name === "goal") {
    const commandArgs = normalizeOptionalText(parsedCommand.args);
    if (commandArgs) {
      parts.push(commandArgs);
    }
  } else {
    const text = extractPromptText(firstMessage, { trim: true });
    if (text) {
      parts.push(text);
    }
  }

  for (const entry of promptMessages.slice(1)) {
    const text = extractPromptText(entry, { trim: true });
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n").trim();
}

function formatObjectivePreview(objective, _language = DEFAULT_UI_LANGUAGE) {
  if (objective.length <= GOAL_OBJECTIVE_PREVIEW_CHARS) {
    return objective;
  }

  const preview = objective.slice(0, GOAL_OBJECTIVE_PREVIEW_CHARS).trimEnd();
  const suffix = `\n... (${GOAL_OBJECTIVE_PREVIEW_CHARS}/${objective.length} chars shown; full objective is stored in the app-server-v2 thread)`;
  return `${preview}${suffix}`;
}

function formatGoal(goal, language = DEFAULT_UI_LANGUAGE) {
  if (!goal) {
    return "No active goal is set for this app-server-v2 thread.";
  }

  const objective = formatObjectivePreview(
    normalizeOptionalText(goal.objective) || "(empty)",
    language,
  );
  const status = normalizeOptionalText(goal.status) || "unknown";
  const budget = goal.tokenBudget ?? goal.token_budget ?? null;
  const used = goal.tokensUsed ?? goal.tokens_used ?? null;
  const budgetLine = budget === null || budget === undefined
    ? ""
    : `\nBudget: ${used ?? 0}/${budget} tokens`;
  return `Goal: ${objective}\nStatus: ${status}${budgetLine}`;
}

function formatClearResult(result, _language = DEFAULT_UI_LANGUAGE) {
  const cleared = result?.cleared === true;
  return cleared ? "Goal cleared." : "No goal was set.";
}

function formatGoalError(error, _language = DEFAULT_UI_LANGUAGE) {
  const message = normalizeOptionalText(error?.message) || "unknown error";
  return `Goal RPC failed: ${message}`;
}

function shouldStartGoalContinuationRun(parsed) {
  if (parsed?.action !== "set") {
    return false;
  }
  if (normalizeOptionalText(parsed.objective)) {
    return parsed.status === undefined || parsed.status === null || parsed.status === "active";
  }
  return parsed.status === "active";
}

function formatGoalRunStarted(parsed, language = DEFAULT_UI_LANGUAGE) {
  const goal = {
    objective: normalizeOptionalText(parsed.objective) || "(current goal)",
    status: "active",
    tokenBudget: parsed.tokenBudget ?? null,
    tokensUsed: 0,
  };
  const prefix = "Goal accepted; started app-server-v2 continuation.";
  return `${prefix}\n\n${formatGoal(goal, language)}`;
}

function formatGoalRunStartFailure(started, _language = DEFAULT_UI_LANGUAGE) {
  const reason = normalizeOptionalText(started?.reason) || "unknown";
  return `Goal was not started: ${reason}.`;
}

export async function handleGoalCommand({
  config,
  message = null,
  session,
  workerPool,
  args = "",
  execFileImpl,
  spawnImpl,
  platform = process.platform,
}) {
  const language = getSessionUiLanguage(session);
  const parsed = parseGoalCommandArgs(args);
  if (parsed.action === "invalid") {
    return {
      responseText: "Usage: /goal [objective|set <objective>|pause|resume|complete|clear|budget <tokens>]",
      reason: parsed.reason,
    };
  }
  if (!isAppServerV2Enabled(config)) {
    return {
      responseText: "/goal is available only when app-server-v2 is enabled.",
      reason: "app-server-v2-disabled",
    };
  }
  if (!isCodexProviderSession(session)) {
    return {
      responseText: "/goal is available only for Codex app-server-v2 topics.",
      reason: "provider-not-codex",
    };
  }

  const activeRun = workerPool?.getActiveRun?.(session.session_key);
  const activeController = activeRun?.controller;
  const activeBackend = String(activeRun?.state?.backend || "").trim().toLowerCase();
  if (
    activeController
    && activeBackend === "app-server-v2"
    && activeRun?.state?.finalizing !== true
  ) {
    try {
      if (parsed.action === "get") {
        const result = await activeController.getGoal();
        return { responseText: formatGoal(result?.goal, language), reason: "goal-get-active" };
      }
      if (parsed.action === "clear") {
        const result = await activeController.clearGoal();
        return { responseText: formatClearResult(result, language), reason: "goal-clear-active" };
      }
      const result = await activeController.setGoal({
        objective: parsed.objective ?? null,
        status: parsed.status ?? null,
        tokenBudget: parsed.tokenBudget,
      });
      return { responseText: formatGoal(result?.goal, language), reason: "goal-set-active" };
    } catch (error) {
      return { responseText: formatGoalError(error, language), reason: "goal-active-error" };
    }
  }

  if (!isAppServerV2Session(session)) {
    return {
      responseText: "/goal is available only for app-server-v2 Codex topics.",
      reason: "backend-not-app-server-v2",
    };
  }

  if (
    isConfiguredAppServerV2Backend(config)
    && isAppServerV2Session(session)
    && shouldStartGoalContinuationRun(parsed)
    && message
    && typeof workerPool?.startPromptRun === "function"
  ) {
    const responseText = formatGoalRunStarted(parsed, language);
    const started = await workerPool.startPromptRun({
      session,
      prompt: normalizeOptionalText(parsed.objective) || "/goal resume",
      rawPrompt: normalizeOptionalText(parsed.objective)
        ? `/goal ${parsed.objective}`
        : "/goal resume",
      message,
      attachments: [],
      initialProgressText: responseText,
      initialProgressReplyToMessageId: Number.isInteger(message.message_id)
        ? message.message_id
        : null,
      holdInitialProgressUntilNaturalUpdate: true,
      goalStart: {
        objective: parsed.objective ?? null,
        status: parsed.status ?? "active",
        tokenBudget: parsed.tokenBudget,
      },
    });
    if (started?.ok) {
      return {
        responseText: null,
        deliveredResponseText: responseText,
        reason: "goal-run-started",
      };
    }
    return {
      responseText: formatGoalRunStartFailure(started, language),
      reason: started?.reason === "busy" ? "goal-run-busy" : "goal-run-start-failed",
    };
  }

  if (!normalizeOptionalText(session.codex_thread_id)) {
    return {
      responseText: "Start one app-server-v2 run before using this /goal action.",
      reason: "missing-thread",
    };
  }

  const executionHost =
    typeof workerPool?.hostRegistryService?.resolveSessionExecution === "function"
      ? await workerPool.hostRegistryService.resolveSessionExecution(session)
      : null;
  if (executionHost?.ok === false) {
    const hostLabel = executionHost.hostLabel || executionHost.hostId || "unknown";
    return {
      responseText: `Execution host unavailable: ${hostLabel}`,
      reason: "host-unavailable",
    };
  }

  let modelProviderConfig = null;
  try {
    const runtimeProfile = await resolveSessionCodexRuntimeProfile({
      session,
      config,
    });
    modelProviderConfig = runtimeProfile?.modelProviderConfig ?? null;
  } catch {
    // Goal status/control sidecars can still run without provider-specific env hints.
  }

  try {
    const { result } = await runCodexAppServerV2GoalRpc({
      action: parsed.action,
      codexBinPath: config.codexBinPath,
      config,
      execFileImpl,
      executionHost,
      modelProviderConfig,
      objective: parsed.objective ?? null,
      platform,
      session,
      spawnImpl,
      status: parsed.status ?? null,
      tokenBudget: parsed.tokenBudget,
    });
    if (parsed.action === "get" || parsed.action === "set") {
      return { responseText: formatGoal(result?.goal, language), reason: "goal-rpc" };
    }
    return { responseText: formatClearResult(result, language), reason: "goal-rpc" };
  } catch (error) {
    return { responseText: formatGoalError(error, language), reason: "goal-rpc-error" };
  }
}

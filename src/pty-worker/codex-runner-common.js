import { summarizeHookRun } from "./hook-economy.js";

export function hasChildExited(child) {
  if (!child) {
    return true;
  }

  return child.exitCode !== null || child.signalCode !== null;
}

export function createErrorFromJsonRpc(error, fallbackMessage) {
  const message =
    error?.message || fallbackMessage || "Codex app-server request failed";
  const normalized = new Error(message);
  if (Number.isFinite(error?.code)) {
    normalized.code = error.code;
  }
  if (error?.data !== undefined) {
    normalized.data = error.data;
  }
  return normalized;
}

export function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function isRelevantWarning(line) {
  const text = String(line || "");
  return (
    text.includes("codex app-server (") ||
    text.includes("listening on:") ||
    text.includes("readyz:") ||
    text.includes("healthz:") ||
    text.includes("binds localhost only") ||
    text.includes("failed to open state db") ||
    text.includes("state db discrepancy") ||
    text.includes("Failed to delete shell snapshot") ||
    text.includes("failed to unwatch") ||
    (
      text.includes("codex_core::tools::router") &&
      text.includes("write_stdin failed:") &&
      (
        text.includes("Unknown process id") ||
        text.includes("stdin is closed")
      )
    )
  );
}

function summarizeUsageValue(usage) {
  if (!usage) {
    return null;
  }

  return {
    input_tokens: usage.inputTokens ?? null,
    cached_input_tokens: usage.cachedInputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    reasoning_tokens: usage.reasoningOutputTokens ?? null,
    total_tokens: usage.totalTokens ?? null,
  };
}

function summarizeUsage(event) {
  return summarizeUsageValue(event?.params?.tokenUsage?.last);
}

function summarizeTotalUsage(event) {
  return summarizeUsageValue(event?.params?.tokenUsage?.total);
}

function summarizeGoalValue(goal) {
  if (!goal || typeof goal !== "object") {
    return null;
  }

  return {
    thread_id: goal.threadId ?? goal.thread_id ?? null,
    objective: goal.objective ?? null,
    status: goal.status ?? null,
    token_budget: goal.tokenBudget ?? goal.token_budget ?? null,
    tokens_used: goal.tokensUsed ?? goal.tokens_used ?? null,
    time_used_seconds: goal.timeUsedSeconds ?? goal.time_used_seconds ?? null,
    created_at: goal.createdAt ?? goal.created_at ?? null,
    updated_at: goal.updatedAt ?? goal.updated_at ?? null,
  };
}

export function summarizeCodexEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "thread.started") {
    return {
      kind: "thread",
      eventType: "thread.started",
      text: `Codex thread started: ${event.thread_id}`,
      threadId: event.thread_id,
    };
  }

  if (event.type === "turn.started") {
    return {
      kind: "turn",
      eventType: "turn.started",
      text: "Codex turn started",
      turnId: event.turn_id ?? null,
    };
  }

  if (event.type === "turn.completed") {
    return {
      kind: "turn",
      eventType: "turn.completed",
      text: "Codex turn completed",
      turnId: event.turn_id ?? null,
      usage: event.active_usage || event.last_usage || event.usage || null,
      totalUsage: event.usage || null,
      turnStatus: event.turn?.status || null,
      turnError: event.turn?.error || null,
    };
  }

  if (event.type === "item.started" && event.item?.type === "command_execution") {
    return {
      kind: "command",
      eventType: "item.started",
      text: `Running command: ${event.item.command}`,
      command: event.item.command,
    };
  }

  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    return {
      kind: "command",
      eventType: "item.completed",
      text: `Completed command: ${event.item.command}`,
      command: event.item.command,
      exitCode: event.item.exit_code,
      aggregatedOutput: event.item.aggregated_output || "",
    };
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return {
      kind: "agent_message",
      eventType: "item.completed",
      text: event.item.text || "",
      messagePhase: event.item.phase || "final_answer",
      threadId: event.thread_id ?? null,
      turnId: event.turn_id ?? null,
    };
  }

  const method = event.method;
  if (method === "thread/started") {
    const threadId = event.params?.thread?.id || null;
    if (!threadId) {
      return null;
    }

    return {
      kind: "thread",
      eventType: "thread.started",
      text: `Codex thread started: ${threadId}`,
      threadId,
    };
  }

  if (method === "turn/started") {
    return {
      kind: "turn",
      eventType: "turn.started",
      text: "Codex turn started",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turn?.id || null,
    };
  }

  if (method === "turn/completed") {
    return {
      kind: "turn",
      eventType: "turn.completed",
      text: "Codex turn completed",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turn?.id || null,
      usage: null,
      turnStatus: event.params?.turn?.status || null,
      turnError: event.params?.turn?.error || null,
    };
  }

  if (method === "thread/tokenUsage/updated") {
    return {
      kind: "turn",
      eventType: "thread.tokenUsage.updated",
      text: "Codex token usage updated",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
      usage: summarizeUsage(event),
      totalUsage: summarizeTotalUsage(event),
    };
  }

  if (method === "thread/goal/updated") {
    return {
      kind: "goal",
      eventType: "thread.goal.updated",
      text: "Codex goal updated",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
      goal: summarizeGoalValue(event.params?.goal),
    };
  }

  if (method === "hook/started" || method === "hook/completed") {
    const hook = summarizeHookRun(event.params?.run);
    if (!hook) {
      return null;
    }

    return {
      kind: "hook",
      eventType: method === "hook/started" ? "hook.started" : "hook.completed",
      text: method === "hook/started" ? "Codex hook started" : "Codex hook completed",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
      hook,
    };
  }

  const item = event.params?.item;
  if (method === "item/started" && item?.type === "commandExecution") {
    return {
      kind: "command",
      eventType: "item.started",
      text: `Running command: ${item.command}`,
      command: item.command,
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
    };
  }

  if (method === "item/completed" && item?.type === "commandExecution") {
    return {
      kind: "command",
      eventType: "item.completed",
      text: `Completed command: ${item.command}`,
      command: item.command,
      exitCode: item.exitCode,
      aggregatedOutput: item.aggregatedOutput || "",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
    };
  }

  if (method === "item/completed" && item?.type === "agentMessage") {
    return {
      kind: "agent_message",
      eventType: "item.completed",
      text: item.text || "",
      messagePhase: item.phase || "final_answer",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
    };
  }

  return null;
}

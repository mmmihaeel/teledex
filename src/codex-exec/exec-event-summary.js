function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function isLikelyNonPrimaryExecEvent(event, item = event?.item ?? null) {
  const markers = [
    event?.source,
    event?.origin,
    event?.agent_kind,
    event?.agent_type,
    item?.source,
    item?.origin,
    item?.agent_kind,
    item?.agent_type,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (
    markers.some((value) =>
      value.includes("subagent")
      || value.includes("sub-agent")
      || value.includes("collab"),
    )
  ) {
    return true;
  }

  return Boolean(
    event?.is_subagent === true
    || item?.is_subagent === true
    || item?.sender_thread_id
    || item?.agent_path
    || item?.agent_id,
  );
}

export function summarizeCodexExecEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "thread.started") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    return {
      kind: "thread",
      eventType: "thread.started",
      text: `Codex thread started: ${event.thread_id}`,
      threadId: event.thread_id || null,
    };
  }

  if (event.type === "turn.started") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    return {
      kind: "turn",
      eventType: "turn.started",
      text: "Codex turn started",
      turnId: event.turn_id ?? null,
    };
  }

  if (event.type === "turn.completed") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    return {
      kind: "turn",
      eventType: "turn.completed",
      text: "Codex turn completed",
      turnId: event.turn_id ?? null,
      usage: event.active_usage || event.last_usage || event.usage || null,
      totalUsage: event.usage || null,
      turnStatus: "completed",
    };
  }

  if (event.type === "turn.failed") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    const message = event.error?.message || "Codex turn failed";
    return {
      kind: "turn",
      eventType: "turn.failed",
      text: message,
      turnId: event.turn_id ?? null,
      turnStatus: "failed",
      turnError: event.error || { message },
    };
  }

  if (event.type === "error") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    const message = event.message || "Codex exec stream error";
    return {
      kind: "turn",
      eventType: "error",
      text: message,
      turnStatus: "failed",
      turnError: { message },
    };
  }

  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) {
    return null;
  }

  const item = event.item || null;
  if (!item || typeof item !== "object") {
    return null;
  }
  if (isLikelyNonPrimaryExecEvent(event, item)) {
    return null;
  }

  if (item.type === "command_execution") {
    const command = item.command || "command";
    return {
      kind: "command",
      eventType: event.type,
      text: event.type === "item.completed"
        ? `Completed command: ${command}`
        : `Running command: ${command}`,
      command,
      exitCode: item.exit_code ?? null,
      aggregatedOutput: item.aggregated_output || "",
      streamDelta: item.stream_delta === true,
    };
  }

  if (item.type === "agent_message") {
    if (event.type !== "item.completed") {
      return null;
    }
    const text = normalizeOptionalText(item.text);
    if (!text) {
      return null;
    }
    return {
      kind: "agent_message",
      eventType: event.type,
      text,
      messagePhase: "commentary",
      progressSource: "agent_message",
    };
  }

  if (item.type === "reasoning") {
    const text = normalizeOptionalText(item.text);
    if (!text) {
      return null;
    }
    return {
      kind: "agent_message",
      eventType: event.type,
      text,
      messagePhase: "commentary",
      progressSource: "reasoning",
    };
  }

  return null;
}

import {
  isLikelyNonPrimaryExecEvent,
  summarizeCodexExecEvent,
} from "./exec-event-summary.js";

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function createJsonlProcessor({ onEvent, onWarning, onRuntimeState }) {
  let resolveTerminalEvent;
  const terminalEventPromise = new Promise((resolve) => {
    resolveTerminalEvent = resolve;
  });
  const state = {
    latestThreadId: null,
    sawTurnCompleted: false,
    sawTurnFailed: false,
    fatalError: null,
    latestAgentMessageText: null,
    emittedFinalAnswer: false,
    malformedLineCount: 0,
  };
  let chain = Promise.resolve();
  let chainError = null;

  const handleEvent = async (event) => {
    const nonPrimaryEvent = isLikelyNonPrimaryExecEvent(event);
    let terminalEvent = null;
    if (event.type === "thread.started" && event.thread_id && !nonPrimaryEvent) {
      state.latestThreadId = event.thread_id;
      await onRuntimeState?.({ threadId: event.thread_id });
    }
    if (event.type === "turn.started" && !nonPrimaryEvent) {
      state.latestAgentMessageText = null;
      state.emittedFinalAnswer = false;
    } else if (event.type === "turn.completed" && !nonPrimaryEvent) {
      state.sawTurnCompleted = true;
      terminalEvent = event;
    } else if (event.type === "turn.failed" && !nonPrimaryEvent) {
      state.sawTurnFailed = true;
      state.fatalError = event.error || { message: "Codex turn failed" };
      terminalEvent = event;
    } else if (event.type === "error" && !nonPrimaryEvent) {
      state.fatalError = { message: event.message || "Codex exec stream error" };
      terminalEvent = event;
    }

    const summary = summarizeCodexExecEvent(event);
    if (summary?.threadId) {
      state.latestThreadId = summary.threadId;
    }
    if (
      summary?.kind === "agent_message"
      && summary.eventType === "item.completed"
      && summary.progressSource === "agent_message"
      && typeof summary.text === "string"
      && summary.text.trim()
    ) {
      state.latestAgentMessageText = summary.text;
    }
    if (summary) {
      await onEvent?.(summary);
    }
    if (
      event.type === "turn.completed"
      && !nonPrimaryEvent
      && !state.emittedFinalAnswer
      && typeof state.latestAgentMessageText === "string"
      && state.latestAgentMessageText.trim()
    ) {
      state.emittedFinalAnswer = true;
      await onEvent?.({
        kind: "agent_message",
        eventType: "turn.completed",
        text: state.latestAgentMessageText,
        messagePhase: "final_answer",
      });
    }
    if (terminalEvent) {
      resolveTerminalEvent(terminalEvent);
    }
  };

  return {
    state,
    terminalEventPromise,
    ingestLine(line) {
      chain = chain
        .then(async () => {
          const trimmed = String(line || "").trim();
          if (!trimmed) {
            return;
          }

          const event = safeJsonParse(trimmed);
          if (!event) {
            state.malformedLineCount += 1;
            onWarning?.(`Malformed codex exec JSONL ignored: ${trimmed.slice(0, 200)}`);
            return;
          }

          await handleEvent(event);
        })
        .catch((error) => {
          chainError = error;
        });
    },
    async settle() {
      await chain;
      if (chainError) {
        throw chainError;
      }
    },
  };
}

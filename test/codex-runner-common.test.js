import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  buildCodexArgs,
  buildTurnInput,
  hasChildExited,
  isRelevantWarning,
  summarizeCodexEvent,
  waitForListenUrl,
} from "../src/pty-worker/codex-runner.js";

test("buildCodexArgs builds app-server args", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    'approval_policy="never"',
  ]);
});

test("buildCodexArgs appends model and reasoning overrides", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    contextWindow: 400000,
    autoCompactTokenLimit: 375000,
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
    "-c",
    'model="gpt-5.4-mini"',
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "model_context_window=400000",
    "-c",
    "model_auto_compact_token_limit=375000",
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    'approval_policy="never"',
  ]);
});

test("buildCodexArgs appends provider config for app-server fallback", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
    model: "deepseek-v4-pro",
    modelProvider: "deepseek",
    modelProviderConfig: {
      name: "DeepSeek",
      base_url: "https://api.deepseek.com/v1",
      env_key: "DEEPSEEK_API_KEY",
      wire_api: "deepseek_chat",
      requires_openai_auth: false,
      request_max_retries: 6,
      stream_max_retries: 8,
      stream_idle_timeout_ms: 300000,
    },
    reasoningEffort: "xhigh",
    configOverrides: {
      "features.tool_search_always_defer_mcp_tools": true,
    },
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
    "-c",
    'model="deepseek-v4-pro"',
    "-c",
    'model_provider="deepseek"',
    "-c",
    'model_providers.deepseek={ name="DeepSeek", base_url="https://api.deepseek.com/v1", env_key="DEEPSEEK_API_KEY", wire_api="deepseek_chat", requires_openai_auth=false, request_max_retries=6, stream_max_retries=8, stream_idle_timeout_ms=300000 }',
    "-c",
    'model_reasoning_effort="xhigh"',
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    'approval_policy="never"',
    "-c",
    "features.tool_search_always_defer_mcp_tools=true",
  ]);
});

test("buildCodexArgs appends custom OpenRouter provider config for app-server fallback", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
    model: "moonshotai/kimi-k2.6",
    modelProvider: "openrouter_lab",
    modelProviderConfig: {
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      env_key: "OPENROUTER_API_KEY",
      wire_api: "responses",
      requires_openai_auth: false,
      supports_websockets: false,
      request_max_retries: 8,
      stream_max_retries: 10,
      stream_idle_timeout_ms: 900000,
    },
    reasoningEffort: "high",
    configOverrides: {
      "features.tool_search_always_defer_mcp_tools": true,
    },
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
    "-c",
    'model="moonshotai/kimi-k2.6"',
    "-c",
    'model_provider="openrouter_lab"',
    "-c",
    'model_providers.openrouter_lab={ name="OpenRouter", base_url="https://openrouter.ai/api/v1", env_key="OPENROUTER_API_KEY", wire_api="responses", requires_openai_auth=false, supports_websockets=false, request_max_retries=8, stream_max_retries=10, stream_idle_timeout_ms=900000 }',
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    'approval_policy="never"',
    "-c",
    "features.tool_search_always_defer_mcp_tools=true",
  ]);
});

test("buildCodexArgs preserves hyphenated custom provider ids", () => {
  const args = buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
    model: "moonshotai/kimi-k2.6",
    modelProvider: "openrouter-lab",
    modelProviderConfig: {
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      env_key: "OPENROUTER_API_KEY",
      wire_api: "responses",
      requires_openai_auth: false,
    },
  });

  assert.equal(args.includes('model_provider="openrouter-lab"'), true);
  assert.equal(
    args.includes(
      'model_providers.openrouter-lab={ name="OpenRouter", base_url="https://openrouter.ai/api/v1", env_key="OPENROUTER_API_KEY", wire_api="responses", requires_openai_auth=false }',
    ),
    true,
  );
});

test("buildCodexArgs allows sandbox and approval overrides", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    'approval_policy="on-request"',
  ]);
});

test("buildTurnInput emits text and local images", () => {
  assert.deepEqual(buildTurnInput({
    prompt: "Review this.",
    imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
  }), [
    {
      type: "text",
      text: "Review this.",
    },
    {
      type: "localImage",
      path: "/tmp/a.png",
    },
    {
      type: "localImage",
      path: "/tmp/b.jpg",
    },
  ]);
});

test("summarizeCodexEvent extracts app-server command and agent message events", () => {
  const commandSummary = summarizeCodexEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        command: "ls",
        exitCode: 0,
        aggregatedOutput: "one\ntwo\n",
      },
    },
  });
  const messageSummary = summarizeCodexEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        text: "done",
        phase: "commentary",
      },
    },
  });

  assert.equal(commandSummary.kind, "command");
  assert.equal(commandSummary.exitCode, 0);
  assert.equal(commandSummary.turnId, "turn-1");
  assert.equal(messageSummary.kind, "agent_message");
  assert.equal(messageSummary.text, "done");
  assert.equal(messageSummary.messagePhase, "commentary");
});

test("summarizeCodexEvent keeps turn usage details from app-server notifications", () => {
  const turnSummary = summarizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 98244,
          inputTokens: 98115,
          cachedInputTokens: 55504,
          outputTokens: 129,
          reasoningOutputTokens: 41,
        },
        last: {
          totalTokens: 18244,
          inputTokens: 18215,
          cachedInputTokens: 5504,
          outputTokens: 29,
          reasoningOutputTokens: 11,
        },
      },
    },
  });

  assert.equal(turnSummary.kind, "turn");
  assert.equal(turnSummary.eventType, "thread.tokenUsage.updated");
  assert.deepEqual(turnSummary.usage, {
    input_tokens: 18215,
    cached_input_tokens: 5504,
    output_tokens: 29,
    reasoning_tokens: 11,
    total_tokens: 18244,
  });
  assert.deepEqual(turnSummary.totalUsage, {
    input_tokens: 98115,
    cached_input_tokens: 55504,
    output_tokens: 129,
    reasoning_tokens: 41,
    total_tokens: 98244,
  });
});

test("summarizeCodexEvent keeps app-server goal accounting updates", () => {
  const goalSummary = summarizeCodexEvent({
    method: "thread/goal/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      goal: {
        threadId: "thread-1",
        objective: "ship the goal",
        status: "complete",
        tokenBudget: null,
        tokensUsed: 1917681,
        timeUsedSeconds: 3963,
        createdAt: 1780000000,
        updatedAt: 1780003963,
      },
    },
  });

  assert.equal(goalSummary.kind, "goal");
  assert.equal(goalSummary.eventType, "thread.goal.updated");
  assert.equal(goalSummary.threadId, "thread-1");
  assert.equal(goalSummary.turnId, "turn-1");
  assert.deepEqual(goalSummary.goal, {
    thread_id: "thread-1",
    objective: "ship the goal",
    status: "complete",
    token_budget: null,
    tokens_used: 1917681,
    time_used_seconds: 3963,
    created_at: 1780000000,
    updated_at: 1780003963,
  });
});

test("summarizeCodexEvent keeps safe app-server hook economy summaries", () => {
  const summary = summarizeCodexEvent({
    method: "hook/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      run: {
        id: "run-1",
        eventName: "postToolUse",
        handlerType: "command",
        executionMode: "sync",
        source: "plugin",
        key: "rtk-codex-plugin@community-local:postToolUse:0",
        pluginId: "rtk-codex-plugin@community-local",
        currentHash: "sha256:abc",
        trustStatus: "trusted",
        status: "completed",
        durationMs: 17,
        entries: [{ kind: "feedback", text: "do not expose this raw hook text" }],
        economy: {
          decisionType: "compact",
          commandClass: "unified_exec",
          outputOriginalBytes: 20000,
          outputModelVisibleBytes: 4000,
          estimatedSavedTokens: 4000,
          artifactRefs: ["/tmp/artifact.txt"],
        },
      },
    },
  });

  assert.equal(summary.kind, "hook");
  assert.equal(summary.eventType, "hook.completed");
  assert.equal(summary.threadId, "thread-1");
  assert.equal(summary.turnId, "turn-1");
  assert.deepEqual(summary.hook, {
    id: "run-1",
    eventName: "postToolUse",
    handlerType: "command",
    executionMode: "sync",
    source: "plugin",
    key: "rtk-codex-plugin@community-local:postToolUse:0",
    pluginId: "rtk-codex-plugin@community-local",
    currentHash: "sha256:abc",
    trustStatus: "trusted",
    status: "completed",
    durationMs: 17,
    economy: {
      decisionType: "compact",
      commandClass: "unified_exec",
      bypassReason: null,
      exactOutputReason: null,
      originalBytes: null,
      replacementBytes: null,
      modelVisibleBytes: null,
      outputOriginalBytes: 20000,
      outputModelVisibleBytes: 4000,
      tokenBudget: null,
      originalTokenCount: null,
      estimatedSavedTokens: 4000,
      artifactRefs: ["/tmp/artifact.txt"],
    },
  });
});

test("summarizeCodexEvent still understands legacy exec events", () => {
  const turnSummary = summarizeCodexEvent({
    type: "turn.completed",
    turn_id: "turn-legacy",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
    },
  });

  assert.equal(turnSummary.kind, "turn");
  assert.equal(turnSummary.eventType, "turn.completed");
  assert.equal(turnSummary.turnId, "turn-legacy");
  assert.deepEqual(turnSummary.usage, {
    input_tokens: 10,
    output_tokens: 2,
  });
});

test("summarizeCodexEvent prefers active usage for completed exec turns", () => {
  const turnSummary = summarizeCodexEvent({
    type: "turn.completed",
    turn_id: "turn-active-usage",
    usage: {
      input_tokens: 114902,
      cached_input_tokens: 74240,
      output_tokens: 885,
      reasoning_output_tokens: 230,
    },
    active_usage: {
      input_tokens: 22517,
      cached_input_tokens: 21376,
      output_tokens: 417,
      reasoning_output_tokens: 21,
    },
  });

  assert.equal(turnSummary.kind, "turn");
  assert.equal(turnSummary.eventType, "turn.completed");
  assert.equal(turnSummary.turnId, "turn-active-usage");
  assert.deepEqual(turnSummary.usage, {
    input_tokens: 22517,
    cached_input_tokens: 21376,
    output_tokens: 417,
    reasoning_output_tokens: 21,
  });
  assert.deepEqual(turnSummary.totalUsage, {
    input_tokens: 114902,
    cached_input_tokens: 74240,
    output_tokens: 885,
    reasoning_output_tokens: 230,
  });
});

test("summarizeCodexEvent keeps legacy agent message phase and ids", () => {
  const summary = summarizeCodexEvent({
    type: "item.completed",
    thread_id: "thread-legacy",
    turn_id: "turn-legacy",
    item: {
      type: "agent_message",
      text: "still thinking",
      phase: "commentary",
    },
  });

  assert.equal(summary.kind, "agent_message");
  assert.equal(summary.messagePhase, "commentary");
  assert.equal(summary.threadId, "thread-legacy");
  assert.equal(summary.turnId, "turn-legacy");
});

test("hasChildExited ignores child.killed until the process really exits", () => {
  assert.equal(
    hasChildExited({
      killed: true,
      exitCode: null,
      signalCode: null,
    }),
    false,
  );
  assert.equal(
    hasChildExited({
      killed: true,
      exitCode: null,
      signalCode: "SIGTERM",
    }),
    true,
  );
  assert.equal(
    hasChildExited({
      killed: false,
      exitCode: 0,
      signalCode: null,
    }),
    true,
  );
});

test("isRelevantWarning ignores recoverable stale write_stdin router noise", () => {
  assert.equal(
    isRelevantWarning(
      "\u001b[31mERROR\u001b[0m codex_core::tools::router: error=write_stdin failed: Unknown process id 81651",
    ),
    true,
  );
  assert.equal(
    isRelevantWarning(
      "\u001b[31mERROR\u001b[0m codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
    ),
    true,
  );
  assert.equal(
    isRelevantWarning(
      "\u001b[31mERROR\u001b[0m codex_core::tools::router: error=write_stdin failed: permission denied",
    ),
    false,
  );
});

test("waitForListenUrl accepts app-server banner from stderr", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutReader = readline.createInterface({ input: stdout });
  const stderrReader = readline.createInterface({ input: stderr });
  const child = new EventEmitter();

  const wait = waitForListenUrl(stdoutReader, stderrReader, child, {
    timeoutMs: 1000,
  });
  stderr.write("codex app-server (WebSockets)\n");
  stderr.write("  listening on: ws://127.0.0.1:43123\n");

  const listenUrl = await wait;
  assert.equal(listenUrl, "ws://127.0.0.1:43123");

  stdoutReader.close();
  stderrReader.close();
  stdout.end();
  stderr.end();
});

test("waitForListenUrl includes recent app-server output in timeout errors", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutReader = readline.createInterface({ input: stdout });
  const stderrReader = readline.createInterface({ input: stderr });
  const child = new EventEmitter();

  const wait = waitForListenUrl(stdoutReader, stderrReader, child, {
    timeoutMs: 25,
  });
  stdout.write("booting codex app-server\n");
  stderr.write("warning: slow init path\n");

  await assert.rejects(wait, (error) => {
    assert.match(error.message, /Timed out waiting for Codex app-server to start/u);
    assert.match(error.message, /\[stdout\] booting codex app-server/u);
    assert.match(error.message, /\[stderr\] warning: slow init path/u);
    return true;
  });

  stdoutReader.close();
  stderrReader.close();
  stdout.end();
  stderr.end();
});

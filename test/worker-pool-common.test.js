import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRunFailureText,
  buildProgressText,
  buildThreadDeveloperInstructions,
  isCodexResumeStreamDisconnectError,
  isCodexThreadCorruptionError,
  isContextWindowExceededText,
  isTransientModelCapacityError,
} from "../src/pty-worker/worker-pool-common.js";

function buildSession(overrides = {}) {
  return {
    session_key: "-1000000:2203",
    chat_id: "-1000000",
    topic_id: "2203",
    topic_name: "codex-telegram",
    execution_host_id: "local",
    workspace_binding: {
      workspace_root_path: "/path/to/workspace",
      cwd: "/path/to/workspace",
      cwd_relative_to_workspace_root: ".",
      worktree_path: "/path/to/workspace",
    },
    ...overrides,
  };
}

test("buildProgressText keeps meaningful commentary visible", () => {
  const text = buildProgressText({
    status: "running",
    latestProgressMessage: "First I verify the actual lifecycle run, then fix the targeted race.",
  }, "eng");

  assert.match(text, /First I verify the actual lifecycle run/u);
  assert.match(text, /\n\n\.\.\.$/u);
});

test("buildProgressText ignores internal orchestration leakage and keeps the last visible thought", () => {
  const rusText = buildProgressText({
    status: "running",
    latestProgressMessage: "Starting a subagent to inspect the repository.",
    latestSummaryKind: "agent_message",
    latestSummary: "First I verify the actual lifecycle run, then fix the finalization race.",
  }, "eng");
  assert.match(rusText, /First I verify the actual lifecycle run/u);
  assert.doesNotMatch(rusText, /subagent/u);

  const engText = buildProgressText({
    status: "running",
    latestProgressMessage: "Spawning a subagent to inspect the repo before I continue.",
    latestSummaryKind: "agent_message",
    latestSummary: "First I will verify the real lifecycle path, then patch the stale owner handoff.",
  }, "eng");
  assert.match(engText, /First I will verify the real lifecycle path/u);
  assert.doesNotMatch(engText, /subagent|inspect the repo/u);
});

test("buildProgressText falls back to a bare spinner when internal leakage is all that remains", () => {
  const text = buildProgressText({
    status: "running",
    latestProgressMessage: "Spawning a subagent to inspect the repo before I continue.",
    latestSummaryKind: "agent_message",
    latestSummary: "Spawning a subagent to inspect the repo before I continue.",
  }, "eng");

  assert.equal(text, "...");
});

test("buildProgressText keeps generic natural-language progress visible", () => {
  const text = buildProgressText({
    status: "running",
    latestProgressMessage: "Reviewing the code and current state.",
    latestSummaryKind: "agent_message",
    latestSummary: "Reviewing the code and current state.",
  }, "eng");

  assert.match(text, /Reviewing the code and current state/u);
  assert.match(text, /\n\n\.\.\.$/u);
});

test("buildProgressText keeps a long silent run on a bare spinner", () => {
  const text = buildProgressText({
    status: "running",
    startedAtMs: Date.now() - 20_000,
  }, "eng");

  assert.equal(text, "...");
});

test("buildProgressText keeps startup on a bare spinner", () => {
  const text = buildProgressText({
    status: "starting",
  }, "eng");

  assert.equal(text, "...");
});

test("buildProgressText hides internal live-steer restart labels", () => {
  const text = buildProgressText({
    status: "running",
    latestSummaryKind: "rebuild",
    latestSummary: "live-steer-restart",
  }, "eng");

  assert.equal(text, "...");
  assert.doesNotMatch(text, /live-steer-restart/u);
});

test("buildProgressText keeps the previous thought while live steer rebuilds", () => {
  const text = buildProgressText({
    status: "rebuilding",
    resumeMode: "live-steer-restart",
    threadId: "thread-1",
    holdProgressUntilNaturalUpdate: true,
    latestProgressMessage: "Keeping this update until the next Codex event.",
    latestSummaryKind: "rebuild",
    latestSummary: "live-steer-restart",
  }, "eng");

  assert.match(text, /Keeping this update/u);
  assert.doesNotMatch(text, /Continuing the same Codex thread/u);
  assert.doesNotMatch(text, /live-steer-restart/u);
});

test("buildRunFailureText does not present graceful code 0 exit as a crash", () => {
  const text = buildRunFailureText({
    exitCode: 0,
    signal: null,
    warnings: [],
  }, "eng");

  assert.match(text, /Codex app-server ended without a final reply/u);
  assert.doesNotMatch(text, /exited with code 0/u);
});

test("buildRunFailureText keeps raw exec stderr out of user-visible failures", () => {
  const text = buildRunFailureText({
    backend: "exec-json",
    exitCode: 1,
    signal: null,
    abortReason: "exec_stream_incomplete",
    warnings: [
      "codex exec stderr:\nsecret-ish runtime detail",
    ],
  }, "eng");

  assert.match(text, /Codex turn aborted \(exec_stream_incomplete\)/u);
  assert.doesNotMatch(text, /secret-ish runtime detail/u);
  assert.doesNotMatch(text, /codex exec stderr/u);
});

test("buildRunFailureText surfaces DeepSeek runtime failure warning", () => {
  const text = buildRunFailureText({
    backend: "deepseek-http",
    exitCode: 0,
    signal: null,
    warnings: [
      "DeepSeek HTTP runtime failed: Stream stalled: no data received for 300s, closing stream",
    ],
  }, "eng");

  assert.match(text, /DeepSeek HTTP runtime failed/u);
  assert.match(text, /Stream stalled/u);
  assert.doesNotMatch(text, /ended without a final reply/u);
});

test("buildThreadDeveloperInstructions appends the effective topic work style", () => {
  const instructions = buildThreadDeveloperInstructions(
    buildSession({
      prompt_suffix_enabled: true,
      prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
    }),
    {
      getTopicContextPath() {
        return "/path/to/teledex-state/sessions/-1000000/2203/telegram-topic-context.md";
      },
    },
    {
      globalPromptSuffix: {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    },
  );

  assert.match(instructions, /Context:/u);
  assert.match(instructions, /You are operating inside Telegram topic 2203/u);
  assert.match(instructions, /workspace runtime:\n- bound execution host: local/u);
  assert.match(instructions, /do not silently rebind/u);
  assert.match(instructions, /Telegram delivery:\n- keep Telegram as the delivery surface/u);
  assert.match(instructions, /Extra context:/u);
  assert.match(instructions, /\n\nWork Style:\nTOPIC\nKeep it short in this thread\./u);
  assert.doesNotMatch(instructions, /GLOBAL/u);
});

test("buildThreadDeveloperInstructions renders remote host paths as bound-host absolute paths", () => {
  const instructions = buildThreadDeveloperInstructions(
    buildSession({
      execution_host_id: "workera",
      execution_host_label: "workera",
    }),
    {
      getTopicContextPath() {
        return "/path/to/teledex-state/sessions/-1000000/2203/telegram-topic-context.md";
      },
    },
    {
      currentHostId: "local",
      executionHost: {
        host_id: "workera",
        host_user: "workera",
        host_root: "/path/to/worker-workspace",
        state_root: "/path/to/worker-workspace-state",
        workspace_root: "/path/to/worker-workspace",
        worker_runtime_root:
          "/path/to/worker-workspace-state/apps/teledex",
        codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
      },
    },
  );

  assert.match(instructions, /control-plane host: local/u);
  assert.match(instructions, /bound execution host: workera/u);
  assert.match(instructions, /workspace cwd on bound host: \/path\/to\/worker-workspace/u);
  assert.match(
    instructions,
    /allowed telegram-file send roots: \/path\/to\/worker-workspace/u,
  );
  assert.match(
    instructions,
    /topic context file stays on the Telegram control-plane host for this remote run/u,
  );
  assert.doesNotMatch(instructions, /workspace cwd on bound host: ~\/workspace/u);
  assert.doesNotMatch(instructions, /allowed telegram-file send roots: .*~\/workspace/u);
  assert.doesNotMatch(instructions, /workspace cwd on bound host: \/home\/example/u);
  assert.doesNotMatch(instructions, /allowed telegram-file send roots: .*\/home\/example/u);
});

test("buildThreadDeveloperInstructions suppresses work style when topic suffix routing is off", () => {
  const instructions = buildThreadDeveloperInstructions(
    buildSession({
      prompt_suffix_topic_enabled: false,
      prompt_suffix_enabled: true,
      prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
    }),
    {
      getTopicContextPath() {
        return "/path/to/teledex-state/sessions/-1000000/2203/telegram-topic-context.md";
      },
    },
    {
      globalPromptSuffix: {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    },
  );

  assert.doesNotMatch(instructions, /Work Style:/u);
  assert.doesNotMatch(instructions, /Never overcomplicate/u);
});


test("isTransientModelCapacityError matches upstream model-capacity errors", () => {
  assert.equal(
    isTransientModelCapacityError(
      new Error("Selected model is at capacity. Please try a different model."),
    ),
    true,
  );
  assert.equal(isTransientModelCapacityError(new Error("permission denied")), false);
});

test("isContextWindowExceededText matches known upstream context-window failures", () => {
  assert.equal(
    isContextWindowExceededText(
      "Codex ran out of room in the model's context window. Start a new thread.",
    ),
    true,
  );
  assert.equal(
    isContextWindowExceededText("400 context_length_exceeded: input too large"),
    true,
  );
  assert.equal(
    isContextWindowExceededText("The request exceeds the token limit for this model."),
    true,
  );
  assert.equal(isContextWindowExceededText("Selected model is at capacity."), false);
});

test("isCodexThreadCorruptionError matches orphan tool-output and resume stream failures", () => {
  assert.equal(
    isCodexThreadCorruptionError(
      `Codex exec failed: {
        "error": {
          "type": "invalid_request_error",
          "message": "No tool call found for function call output with call_id call_123."
        },
        "status": 400
      }`,
    ),
    true,
  );
  const resumeStreamError =
    "Codex exec failed: Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)";
  assert.equal(isCodexResumeStreamDisconnectError(resumeStreamError), true);
  assert.equal(isCodexThreadCorruptionError(resumeStreamError), true);
  assert.equal(isCodexThreadCorruptionError("Selected model is at capacity."), false);
  assert.equal(
    isCodexResumeStreamDisconnectError("stream disconnected after response.completed"),
    false,
  );
});

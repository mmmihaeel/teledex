import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTopicContextFileText,
  buildTopicContextPrompt,
} from "../src/session-manager/topic-context.js";

const session = {
  session_key: "-1000000:2203",
  chat_id: "-1000000",
  topic_id: "2203",
  topic_name: "codex-telegram",
  execution_host_id: "workera",
  workspace_binding: {
    workspace_root_path: "/path/to/workspace",
    cwd: "/path/to/workspace",
  },
};

test("buildTopicContextPrompt stays compact and points to the topic context file", () => {
  const prompt = buildTopicContextPrompt(session, {
    topicContextPath:
      "/path/to/teledex-state/sessions/-1000000/2203/telegram-topic-context.md",
    fileDeliveryRoots: [
      "/path/to/workspace",
      "/path/to/teledex-state/sessions/-1000000/2203",
      "/tmp",
    ],
  });

  assert.match(prompt, /Context:/u);
  assert.match(prompt, /Telegram topic 2203 \(-1000000:2203\)/u);
  assert.match(prompt, /workspace runtime:/u);
  assert.match(prompt, /bound execution host: workera/u);
  assert.match(prompt, /workspace cwd on bound host: \/path\/to\/workspace/u);
  assert.match(prompt, /run host-local shell\/git\/docker\/ssh checks on the bound execution host/u);
  assert.match(prompt, /use workspace skills for workflow guidance, project registry resolve for structured workspace facts/u);
  assert.match(prompt, /subagent file-result paths/u);
  assert.match(prompt, /bounded summary\/target sections/u);
  assert.match(prompt, /dormant shared docs\/templates\/bootstrap notes are source-maintenance surfaces only/u);
  assert.doesNotMatch(prompt, /scout\.search/u);
  assert.match(prompt, /telegram-file paths must be absolute paths on the bound host workera/u);
  assert.match(prompt, /write short natural-language progress notes/u);
  assert.match(prompt, /allowed telegram-file send roots:/u);
  assert.match(
    prompt,
    /host-local Pitlane accepts bound-host workspace paths; container-backed tools may expose the mirror root \/workspace\/workspace as a fallback/u,
  );
  assert.match(prompt, /shared operator memory: \/workspace\/workspace\/state\/apps\/teledex\/teledex-context\/shared\/rendered\/workspace-reminder\.txt/u);
  assert.match(prompt, /bound-host operator memory: \/workspace\/workspace\/state\/apps\/teledex\/teledex-context\/hosts\/workera\/rendered\/host-context\.txt/u);
  assert.match(prompt, /topic context file:/u);
  assert.match(prompt, /read the topic context file only when you need extra routing, delivery, or continuity details/u);
  assert.doesNotMatch(prompt, /File delivery:/u);
  assert.doesNotMatch(prompt, /```telegram-file/u);
  assert.doesNotMatch(prompt, /chat_id:/u);
  assert.doesNotMatch(prompt, /topic_name:/u);
  assert.doesNotMatch(prompt, /raw Telegram Bot API/u);
});

test("buildTopicContextPrompt keeps remote host-bound delivery guidance inline", () => {
  const prompt = buildTopicContextPrompt(session, {
    executionCwd: "/path/to/worker-workspace/work/public/project",
    fileDeliveryRoots: [
      "/path/to/worker-workspace/work/public/project",
      "/path/to/worker-workspace-state/apps/teledex",
    ],
    controlPlaneHostId: "local",
    topicContextFileOnControlPlane: true,
  });

  assert.match(prompt, /control-plane host: local/u);
  assert.match(prompt, /bound execution host: workera/u);
  assert.match(prompt, /workspace cwd on bound host: \/path\/to\/worker-workspace\/work\/public\/project/u);
  assert.match(
    prompt,
    /shared MCP and shared operator memory are anchored on local; host-local auth, config, runtime state, and repo files belong to the bound execution host/u,
  );
  assert.match(prompt, /telegram-file paths must be absolute paths on the bound host workera/u);
  assert.match(
    prompt,
    /allowed telegram-file send roots: .*\/path\/to\/worker-workspace\/work\/public\/project.*\/path\/to\/worker-workspace-state\/apps\/teledex/u,
  );
  assert.match(
    prompt,
    /topic context file stays on the Telegram control-plane host for this remote run/u,
  );
  assert.doesNotMatch(prompt, /scout\.search/u);
  assert.doesNotMatch(prompt, /topic context file: .*telegram-topic-context\.md/u);
  assert.doesNotMatch(prompt, /workspace cwd on bound host: \/home\/example/u);
  assert.doesNotMatch(prompt, /allowed telegram-file send roots: .*\/home\/example/u);
});

test("buildTopicContextPrompt can append a Work Style section to base instructions", () => {
  const prompt = buildTopicContextPrompt(session, {
    workStyleText: "TOPIC\nKeep it short in this thread.",
  });

  assert.match(prompt, /Context:/u);
  assert.match(prompt, /\n\nWork Style:\nTOPIC\nKeep it short in this thread\./u);
});

test("buildTopicContextPrompt keeps DeepSeek topics on normal workspace Codex routing", () => {
  const prompt = buildTopicContextPrompt({
    ...session,
    session_runtime_provider: "deepseek",
  });

  assert.match(prompt, /DeepSeek runs through the workspace Codex provider path/u);
  assert.match(prompt, /same skills, project registry\/MCP lookups, shell discipline/u);
  assert.doesNotMatch(prompt, /tool_search_tool_bm25/u);
});

test("buildTopicContextPrompt keeps OpenRouter topics on normal workspace Codex routing", () => {
  const prompt = buildTopicContextPrompt({
    ...session,
    session_runtime_provider: "openrouter",
  });

  assert.match(prompt, /OpenRouter runs through the workspace Codex provider path/u);
  assert.match(prompt, /same skills, project registry\/MCP lookups, shell discipline/u);
  assert.doesNotMatch(prompt, /tool_search_tool_bm25/u);
});

test("buildTopicContextPrompt does not include DeepSeek tool names for Codex topics", () => {
  const prompt = buildTopicContextPrompt({
    ...session,
    session_runtime_provider: "codex",
  });

  assert.doesNotMatch(prompt, /tool_search_tool_bm25/u);
});

test("buildTopicContextFileText keeps the detailed safe file-delivery instructions", () => {
  const text = buildTopicContextFileText(session, {
    topicContextPath:
      "/path/to/teledex-state/sessions/-1000000/2203/telegram-topic-context.md",
  });

  assert.match(text, /# Telegram topic context/u);
  assert.match(text, /The live user-turn prompt stays small/u);
  assert.match(text, /Thread developer instructions carry the short Telegram routing contract/u);
  assert.match(text, /chat_id: -1000000/u);
  assert.match(text, /Container-backed MCP mirror root: \/workspace\/workspace/u);
  assert.match(text, /Current cwd inside container-backed MCP tools: \/workspace\/workspace/u);
  assert.match(text, /Shared workspace reminder: \/workspace\/workspace\/state\/apps\/teledex\/teledex-context\/shared\/rendered\/workspace-reminder\.txt/u);
  assert.match(text, /Bound-host context summary: \/workspace\/workspace\/state\/apps\/teledex\/teledex-context\/hosts\/workera\/rendered\/host-context\.txt/u);
  assert.match(text, /File delivery:/u);
  assert.match(text, /path: must resolve on the bound execution host/u);
  assert.match(text, /Example below is inert until you add action: send:/u);
  assert.match(text, /```telegram-file/u);
  assert.match(text, /path: <absolute-host-path-to-file>/u);
  assert.match(text, /Pitlane is a host-local CLI\/hook for worker topics/u);
  assert.match(text, /Prefer bound-host workspace paths when calling Pitlane/u);
  assert.doesNotMatch(text, /Pitlane and Docker MCPs/u);
  assert.doesNotMatch(text, /^action: send$/mu);
});

test("buildTopicContextFileText normalizes mixed-case Windows workspace paths into the container mirror", () => {
  const text = buildTopicContextFileText({
    ...session,
    workspace_binding: {
      workspace_root_path: "C:\\workspace",
      cwd: "c:\\workspace\\apps\\service",
    },
  });

  assert.match(text, /Stored workspace root: C:\\workspace/u);
  assert.match(text, /Container-backed MCP mirror root: \/workspace\/workspace/u);
  assert.match(
    text,
    /Current cwd inside container-backed MCP tools: \/workspace\/workspace\/apps\/service/u,
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { buildRunCodexTaskArgs } from "../src/cli/host-executor.js";

test("buildRunCodexTaskArgs forwards developerInstructions into runCodexTask", () => {
  const args = buildRunCodexTaskArgs({
    cwd: "/path/to/worker-workspace",
    prompt: "User Prompt:\nrun a quick task",
    baseInstructions: "Context:\n- host: workerz, cwd: /path/to/worker-workspace",
    imagePaths: ["~/input.png"],
    knownRolloutPath: "/path/to/worker-workspace-state/codex/rollout.jsonl",
    modelProvider: "deepseek",
    modelProviderConfig: {
      name: "DeepSeek",
      wire_api: "deepseek_chat",
      requires_openai_auth: false,
    },
    contextWindow: 400000,
    autoCompactTokenLimit: 375000,
    configOverrides: {
      "features.tool_search_always_defer_mcp_tools": true,
    },
  });

  assert.equal(
    args.developerInstructions,
    "Context:\n- host: workerz, cwd: /path/to/worker-workspace",
  );
  assert.equal(
    args.baseInstructions,
    "Context:\n- host: workerz, cwd: /path/to/worker-workspace",
  );
  assert.match(args.cwd, /[\\/]worker-workspace$/u);
  assert.match(args.imagePaths[0], /[\\/]input\.png$/u);
  assert.match(args.knownRolloutPath, /[\\/]rollout\.jsonl$/u);
  assert.equal(args.contextWindow, 400000);
  assert.equal(args.autoCompactTokenLimit, 375000);
  assert.equal(args.modelProvider, "deepseek");
  assert.deepEqual(args.modelProviderConfig, {
    name: "DeepSeek",
    wire_api: "deepseek_chat",
    requires_openai_auth: false,
  });
  assert.deepEqual(args.configOverrides, {
    "features.tool_search_always_defer_mcp_tools": true,
  });
});

test("buildRunCodexTaskArgs prefers explicit developerInstructions over legacy baseInstructions", () => {
  const args = buildRunCodexTaskArgs({
    cwd: "/path/to/worker-workspace",
    prompt: "User Prompt:\nrun a quick task",
    developerInstructions: "Context:\n- fresh developer context",
    baseInstructions: "Context:\n- legacy base context",
  });

  assert.equal(args.developerInstructions, "Context:\n- fresh developer context");
  assert.equal(args.baseInstructions, "Context:\n- legacy base context");
});

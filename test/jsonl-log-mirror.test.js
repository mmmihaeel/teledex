import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCompactJsonlLogMirror,
  resetCompactJsonlLogMirrorArtifacts,
} from "../src/codex-exec/jsonl-log-mirror.js";

test("compact JSONL mirror stores repeated goal objectives as artifact refs", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-jsonl-mirror-"));
  const logPath = path.join(stateRoot, "exec-json-run.jsonl");
  const objective = `Implement token hardening ${"x".repeat(1200)}`;

  try {
    const warnings = [];
    const mirror = createCompactJsonlLogMirror({
      jsonlLogPath: logPath,
      onWarning: (warning) => warnings.push(warning),
    });
    assert.ok(mirror);

    for (const tokensUsed of [100, 200, 300]) {
      mirror.appendEvent({
        method: "thread/goal/updated",
        params: {
          goal: {
            objective,
            status: "active",
            tokensUsed,
          },
        },
      });
    }
    await mirror.settle();

    assert.deepEqual(warnings, []);
    const lines = (await fs.readFile(logPath, "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 3);

    const events = lines.map((line) => JSON.parse(line));
    const compacted = events.map((event) => event.params.goal.objective_compacted);
    assert.equal(compacted[0].repeated, false);
    assert.equal(compacted[1].repeated, true);
    assert.equal(compacted[2].repeated, true);
    assert.equal(new Set(compacted.map((entry) => entry.hash)).size, 1);
    assert.ok(compacted[0].bytes > 1000);
    assert.ok(events[0].params.goal.objective.length < objective.length);
    assert.equal(lines.some((line) => line.includes(objective)), false);

    const artifactPath = compacted[0].artifact_path;
    assert.equal(await fs.readFile(artifactPath, "utf8"), objective);
    assert.equal(compacted[1].artifact_path, artifactPath);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("compact JSONL mirror also compacts app-server goal update shape", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-jsonl-mirror-"));
  const logPath = path.join(stateRoot, "app-server-v2.jsonl");

  try {
    const mirror = createCompactJsonlLogMirror({ jsonlLogPath: logPath });
    mirror.appendLine(
      JSON.stringify({
        type: "thread.goal.updated",
        goal: {
          objective: `Ship the policy ${"y".repeat(700)}`,
          status: "active",
        },
      }),
    );
    await mirror.settle();

    const event = JSON.parse(await fs.readFile(logPath, "utf8"));
    assert.ok(event.goal.objective_compacted.hash);
    assert.ok(event.goal.objective_compacted.artifact_path);
    assert.ok(event.goal.objective.length < event.goal.objective_compacted.bytes);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("compact JSONL mirror keeps short goal objectives inline", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-jsonl-mirror-"));
  const logPath = path.join(stateRoot, "exec-json-run.jsonl");
  const objective = "Short follow-up task.";

  try {
    const mirror = createCompactJsonlLogMirror({ jsonlLogPath: logPath });
    mirror.appendEvent({
      method: "thread/goal/updated",
      params: {
        goal: {
          objective,
          status: "active",
        },
      },
    });
    await mirror.settle();

    const event = JSON.parse(await fs.readFile(logPath, "utf8"));
    assert.equal(event.params.goal.objective, objective);
    assert.equal(event.params.goal.objective_compacted, undefined);
    await assert.rejects(
      fs.stat(path.join(stateRoot, "artifacts", "goal-objectives")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("compact JSONL mirror stores large command output as artifact", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-jsonl-mirror-"));
  const logPath = path.join(stateRoot, "exec-json-run.jsonl");
  const largeOutput = `${"secret-looking-line\n".repeat(700)}tail\n`;

  try {
    const mirror = createCompactJsonlLogMirror({ jsonlLogPath: logPath });
    mirror.appendEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "rg token .",
        aggregated_output: largeOutput,
      },
    });
    await mirror.settle();

    const event = JSON.parse(await fs.readFile(logPath, "utf8"));
    assert.match(event.item.aggregated_output, /command output compacted/u);
    assert.doesNotMatch(event.item.aggregated_output, /secret-looking-line/u);
    assert.ok(event.item.output_compacted.bytes > 8192);
    assert.equal(
      await fs.readFile(event.item.output_compacted.artifact_path, "utf8"),
      largeOutput,
    );
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("reset compact JSONL mirror artifacts removes only mirror-owned artifact dirs", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-jsonl-mirror-"));
  const logPath = path.join(stateRoot, "exec-json-run.jsonl");
  const artifactsRoot = path.join(stateRoot, "artifacts");

  try {
    await fs.mkdir(path.join(artifactsRoot, "goal-objectives"), { recursive: true });
    await fs.mkdir(path.join(artifactsRoot, "tool-output"), { recursive: true });
    await fs.mkdir(path.join(artifactsRoot, "diff"), { recursive: true });
    await fs.writeFile(path.join(artifactsRoot, "goal-objectives", "old.txt"), "goal", "utf8");
    await fs.writeFile(path.join(artifactsRoot, "tool-output", "old.txt"), "output", "utf8");
    await fs.writeFile(path.join(artifactsRoot, "diff", "keep.patch"), "diff", "utf8");

    await resetCompactJsonlLogMirrorArtifacts({ jsonlLogPath: logPath });

    await assert.rejects(
      fs.stat(path.join(artifactsRoot, "goal-objectives")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      fs.stat(path.join(artifactsRoot, "tool-output")),
      { code: "ENOENT" },
    );
    assert.equal(
      await fs.readFile(path.join(artifactsRoot, "diff", "keep.patch"), "utf8"),
      "diff",
    );
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test("compact JSONL mirror stores app-server commandExecution output as artifact", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-jsonl-mirror-"));
  const logPath = path.join(stateRoot, "app-server-v2.jsonl");
  const largeOutput = "x".repeat(9000);

  try {
    const mirror = createCompactJsonlLogMirror({ jsonlLogPath: logPath });
    mirror.appendEvent({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          command: "git diff",
          aggregatedOutput: largeOutput,
        },
      },
    });
    await mirror.settle();

    const event = JSON.parse(await fs.readFile(logPath, "utf8"));
    assert.match(event.params.item.aggregatedOutput, /command output compacted/u);
    assert.ok(event.params.item.output_compacted.artifact_path);
    assert.equal(
      await fs.readFile(event.params.item.output_compacted.artifact_path, "utf8"),
      largeOutput,
    );
    assert.equal(event.params.item.output_compacted.bytes, largeOutput.length);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

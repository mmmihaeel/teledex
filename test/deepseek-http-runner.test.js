import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { runRemoteDeepSeekHttpTask } from "../src/deepseek-runtime/deepseek-http-runner.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.stdinChunks = [];
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  stdinText() {
    return Buffer.concat(this.stdinChunks).toString("utf8");
  }

  kill() {
    return true;
  }

  close(code = 0, signal = null) {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("close", code, signal);
    });
  }
}

test("runRemoteDeepSeekHttpTask accepts resumed thread payloads returned under thread.id", async () => {
  const spawnCalls = [];
  const task = await runRemoteDeepSeekHttpTask({
    currentHostId: "local",
    executionHost: {
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
        workspace_root: "/path/to/worker-workspace",
      },
    },
    session: {
      workspace_binding: {
        workspace_root_path: "/path/to/workspace",
        cwd: "/path/to/workspace",
      },
    },
    sessionKey: "chat:topic",
    sessionThreadId: "thr-existing",
    deepSeekApiUrl: "http://127.0.0.1:7879",
    model: "deepseek-v4-flash",
    prompt: "hello",
    developerInstructions: [
      "Context:",
      "- bound execution host: workera",
      "",
      "Work Style:",
      "Keep it concise, practical, and focused.",
    ].join("\n"),
    spawnImpl(command, args) {
      spawnCalls.push({ command, args });
      return new FakeChild();
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "ssh");
  assert.ok(spawnCalls[0].args.join(" ").includes(".id // .thread.id // empty"));
  assert.ok(spawnCalls[0].args.join(" ").includes("max_output_chars=60000"));
  assert.ok(spawnCalls[0].args.join(" ").includes("[truncated by gateway]"));
  assert.ok(spawnCalls[0].args.join(" ").includes("after 3600s"));
  assert.ok(spawnCalls[0].args.join(" ").includes('{type:"turn.started", turn_id:$id}'));
  assert.ok(spawnCalls[0].args.join(" ").includes('{type:"turn.completed", turn_id:$id, usage:$usage}'));
  assert.ok(spawnCalls[0].args.join(" ").includes('{type:"turn.failed", turn_id:$id, error:{message:$message}}'));
  assert.ok(spawnCalls[0].args.join(" ").includes("stream_delta:$stream_delta"));
  assert.ok(spawnCalls[0].args.join(" ").includes("emit_deepseek_progress_items"));
  assert.ok(!spawnCalls[0].args.join(" ").includes("DeepSeek: using tool"));
  assert.ok(!spawnCalls[0].args.join(" ").includes("DeepSeek: completed tool"));
  assert.ok(spawnCalls[0].args.join(" ").includes('[[ "$kind" == "status" && "$message" == Executing\\ * ]] && continue'));
  assert.ok(!spawnCalls[0].args.join(" ").includes("DeepSeek Pro: reasoning"));
  assert.ok(!spawnCalls[0].args.join(" ").includes("Keep it concise, practical"));
  assert.ok(spawnCalls[0].args.join(" ").includes("system_prompt_file"));
  assert.ok(spawnCalls[0].args.join(" ").includes("/fork"));
  assert.ok(spawnCalls[0].args.join(" ").includes('[[ "$message" == "Session context synced" ]] && continue'));
  assert.deepEqual(JSON.parse(task.child.stdinText()), {
    prompt: "hello",
    system_prompt: [
      "Context:",
      "- bound execution host: workera",
      "",
      "Work Style:",
      "Keep it concise, practical, and focused.",
    ].join("\n"),
  });

  task.child.close(1, null);
  const result = await task.finished;
  assert.equal(result.resumeReplacement, null);
});

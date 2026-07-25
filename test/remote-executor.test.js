import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  syncGatewayRepoToRemote,
} from "../src/pty-worker/remote-executor/staging.js";
import {
  assertSafeRemoteGatewayRepoRoot,
  buildRemoteStartRunParams,
  runRemoteCodexTask,
} from "../src/pty-worker/remote-executor.js";

class FakeRemoteExecutorChild extends EventEmitter {
  constructor() {
    super();
    this.pid = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signal = null;
    this.buffer = "";
    this.stdin.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.flushRequests();
    });
  }

  flushRequests() {
    while (this.buffer.includes("\n")) {
      const lineEnd = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (!line.trim()) {
        continue;
      }
      const request = JSON.parse(line);
      if (request.method === "startRun") {
        queueMicrotask(() => {
          this.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { message: "remote start failed" },
          })}\n`);
        });
      }
    }
  }

  kill(signal = "SIGTERM") {
    this.signal = signal;
    return true;
  }
}

test("buildRemoteStartRunParams keeps developerInstructions on the remote startRun payload", () => {
  const params = buildRemoteStartRunParams({
    resolvedHost: {
      codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
    },
    codexBinPath: "/fallback/codex",
    remoteCwd: "/path/to/worker-workspace",
    prompt: "User Prompt:\nrun a quick task",
    baseInstructions: "Context:\n- host: workerz, cwd: /path/to/worker-workspace",
    localizedImagePaths: ["/tmp/image.png"],
    sessionKey: "-1000000:2203",
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
    params.developerInstructions,
    "Context:\n- host: workerz, cwd: /path/to/worker-workspace",
  );
  assert.equal(
    params.baseInstructions,
    "Context:\n- host: workerz, cwd: /path/to/worker-workspace",
  );
  assert.equal(
    params.codexBinPath,
    "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
  );
  assert.equal(params.contextWindow, 400000);
  assert.equal(params.autoCompactTokenLimit, 375000);
  assert.equal(params.modelProvider, "deepseek");
  assert.deepEqual(params.modelProviderConfig, {
    name: "DeepSeek",
    wire_api: "deepseek_chat",
    requires_openai_auth: false,
  });
  assert.deepEqual(params.configOverrides, {
    "features.tool_search_always_defer_mcp_tools": true,
  });
});

test("buildRemoteStartRunParams omits blank developer/base instructions", () => {
  const params = buildRemoteStartRunParams({
    resolvedHost: {},
    codexBinPath: "/fallback/codex",
    remoteCwd: "/path/to/worker-workspace",
    prompt: "User Prompt:\nrun a quick task",
    baseInstructions: "   ",
  });

  assert.equal("developerInstructions" in params, false);
  assert.equal("baseInstructions" in params, false);
});

test("buildRemoteStartRunParams prefers explicit developerInstructions over legacy baseInstructions", () => {
  const params = buildRemoteStartRunParams({
    resolvedHost: {},
    codexBinPath: "/fallback/codex",
    remoteCwd: "/path/to/worker-workspace",
    prompt: "User Prompt:\nrun a quick task",
    developerInstructions: "Context:\n- fresh developer context",
    baseInstructions: "Context:\n- legacy base context",
  });

  assert.equal(params.developerInstructions, "Context:\n- fresh developer context");
  assert.equal(params.baseInstructions, "Context:\n- fresh developer context");
});

test("assertSafeRemoteGatewayRepoRoot rejects broad destructive sync targets", () => {
  assert.doesNotThrow(() =>
    assertSafeRemoteGatewayRepoRoot(
      "/path/to/workspace/apps/teledex",
      "workera",
    ));
  assert.doesNotThrow(() =>
    assertSafeRemoteGatewayRepoRoot(
      "/path/to/worker-workspace/apps/teledex",
      "workera",
    ));
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot(
      "/path/to/workspace/apps/telegram-gateway",
      "workera",
    ),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot("/path/to/workspace", "workera"),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot("/tmp/teledex", "workera"),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot("~", "workera"),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot(
      "apps/teledex",
      "workera",
    ),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot(
      "../apps/teledex",
      "workera",
    ),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot(
      "/path/to/workspace/../workspace/project/apps/teledex",
      "workera",
    ),
    /repo_root must point at a Teledex checkout/u,
  );
  assert.throws(
    () => assertSafeRemoteGatewayRepoRoot(
      "/path/to/worker-workspace/../workspace/project/apps/teledex",
      "workera",
    ),
    /repo_root must point at a Teledex checkout/u,
  );
});

test("syncGatewayRepoToRemote expands tilde repo roots before protected rsync", async () => {
  const calls = [];
  await syncGatewayRepoToRemote({
    connectTimeoutSecs: 8,
    currentHostId: "local",
    host: {
      host_id: "workera",
      ssh_target: "workera",
      repo_root: "/path/to/worker-workspace/apps/teledex",
    },
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      if (command === "ssh") {
        callback(
          null,
          "/path/to/worker-workspace/apps/teledex\n",
          "",
        );
        return;
      }
      callback(null, "", "");
    },
  });

  const rsyncCalls = calls.filter((call) => call.command === "rsync");
  assert.equal(rsyncCalls.length, 2);
  assert.equal(
    rsyncCalls[0].args.at(-1),
    "workera:/path/to/worker-workspace/apps/teledex/",
  );
  assert.equal(
    rsyncCalls[1].args.at(-1),
    "workera:/path/to/worker-workspace/apps/teledex/.git/",
  );
  assert.equal(
    rsyncCalls.some((call) => call.args.some((arg) => arg.includes(":~/"))),
    false,
  );
});

test("runRemoteCodexTask detaches ssh on Linux and tree-signals startup failures", async () => {
  const execCalls = [];
  const spawnCalls = [];
  const child = new FakeRemoteExecutorChild();
  const host = {
    host_id: "workera",
    ssh_target: "workera",
    repo_root: "/path/to/workspace/apps/teledex",
    worker_runtime_root: "/path/to/teledex-state/teledex",
    workspace_root: "/path/to/workspace",
    codex_bin_path: "/home/example/bin/codex",
  };

  await assert.rejects(
    () =>
      runRemoteCodexTask({
        codexBinPath: "codex",
        connectTimeoutSecs: 1,
        currentHostId: "local",
        executionHost: { hostId: "workera", host },
        prompt: "hello",
        session: {
          workspace_binding: {
            workspace_root_path: "/path/to/workspace",
            cwd: "/path/to/workspace",
            worktree_path: "/path/to/workspace",
          },
        },
        platform: "linux",
        execFileImpl(command, args, options, callback) {
          execCalls.push({ command, args, options });
          callback(null, "", "");
        },
        spawnImpl(command, args, options) {
          spawnCalls.push({ command, args, options });
          return child;
        },
      }),
    /remote start failed/u,
  );

  assert.equal(execCalls.some((call) => call.command === "rsync"), true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "ssh");
  assert.match(spawnCalls[0].args.join(" "), /ServerAliveInterval=30/u);
  assert.match(spawnCalls[0].args.join(" "), /provider_env="\$HOME\/\.codex\/provider-env"/u);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(child.signal, "SIGTERM");
});

test("runRemoteCodexTask cleans per-run remote input root when image staging fails", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-legacy-remote-images-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const localImage = path.join(tmpDir, "screen shot.png");
  await fs.writeFile(localImage, "fake image bytes");
  const execCalls = [];
  const spawnCalls = [];
  const warnings = [];
  let rsyncCalls = 0;
  const host = {
    host_id: "workera",
    ssh_target: "workera",
    repo_root: "/path/to/workspace/apps/teledex",
    worker_runtime_root: "/path/to/teledex-state/teledex",
    workspace_root: "/path/to/workspace",
    codex_bin_path: "/home/example/bin/codex",
  };

  await assert.rejects(
    () =>
      runRemoteCodexTask({
        codexBinPath: "codex",
        connectTimeoutSecs: 1,
        currentHostId: "local",
        executionHost: { hostId: "workera", host },
        prompt: "hello with image",
        imagePaths: [localImage],
        session: {
          session_key: "-100:4242",
          workspace_binding: {
            workspace_root_path: "/path/to/workspace",
            cwd: "/path/to/workspace",
            worktree_path: "/path/to/workspace",
          },
        },
        sessionKey: "-100:4242",
        platform: "linux",
        execFileImpl(command, args, options, callback) {
          execCalls.push({ command, args, options });
          if (command === "rsync") {
            rsyncCalls += 1;
            if (rsyncCalls <= 2) {
              callback(null, "", "");
              return;
            }
            callback(new Error("image rsync failed"), "", "");
            return;
          }
          callback(null, "", "");
        },
        spawnImpl(command, args, options) {
          spawnCalls.push({ command, args, options });
          throw new Error("spawn should not run after image staging failure");
        },
        onWarning(message) {
          warnings.push(message);
        },
      }),
    /image rsync failed/u,
  );

  assert.equal(spawnCalls.length, 0);
  assert.equal(rsyncCalls, 3);
  assert.equal(
    execCalls.some((call) =>
      call.command === "ssh"
      && String(call.args.at(-1)).includes("rm -rf --")
      && /remote-inputs\/100-4242\/run-/u.test(String(call.args.at(-1)))),
    true,
  );
  assert.deepEqual(warnings, []);
});

test("runRemoteCodexTask expands remote input root before live-steer image staging", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-remote-steer-images-"));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const localImage = path.join(tmpDir, "steer.png");
  await fs.writeFile(localImage, "fake image bytes");

  const execCalls = [];
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const lineEnd = buffer.indexOf("\n");
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (!line.trim()) {
        continue;
      }
      const request = JSON.parse(line);
      if (request.method === "startRun" || request.method === "steer") {
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: true,
          })}\n`);
        });
      }
    }
  });

  const task = await runRemoteCodexTask({
    codexBinPath: "codex",
    connectTimeoutSecs: 1,
    currentHostId: "local",
    executionHost: {
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
        repo_root: "/path/to/worker-workspace/apps/teledex",
        worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
        workspace_root: "/path/to/worker-workspace",
        codex_bin_path: "/home/workera/bin/codex",
      },
    },
    prompt: "hello",
    session: {
      session_key: "-100:4242",
      workspace_binding: {
        workspace_root_path: "/path/to/workspace",
        cwd: "/path/to/workspace",
        worktree_path: "/path/to/workspace",
      },
    },
    sessionKey: "-100:4242",
    platform: "linux",
    execFileImpl(command, args, options, callback) {
      execCalls.push({ command, args, options });
      if (command === "ssh") {
        const script = String(args.at(-1));
        if (script.includes("remote-inputs")) {
          callback(
            null,
            "/path/to/worker-workspace-state/apps/teledex/remote-inputs/100-4242/run-test\n",
            "",
          );
          return;
        }
        if (script.includes("apps/teledex")) {
          callback(
            null,
            "/path/to/worker-workspace/apps/teledex\n",
            "",
          );
          return;
        }
      }
      callback(null, "", "");
    },
    spawnImpl() {
      return child;
    },
  });

  await task.steer({
    input: [
      {
        type: "localImage",
        path: localImage,
      },
    ],
  });
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "remote-finished",
    method: "finished",
    params: {
      result: {
        exitCode: 0,
        signal: null,
        threadId: "thread-1",
        warnings: [],
        resumeReplacement: null,
      },
    },
  })}\n`);
  await task.finished;
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);

  const rsyncTargets = execCalls
    .filter((call) => call.command === "rsync")
    .map((call) => call.args.at(-1));
  assert.equal(rsyncTargets.some((target) => String(target).includes(":~/")), false);
  assert.equal(
    rsyncTargets.some((target) =>
      String(target).includes(
        "workera:/path/to/worker-workspace-state/apps/teledex/remote-inputs/100-4242/run-test/",
      )),
    true,
  );
});

test("runRemoteCodexTask rejects unsafe repo_root before remote commands", async () => {
  const execCalls = [];
  const spawnCalls = [];
  const host = {
    host_id: "workera",
    ssh_target: "workera",
    repo_root: "/path/to/workspace",
    worker_runtime_root: "/path/to/teledex-state/teledex",
    workspace_root: "/path/to/workspace",
    codex_bin_path: "/home/example/bin/codex",
  };

  await assert.rejects(
    () =>
      runRemoteCodexTask({
        codexBinPath: "codex",
        connectTimeoutSecs: 1,
        currentHostId: "local",
        executionHost: { hostId: "workera", host },
        prompt: "hello",
        session: {
          workspace_binding: {
            workspace_root_path: "/path/to/workspace",
            cwd: "/path/to/workspace",
            worktree_path: "/path/to/workspace",
          },
        },
        platform: "linux",
        execFileImpl(command, args, options, callback) {
          execCalls.push({ command, args, options });
          callback(null, "", "");
        },
        spawnImpl(command, args, options) {
          spawnCalls.push({ command, args, options });
          return new FakeRemoteExecutorChild();
        },
      }),
    /repo_root must point at a Teledex checkout/u,
  );

  assert.equal(execCalls.length, 0);
  assert.equal(spawnCalls.length, 0);
});

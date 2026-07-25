import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCodexAppServerV2GoalRpc } from "../src/app-server-v2/goal-client.js";
import { runCodexAppServerV2Task } from "../src/app-server-v2/app-server-v2-runner.js";
import { startCodexExecRun } from "../src/codex-exec/exec-runner.js";
import { runCodexExecTask } from "../src/codex-exec/telegram-exec-runner.js";
import { runCodexTask } from "../src/pty-worker/codex-runner.js";

const WINDOWS_PATH = "C:\\Windows\\System32;C:\\Users\\example\\bin";
const POSIX_PATH = "/usr/local/bin:/usr/bin";

async function withSyntheticWindowsEnv(callback) {
  const saved = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    CUSTOM_DEEPSEEK_API_KEY: process.env.CUSTOM_DEEPSEEK_API_KEY,
    HOME: process.env.HOME,
  };
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "teledex-win-env-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "provider-env"),
    [
      "CUSTOM_DEEPSEEK_API_KEY=custom-provider-secret",
      "TELEGRAM_BOT_TOKEN=must-not-leak",
      "",
    ].join("\n"),
  );

  process.env.PATH = POSIX_PATH;
  process.env.Path = WINDOWS_PATH;
  delete process.env.CUSTOM_DEEPSEEK_API_KEY;
  process.env.HOME = homeDir;

  try {
    await callback();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(homeDir, { force: true, recursive: true });
  }
}

function createBlockingSpawn() {
  const calls = [];
  return {
    calls,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      throw new Error("spawn blocked");
    },
  };
}

function assertWindowsChildEnv(call) {
  assert.equal(call.options.detached, false);
  assert.equal(call.options.env.Path, WINDOWS_PATH);
  assert.equal(Object.hasOwn(call.options.env, "PATH"), false);
  assert.equal(call.options.env.CUSTOM_DEEPSEEK_API_KEY, "custom-provider-secret");
}

const customProviderConfig = {
  env_key: "CUSTOM_DEEPSEEK_API_KEY",
};

function assertBlockedSync(callback) {
  assert.throws(callback, /spawn blocked/u);
}

test("Windows runner spawn surfaces preserve Windows PATH", async () => {
  await withSyntheticWindowsEnv(async () => {
    const execRun = createBlockingSpawn();
    assertBlockedSync(() => {
      startCodexExecRun({
        codexBinPath: "codex.cmd",
        repoRoot: process.cwd(),
        outputDir: os.tmpdir(),
        prompt: "hello",
        modelProviderConfig: customProviderConfig,
        platform: "win32",
        spawnProcess: execRun.spawnImpl,
      });
    });
    assertWindowsChildEnv(execRun.calls[0]);

    const telegramExec = createBlockingSpawn();
    assertBlockedSync(() => {
      runCodexExecTask({
        codexBinPath: "codex.cmd",
        cwd: process.cwd(),
        prompt: "hello",
        modelProviderConfig: customProviderConfig,
        platform: "win32",
        spawnImpl: telegramExec.spawnImpl,
      });
    });
    assertWindowsChildEnv(telegramExec.calls[0]);

    const appServerV2 = createBlockingSpawn();
    assertBlockedSync(() => {
      runCodexAppServerV2Task({
        codexBinPath: "codex.cmd",
        cwd: process.cwd(),
        prompt: "hello",
        modelProviderConfig: customProviderConfig,
        platform: "win32",
        spawnImpl: appServerV2.spawnImpl,
      });
    });
    assertWindowsChildEnv(appServerV2.calls[0]);

    const appServerV2Goal = createBlockingSpawn();
    await assert.rejects(
      () =>
        runCodexAppServerV2GoalRpc({
          action: "get",
          codexBinPath: "codex.cmd",
          config: { workspaceRootPath: process.cwd() },
          modelProviderConfig: customProviderConfig,
          session: {
            codex_thread_id: "thread-win",
            codex_rollout_path: "C:\\Users\\example\\.codex\\rollout.jsonl",
            workspace_binding: { cwd: process.cwd() },
          },
          platform: "win32",
          spawnImpl: appServerV2Goal.spawnImpl,
        }),
      /spawn blocked/u,
    );
    assertWindowsChildEnv(appServerV2Goal.calls[0]);

    const fallbackAppServer = createBlockingSpawn();
    assertBlockedSync(() => {
      runCodexTask({
        codexBinPath: "codex.cmd",
        cwd: process.cwd(),
        prompt: "hello",
        modelProviderConfig: customProviderConfig,
        platform: "win32",
        spawnImpl: fallbackAppServer.spawnImpl,
      });
    });
    assertWindowsChildEnv(fallbackAppServer.calls[0]);
  });
});

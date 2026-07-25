import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const WINDOWS_WRAPPERS = {
  "admin.cmd": {
    target: "node src\\cli\\admin.js %*",
    forwardsArgs: true,
  },
  "doctor.cmd": {
    target: "node src\\cli\\doctor.js",
  },
  "install-codex.cmd": {
    target: "echo Install Codez from https://github.com/mmmihaeel/codez",
  },
  "install.cmd": {
    target: "call npm.cmd ci --ignore-scripts --no-audit --no-fund",
  },
  "run.cmd": {
    target: "node src\\cli\\run.js",
  },
  "test-live-app-server-v2.cmd": {
    target: "node src\\cli\\run-live-tests.js --app-server-v2 %*",
    forwardsArgs: true,
  },
  "test-live-app-server.cmd": {
    target: "node src\\cli\\run-live-tests.js --app-server-v2 %*",
    forwardsArgs: true,
  },
  "test-live.cmd": {
    target: "node src\\cli\\run-live-tests.js --app-server-v2 %*",
    forwardsArgs: true,
  },
  "test.cmd": {
    target: "node scripts\\run-node-tests.mjs %*",
    forwardsArgs: true,
  },
  "user-e2e.cmd": {
    target: "node src\\cli\\user-live-e2e.js",
  },
  "user-login.cmd": {
    target: "node src\\cli\\user-login.js",
  },
  "user-agent-audit.cmd": {
    target: "node src\\cli\\user-live-agent-audit.js",
  },
  "user-status.cmd": {
    target: "node src\\cli\\user-status.js",
  },
};

function normalizeBatchText(text) {
  return String(text || "").replace(/\r\n/gu, "\n");
}

test("Windows test helper uses the canonical Node test runner wrapper", async () => {
  const script = await fs.readFile("scripts/windows/test.cmd", "utf8");

  assert.match(script, /node scripts\\run-node-tests\.mjs %\*/u);
  assert.doesNotMatch(script, /node --test/u);
});

test("Windows live-test helpers mirror supported live backend suites", async () => {
  const execJsonScript = await fs.readFile("scripts/windows/test-live.cmd", "utf8");
  const legacyAppServerScript = await fs.readFile(
    "scripts/windows/test-live-app-server.cmd",
    "utf8",
  );
  const appServerV2Script = await fs.readFile(
    "scripts/windows/test-live-app-server-v2.cmd",
    "utf8",
  );

  assert.match(execJsonScript, /--app-server-v2 %\*/u);
  assert.match(legacyAppServerScript, /--app-server-v2 %\*/u);
  assert.match(appServerV2Script, /--app-server-v2 %\*/u);
});

test("npm lint script is shell-neutral for native Windows", async () => {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));

  assert.equal(
    packageJson.scripts.lint,
    "node ./node_modules/eslint/bin/eslint.js src scripts test test-support",
  );
});

test("Windows command wrappers stay in sync with repo-local entrypoints", async () => {
  const discovered = (await fs.readdir("scripts/windows"))
    .filter((name) => name.endsWith(".cmd"))
    .sort();

  assert.deepEqual(discovered, Object.keys(WINDOWS_WRAPPERS).sort());

  for (const [fileName, expected] of Object.entries(WINDOWS_WRAPPERS)) {
    const script = normalizeBatchText(
      await fs.readFile(path.join("scripts", "windows", fileName), "utf8"),
    );

    assert.match(script, /@echo off/u);
    assert.match(script, new RegExp(expected.target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    if (expected.forwardsArgs) {
      assert.match(script, /%\*/u);
    } else {
      assert.doesNotMatch(script, /%\*/u);
    }
    if (expected.target.startsWith("node ")) {
      const targetPath = expected.target
        .replace(/^node /u, "")
        .replace(/ .*/u, "")
        .replace(/\\/gu, "/");
      await fs.access(targetPath);
    }
  }
});

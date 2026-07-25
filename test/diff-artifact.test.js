import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SessionStore } from "../src/session-manager/session-store.js";
import { createWorkspaceDiffArtifact } from "../src/workspace/diff-artifact.js";

const execFileAsync = promisify(execFile);

async function run(command, args, cwd) {
  await execFileAsync(command, args, { cwd });
}

async function makeGitRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teledex-git-"));
  await run("git", ["init"], repoRoot);
  await run("git", ["config", "user.name", "Codex"], repoRoot);
  await run("git", ["config", "user.email", "codex@example.test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "tracked.txt"), "line 1\n", "utf8");
  await run("git", ["add", "tracked.txt"], repoRoot);
  await run("git", ["commit", "-m", "initial"], repoRoot);
  return repoRoot;
}

test("createWorkspaceDiffArtifact returns clean snapshot for unchanged workspace", async () => {
  const repoRoot = await makeGitRepo();
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 91,
    createdVia: "test",
    workspaceBinding: {
      repo_root: repoRoot,
      cwd: repoRoot,
      branch: "master",
      worktree_path: repoRoot,
    },
  });

  const result = await createWorkspaceDiffArtifact({
    session,
    sessionStore,
  });

  assert.equal(result.clean, true);
  assert.ok(result.generatedAt);
});

test("createWorkspaceDiffArtifact stores a diff artifact for dirty workspace", async () => {
  const repoRoot = await makeGitRepo();
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 92,
    createdVia: "test",
    workspaceBinding: {
      repo_root: repoRoot,
      cwd: repoRoot,
      branch: "master",
      worktree_path: repoRoot,
    },
  });

  await fs.writeFile(path.join(repoRoot, "tracked.txt"), "line 1\nline 2\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "new.txt"), "new file\n", "utf8");

  const result = await createWorkspaceDiffArtifact({
    session,
    sessionStore,
  });

  assert.equal(result.artifact.kind, "diff");
  const artifactText = await fs.readFile(result.filePath, "utf8");
  assert.match(artifactText, /Workspace diff snapshot/u);
  assert.match(artifactText, /tracked\.txt/u);
  assert.match(artifactText, /new\.txt/u);
});

test("createWorkspaceDiffArtifact reports unavailable for non-git workspace bindings", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-plain-workspace-"),
  );
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 93,
    createdVia: "test",
    workspaceBinding: {
      repo_root: cwd,
      cwd,
      branch: null,
      worktree_path: cwd,
    },
  });

  const result = await createWorkspaceDiffArtifact({
    session,
    sessionStore,
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.reason, "workspace-not-git");
  assert.equal(result.cwd, cwd);
  assert.ok(result.generatedAt);
});

test("createWorkspaceDiffArtifact uses bound-host paths in remote diff artifacts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1000000,
    topicId: 94,
    createdVia: "test",
    executionHostId: "workera",
    workspaceBinding: {
      repo_root: "/path/to/workspace/project",
      cwd: "/path/to/workspace/project",
      branch: "main",
      worktree_path: "/path/to/workspace/project",
      workspace_root_path: "/path/to/workspace",
      cwd_relative_to_workspace_root: "project",
    },
  });
  const remoteCalls = [];

  const result = await createWorkspaceDiffArtifact({
    session,
    sessionStore,
    config: {
      currentHostId: "local",
      hostSshConnectTimeoutSecs: 1,
    },
    hostRegistryService: {
      async getHost(hostId) {
        assert.equal(hostId, "workera");
        return {
          host_id: "workera",
          ssh_target: "workera",
          workspace_root: "/path/to/worker-workspace",
          host_root: "/path/to/worker-workspace",
          host_user: "workera",
        };
      },
    },
    runGitImpl: async () => {
      throw new Error("should use remote git");
    },
    runRemoteGitImpl: async ({ cwd, args }) => {
      remoteCalls.push({ cwd, args });
      if (args[0] === "status") {
        return "## main\n M tracked.txt\n";
      }
      if (args.includes("--cached")) {
        return "";
      }
      return "diff --git a/tracked.txt b/tracked.txt\n";
    },
  });

  assert.equal(result.artifact.kind, "diff");
  assert.deepEqual(
    remoteCalls.map((call) => call.cwd),
    [
      "/path/to/worker-workspace/project",
      "/path/to/worker-workspace/project",
      "/path/to/worker-workspace/project",
    ],
  );
  const artifactText = await fs.readFile(result.filePath, "utf8");
  assert.match(artifactText, /^cwd: \/path\/to\/worker-workspace\/project$/mu);
  assert.match(artifactText, /^repo_root: \/path\/to\/worker-workspace\/project$/mu);
  assert.doesNotMatch(artifactText, /\/home\/example/u);
});

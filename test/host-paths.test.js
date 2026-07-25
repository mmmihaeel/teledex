import test from "node:test";
import assert from "node:assert/strict";

import {
  expandHostHomePath,
  resolveBindingRelativeCwd,
  resolveExecutionCwd,
  translateWorkspacePathForHost,
} from "../src/hosts/host-paths.js";

test("resolveBindingRelativeCwd prefers stored relative path", () => {
  assert.equal(
    resolveBindingRelativeCwd({
      cwd_relative_to_workspace_root: "apps/service",
      cwd: "/path/to/workspace/other",
      workspace_root_path: "/path/to/workspace",
    }),
    "apps/service",
  );
});

test("resolveBindingRelativeCwd derives relative cwd from workspace root", () => {
  assert.equal(
    resolveBindingRelativeCwd({
      cwd: "/path/to/workspace/apps/service",
      workspace_root_path: "/path/to/workspace",
    }),
    "apps/service",
  );
});

test("resolveExecutionCwd translates remote cwd from host workspace root", () => {
  assert.equal(
    resolveExecutionCwd({
      workspaceBinding: {
        cwd: "/path/to/workspace",
        workspace_root_path: "/path/to/workspace",
        cwd_relative_to_workspace_root: ".",
      },
      host: {
        host_id: "workera",
        workspace_root: "/path/to/worker-workspace",
        host_root: "/path/to/worker-workspace",
      },
      currentHostId: "local",
    }),
    "/path/to/worker-workspace",
  );
});

test("resolveExecutionCwd can infer remote home from codex bin path", () => {
  assert.equal(
    resolveExecutionCwd({
      workspaceBinding: {
        cwd: "/path/to/workspace/apps/service",
        workspace_root_path: "/path/to/workspace",
      },
      host: {
        host_id: "workerb",
        workspace_root: "/path/to/worker-workspace",
        codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
      },
      currentHostId: "local",
    }),
    "/path/to/worker-workspace/apps/service",
  );
});

test("expandHostHomePath returns null for unresolved home paths", () => {
  assert.equal(
    expandHostHomePath("~/workspace", { host_id: "unknown", workspace_root: "~/workspace" }),
    null,
  );
});

test("translateWorkspacePathForHost keeps local paths unchanged", () => {
  assert.equal(
    translateWorkspacePathForHost(
      "/path/to/workspace/apps",
      {
        workspaceBinding: {
          workspace_root_path: "/path/to/workspace",
        },
        host: {
          host_id: "local",
          workspace_root: "/path/to/worker-workspace",
        },
        currentHostId: "local",
      },
    ),
    "/path/to/workspace/apps",
  );
});

test("translateWorkspacePathForHost returns null when path escapes workspace root", () => {
  assert.equal(
    translateWorkspacePathForHost(
      "/tmp/outside.txt",
      {
        workspaceBinding: {
          workspace_root_path: "/path/to/workspace",
        },
        host: {
          host_id: "workera",
          workspace_root: "/path/to/worker-workspace",
        },
        currentHostId: "local",
      },
    ),
    null,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderCodexSpace } from "../src/hosts/teledex-context.js";
import {
  PRIVATE_DIRECTORY_MODE,
  supportsPosixFileModes,
} from "../src/state/file-utils.js";

async function getMode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("renderCodexSpace writes shared and per-host rendered outputs", async () => {
  const codexSpaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-teledex-context-"),
  );
  const result = await renderCodexSpace({
    codexSpaceRoot,
    currentHostId: "local",
    hosts: [
      {
        host_id: "local",
        label: "local",
        role: "controller",
        enabled: true,
        host_user: "local",
        host_root: "/path/to/workspace",
        state_root: "/path/to/teledex-state",
        worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
        workspace_root: "/path/to/worker-workspace",
        repo_root: "/path/to/worker-workspace/apps/teledex",
        profile_id: "workspace-controller",
        suffix_id: "local",
        last_health: "ready",
        last_health_checked_at: "2026-04-21T18:00:00.000Z",
        last_ready_at: "2026-04-21T18:00:00.000Z",
        failure_reason: null,
      },
      {
        host_id: "workera",
        label: "workera",
        role: "workspace-node",
        enabled: true,
        host_user: "workera",
        host_root: "/path/to/worker-workspace",
        state_root: "/path/to/worker-workspace-state",
        worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
        workspace_root: "/path/to/worker-workspace",
        repo_root: "/path/to/worker-workspace/apps/teledex",
        profile_id: "workspace-node",
        suffix_id: "workera",
        last_health: "not-ready",
        last_health_checked_at: "2026-04-21T18:10:00.000Z",
        last_ready_at: null,
        failure_reason: "codex-auth",
      },
    ],
  });

  assert.deepEqual(
    result.files
      .map((filePath) => path.relative(codexSpaceRoot, filePath).replace(/\\/gu, "/"))
      .sort(),
    [
      "hosts/local/rendered/health.json",
      "hosts/local/rendered/host-context.txt",
      "hosts/local/rendered/profile.json",
      "hosts/workera/rendered/health.json",
      "hosts/workera/rendered/host-context.txt",
      "hosts/workera/rendered/profile.json",
      "shared/rendered/fleet-map.json",
      "shared/rendered/fleet-reminder.txt",
      "shared/rendered/manifest.json",
      "shared/rendered/workspace-reminder.txt",
    ],
  );

  const fleetReminder = await fs.readFile(
    path.join(codexSpaceRoot, "shared", "rendered", "fleet-reminder.txt"),
    "utf8",
  );
  const operatorReminder = await fs.readFile(
    path.join(codexSpaceRoot, "shared", "rendered", "workspace-reminder.txt"),
    "utf8",
  );
  const serProfile = JSON.parse(
    await fs.readFile(
      path.join(codexSpaceRoot, "hosts", "workera", "rendered", "profile.json"),
      "utf8",
    ),
  );
  const fleetMap = JSON.parse(
    await fs.readFile(
      path.join(codexSpaceRoot, "shared", "rendered", "fleet-map.json"),
      "utf8",
    ),
  );
  const serPromptSnippet = await fs.readFile(
    path.join(codexSpaceRoot, "hosts", "workera", "rendered", "host-context.txt"),
    "utf8",
  );

  assert.match(fleetReminder, /Current controller host: local/u);
  assert.match(operatorReminder, /Avoid overengineering\./u);
  assert.match(
    operatorReminder,
    /Project\/service metadata lives in co-located project\.toml manifests/u,
  );
  assert.match(operatorReminder, /project registry host and mount metadata comes from the configured project registry host config/u);
  assert.match(operatorReminder, /workspace skills and their references for workflows/u);
  assert.match(operatorReminder, /Dormant shared docs\/templates\/bootstrap notes are source-maintenance surfaces only/u);
  assert.match(operatorReminder, /Do not edit skill references or dormant shared docs as a proxy/u);
  assert.doesNotMatch(operatorReminder, /scout\.search/u);
  assert.equal(serProfile.host_id, "workera");
  assert.equal(serProfile.home_path, "/home/workera");
  assert.equal(serProfile.workspace_root, "/path/to/worker-workspace");
  assert.equal(
    serProfile.worker_runtime_root,
    "/path/to/worker-workspace-state/apps/teledex",
  );
  assert.equal(
    fleetMap.hosts.find((host) => host.host_id === "workera")?.repo_root,
    "/path/to/worker-workspace/apps/teledex",
  );
  assert.doesNotMatch(JSON.stringify(fleetMap), /~\/workspace/u);
  assert.match(serPromptSnippet, /Workspace root: \/path\/to\/worker-workspace/u);
  assert.match(
    serPromptSnippet,
    /Runtime root: \/path\/to\/worker-workspace-state\/apps\/teledex/u,
  );
  assert.doesNotMatch(serPromptSnippet, /~\/workspace/u);

  if (supportsPosixFileModes()) {
    assert.equal(await getMode(codexSpaceRoot), PRIVATE_DIRECTORY_MODE);
    assert.equal(
      await getMode(path.join(codexSpaceRoot, "hosts", "workera", "rendered")),
      PRIVATE_DIRECTORY_MODE,
    );
  }
});

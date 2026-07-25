import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HostRegistryService } from "../src/hosts/host-registry-service.js";
import { runHostRemoteSmoke } from "../src/hosts/host-remote-smoke.js";

function createExecFileStub({ failScripts = [] } = {}) {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args });
    if (command === "ssh") {
      const script = Array.isArray(args) ? args.at(-1) : "";
      const matchedFailure = failScripts.find((entry) => script.includes(entry));
      if (matchedFailure) {
        const error = new Error(`failed: ${matchedFailure}`);
        error.code = 1;
        callback(error, "", matchedFailure);
        return;
      }
      if (script.includes('cache_path="$(dirname "$config_path")/models_cache.json"')) {
        callback(null, '{"models":[{"slug":"gpt-5.5","visibility":"list"}]}\n', "");
        return;
      }
      if (script.includes("smoke-proof-workera")) {
        callback(
          null,
          [
            "smoke_directory=/path/to/worker-workspace-state/apps/teledex/host-smoke/2026-04-21T18-30-00-000Z",
            "expected_text=smoke-proof-workera",
            "last_message=smoke-proof-workera",
            "matched=1",
            "before_session=",
            "after_session=/home/workera/.codex/sessions/2026/04/21/run.jsonl",
          ].join("\n"),
          "",
        );
        return;
      }
      callback(null, "", "");
      return;
    }

    callback(null, "", "");
  };

  return {
    calls,
    execFileImpl,
  };
}

test("runHostRemoteSmoke writes a successful smoke summary for a ready remote host", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-host-remote-smoke-"),
  );
  const hostsRoot = path.join(stateRoot, "hosts");
  const registryService = new HostRegistryService({
    registryPath: path.join(hostsRoot, "registry-state.toml"),
    currentHostId: "local",
  });
  await registryService.upsertHost({
    host_id: "workera",
    label: "workera",
    ssh_target: "workera",
    enabled: true,
    workspace_root: "/path/to/worker-workspace",
    repo_root: "/path/to/worker-workspace/apps/teledex",
    worker_runtime_root: "/path/to/worker-workspace-state/apps/teledex",
    codex_bin_path: "/path/to/worker-workspace-state/external/forks/codex/bin/codex",
    codex_config_path: "~/.codex/config.toml",
    codex_auth_path: "~/.codex/auth.json",
    capabilities: ["mcp-docker"],
  });
  const stub = createExecFileStub({ failScripts: ["docker exec mcp-docker"] });

  const result = await runHostRemoteSmoke({
    autoCompactTokenLimit: 180000,
    connectTimeoutSecs: 5,
    contextWindow: 200000,
    currentHostId: "local",
    execFileImpl: stub.execFileImpl,
    hostsRoot,
    mcpPreset: "none",
    model: "gpt-5.5",
    reasoningEffort: "low",
    registryService,
    targetHostId: "workera",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.smoke.last_message, "smoke-proof-workera");
  assert.equal(result.models_cache_snapshot.status, "captured");
  assert.equal(
    await fs
      .access(path.join(hostsRoot, "remote-smoke-last-run.json"))
      .then(() => true)
      .catch(() => false),
    true,
  );
  assert.equal(
    await fs
      .access(path.join(
        stateRoot,
        "teledex-context",
        "hosts",
        "workera",
        "rendered",
        "models_cache.json",
      ))
      .then(() => true)
      .catch(() => false),
    true,
  );
  const smokeScript = String(stub.calls.find((call) =>
    call.command === "ssh"
    && String(call.args.at(-1) || "").includes("smoke-proof-workera")
  )?.args.at(-1) || "");
  assert.equal(smokeScript.includes("configured_codex=$(expand_path"), true);
  assert.equal(smokeScript.includes("worker-workspace-state/external/forks/codex/bin/codex"), true);
  assert.equal(
    smokeScript.includes('timeout 120s "$configured_codex"'),
    true,
  );
  assert.equal(smokeScript.includes(".rtk-wrappers"), false);
  assert.equal(smokeScript.includes("--json"), true);
  assert.equal(smokeScript.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(smokeScript.includes('"$working_directory"'), true);
  assert.equal(smokeScript.includes('model="gpt-5.5"'), true);
  assert.equal(smokeScript.includes('model_reasoning_effort="low"'), true);
  assert.equal(smokeScript.includes("model_context_window=200000"), true);
  assert.equal(smokeScript.includes("model_auto_compact_token_limit=180000"), true);
  assert.equal(smokeScript.includes("--skip-git-repo-check"), false);
  assert.equal(smokeScript.includes("-o \"$temp_last_message\""), false);
});

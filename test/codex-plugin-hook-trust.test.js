import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverCodexPluginHookTrustEntries,
  ensureCodexPluginHookTrustConfigText,
  versionForHookIdentity,
} from "../src/runtime/codex-plugin-hook-trust.js";

async function writePluginFixture(root, hooksJson) {
  await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, "hooks"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    '{"name":"fixture-plugin","hooks":"./hooks/hooks.json"}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "hooks", "hooks.json"),
    JSON.stringify(hooksJson, null, 2),
    "utf8",
  );
}

test("discoverCodexPluginHookTrustEntries derives Codez-compatible keys and hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugin-hook-trust-"));
  const pluginRoot = path.join(root, "fixture-plugin");
  await writePluginFixture(pluginRoot, {
    hooks: {
      PreToolUse: [{
        matcher: "^(Bash|exec_command|functions\\.exec_command)$",
        hooks: [{
          type: "command",
          command: "${PLUGIN_ROOT}/hooks/pre",
          timeout: 5,
          statusMessage: "pre",
        }],
      }],
      PostToolUse: [{
        matcher: "^Bash$",
        hooks: [{
          type: "command",
          command: "${PLUGIN_ROOT}/hooks/post",
          timeout: 8,
          statusMessage: "post",
        }],
      }],
    },
  });

  const entries = await discoverCodexPluginHookTrustEntries({
    pluginId: "fixture-plugin@community-local",
    pluginRoot,
  });

  assert.deepEqual(entries.map((entry) => entry.key), [
    "fixture-plugin@community-local:hooks/hooks.json:pre_tool_use:0:0",
    "fixture-plugin@community-local:hooks/hooks.json:post_tool_use:0:0",
  ]);
  assert.equal(
    entries[0].trustedHash,
    versionForHookIdentity({
      event_name: "pre_tool_use",
      matcher: "^(Bash|exec_command|functions\\.exec_command)$",
      hooks: [{
        type: "command",
        command: "${PLUGIN_ROOT}/hooks/pre",
        timeout: 5,
        async: false,
        statusMessage: "pre",
      }],
    }),
  );
});

test("ensureCodexPluginHookTrustConfigText upserts trusted_hash under hooks.state", () => {
  const rendered = ensureCodexPluginHookTrustConfigText('model = "gpt-5.5"\n', [{
    key: "fixture-plugin@community-local:hooks/hooks.json:pre_tool_use:0:0",
    trustedHash: "sha256:abc123",
  }]);

  assert.match(
    rendered,
    /^\[hooks\.state\."fixture-plugin@community-local:hooks\/hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:abc123"$/mu,
  );
});

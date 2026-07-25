import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchRemoteCodexContextSnapshot,
} from "../src/session-manager/remote-context-snapshot.js";

test("fetchRemoteCodexContextSnapshot normalizes remote Codex token snapshots", async () => {
  const calls = [];
  const result = await fetchRemoteCodexContextSnapshot({
    currentHostId: "local",
    executionHost: {
      ok: true,
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
    runHostBashImpl: async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          captured_at: "2026-05-11T16:21:40.112Z",
          thread_id: "thread-remote",
          model_context_window: 258400,
          last_token_usage: {
            input_tokens: 119127,
            cached_input_tokens: 113536,
            output_tokens: 462,
            reasoning_tokens: 31,
            total_tokens: 119589,
          },
        }),
      };
    },
    threadId: "thread-remote",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].host.ssh_target, "workera");
  assert.match(calls[0].script, /thread_id="thread-remote"/u);
  assert.equal(result.source, "remote-codex-sessions");
  assert.deepEqual(result.snapshot.last_token_usage, {
    input_tokens: 119127,
    cached_input_tokens: 113536,
    output_tokens: 462,
    reasoning_tokens: 31,
    total_tokens: 119589,
  });
});

test("fetchRemoteCodexContextSnapshot skips local hosts and unsafe thread ids", async () => {
  let calls = 0;
  const common = {
    currentHostId: "local",
    executionHost: {
      ok: true,
      hostId: "local",
      host: {
        host_id: "local",
        ssh_target: "local",
      },
    },
    runHostBashImpl: async () => {
      calls += 1;
      return { stdout: "" };
    },
  };

  assert.equal(await fetchRemoteCodexContextSnapshot({
    ...common,
    threadId: "thread-local",
  }), null);
  assert.equal(await fetchRemoteCodexContextSnapshot({
    ...common,
    executionHost: {
      ok: true,
      hostId: "workera",
      host: {
        host_id: "workera",
        ssh_target: "workera",
      },
    },
    threadId: "bad;thread",
  }), null);
  assert.equal(calls, 0);
});

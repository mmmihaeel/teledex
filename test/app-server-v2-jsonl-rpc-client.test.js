import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { createJsonLineRpcClient } from "../src/app-server-v2/jsonl-rpc-client.js";

function createDuplexHarness(options = {}) {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const written = [];
  clientToServer.on("data", (chunk) => {
    for (const line of String(chunk).split(/\n/u).filter(Boolean)) {
      written.push(JSON.parse(line));
    }
  });
  const client = createJsonLineRpcClient({
    input: serverToClient,
    output: clientToServer,
    label: "test-rpc",
    ...options,
  });
  return {
    client,
    serverToClient,
    clientToServer,
    written,
    writeServer(message) {
      serverToClient.write(`${JSON.stringify(message)}\n`);
    },
    writeServerRaw(line) {
      serverToClient.write(`${line}\n`);
    },
  };
}

test("createJsonLineRpcClient resolves matching responses and ignores malformed lines", async () => {
  const warnings = [];
  const harness = createDuplexHarness({
    onWarning(message) {
      warnings.push(message);
    },
  });

  const pending = harness.client.request("thread/start", { cwd: "/tmp" });
  assert.deepEqual(harness.written[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: { cwd: "/tmp" },
  });

  harness.writeServerRaw("{not-json");
  harness.writeServer({ id: 999, result: {} });
  harness.writeServer({ id: 1, result: { thread: { id: "thread-1" } } });

  assert.deepEqual(await pending, { thread: { id: "thread-1" } });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /malformed JSON-RPC/u);
  assert.match(warnings[1], /unknown JSON-RPC response id/u);
});

test("createJsonLineRpcClient handles server requests with result and error responses", async () => {
  const harness = createDuplexHarness({
    onRequest({ method }) {
      if (method === "ok/request") {
        return { accepted: true };
      }
      const error = new Error("denied");
      error.code = -32002;
      throw error;
    },
  });

  harness.writeServer({ id: 5, method: "ok/request", params: {} });
  harness.writeServer({ id: 6, method: "bad/request", params: {} });

  await new Promise((resolve) => setImmediate(resolve));
  const byId = new Map(harness.written.map((message) => [message.id, message]));
  assert.deepEqual(byId.get(5), {
    jsonrpc: "2.0",
    id: 5,
    result: { accepted: true },
  });
  assert.equal(byId.get(6).error.code, -32002);
  assert.equal(byId.get(6).error.message, "denied");
});

test("createJsonLineRpcClient rejects pending requests on close", async () => {
  const harness = createDuplexHarness();
  const pending = harness.client.request("slow/request");

  harness.serverToClient.end();

  await assert.rejects(pending, /test-rpc JSON-RPC transport closed/u);
});

test("createJsonLineRpcClient times out requests and leaves later responses unmatched", async () => {
  const warnings = [];
  const harness = createDuplexHarness({
    onWarning(message) {
      warnings.push(message);
    },
  });

  await assert.rejects(
    harness.client.request("slow/request", {}, { timeoutMs: 5 }),
    /timed out/u,
  );
  harness.writeServer({ id: 1, result: { late: true } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown JSON-RPC response id/u);
});

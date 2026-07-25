import test from "node:test";
import assert from "node:assert/strict";

import {
  createReplacementGenerationId,
  resolveCurrentGenerationId,
} from "../src/runtime/service-generation-id.js";

test("resolveCurrentGenerationId reuses the injected rollout generation id", () => {
  assert.equal(
    resolveCurrentGenerationId({
      env: { SERVICE_GENERATION_ID: "gen-existing" },
      pid: 42,
      randomUUID: () => "ignored",
    }),
    "gen-existing",
  );
});

test("resolveCurrentGenerationId falls back to a fresh agent generation id", () => {
  assert.equal(
    resolveCurrentGenerationId({
      env: {},
      pid: 42,
      randomUUID: () => "uuid-current",
    }),
    "agent-42-uuid-current",
  );
});

test("createReplacementGenerationId always creates a fresh id", () => {
  assert.equal(
    createReplacementGenerationId({
      pid: 42,
      randomUUID: () => "uuid-next",
    }),
    "agent-42-uuid-next",
  );
});

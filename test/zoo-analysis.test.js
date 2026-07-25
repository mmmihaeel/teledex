import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalysisPrompt,
  computeTrend,
  validateAnalysisPayload,
} from "../src/zoo/analysis.js";

test("validateAnalysisPayload requires all mandatory Project Catalog stats", () => {
  assert.doesNotThrow(() =>
    validateAnalysisPayload({
      stats: {
        security: 10,
        shitcode: 20,
        junk: 30,
        tests: 40,
        structure: 50,
        docs: 60,
        operability: 70,
      },
    }),
  );

  assert.throws(
    () =>
      validateAnalysisPayload({
        stats: {
          security: 10,
          shitcode: 20,
          junk: 30,
          tests: 40,
          structure: 50,
          docs: 60,
        },
      }),
    /operability/u,
  );
});

test("buildAnalysisPrompt always enforces English and preserves the creature persona", () => {
  const prompt = buildAnalysisPrompt({
    language: "unexpected",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      character_name: "Rainbow Dash",
      temperament_id: "paladin",
      cwd: "/path/to/workspace/project",
    },
    previousSnapshot: null,
  });

  assert.match(prompt, /All human-readable fields must be written in English/u);
  assert.match(prompt, /You are literally a cat/u);
  assert.match(prompt, /temperament_label/u);
  assert.match(prompt, /stable temperament/u);
  assert.match(prompt, /Rainbow Dash/u);
  assert.match(prompt, /strict paladin/u);
  assert.match(prompt, /flavor_line should be one short first-person line/u);
  assert.match(prompt, /project_summary should be a separate concise summary/u);
  assert.match(prompt, /Avoid generic assistant tone/u);
  assert.doesNotMatch(prompt, /\p{Script=Cyrillic}/u);
});

test("computeTrend marks any increase or decrease as a trend", () => {
  assert.equal(computeTrend(81, 80), "up");
  assert.equal(computeTrend(79, 80), "down");
  assert.equal(computeTrend(80, 80), "same");
});

test("computeTrend falls back to same when the previous snapshot is missing", () => {
  assert.equal(computeTrend(80, null), "same");
  assert.equal(computeTrend(80, undefined), "same");
});

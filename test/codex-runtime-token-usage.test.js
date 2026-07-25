import test from "node:test";
import assert from "node:assert/strict";

import {
  addTokenUsage,
  computeNonCachedInputOutputTokenTotal,
  normalizeTokenUsage,
} from "../src/codex-runtime/token-usage.js";

test("computeNonCachedInputOutputTokenTotal matches native Codex goal token math", () => {
  assert.equal(computeNonCachedInputOutputTokenTotal({
    input_tokens: 900,
    cached_input_tokens: 400,
    output_tokens: 80,
    reasoning_tokens: 20,
    total_tokens: 1000,
  }), 580);
});

test("computeNonCachedInputOutputTokenTotal treats missing cache as zero", () => {
  assert.equal(computeNonCachedInputOutputTokenTotal({
    input_tokens: 100,
    output_tokens: 25,
    total_tokens: 125,
  }), 125);
});

test("computeNonCachedInputOutputTokenTotal matches the reported Codex/Teledex delta", () => {
  assert.equal(computeNonCachedInputOutputTokenTotal({
    total_tokens: 10416233,
    input_tokens: 10367856,
    cached_input_tokens: 9981184,
    output_tokens: 48377,
    reasoning_tokens: 14948,
  }), 435049);
});

test("computeNonCachedInputOutputTokenTotal saturates over-large cache hits", () => {
  assert.equal(computeNonCachedInputOutputTokenTotal({
    input_tokens: 100,
    cached_input_tokens: 250,
    output_tokens: 25,
    total_tokens: 125,
  }), 25);
});

test("computeNonCachedInputOutputTokenTotal returns null for incomplete accounting payloads", () => {
  assert.equal(computeNonCachedInputOutputTokenTotal({
    total_tokens: 400,
  }), null);
  assert.equal(computeNonCachedInputOutputTokenTotal({
    output_tokens: 25,
    total_tokens: 400,
  }), null);
  assert.equal(computeNonCachedInputOutputTokenTotal({
    input_tokens: 375,
    total_tokens: 400,
  }), null);
});

test("addTokenUsage aggregates normalized raw usage fields", () => {
  assert.deepEqual(addTokenUsage({
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 30,
    reasoning_tokens: 5,
    total_tokens: 130,
  }, {
    input_tokens: 50,
    cached_input_tokens: 20,
    output_tokens: 40,
    reasoning_tokens: 7,
    total_tokens: 90,
  }), {
    input_tokens: 150,
    cached_input_tokens: 100,
    output_tokens: 70,
    reasoning_tokens: 12,
    total_tokens: 220,
  });
});

test("raw token usage normalization can avoid synthesizing missing totals", () => {
  assert.deepEqual(normalizeTokenUsage({
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 20,
  }, { synthesizeTotal: false }), {
    input_tokens: 100,
    cached_input_tokens: 80,
    output_tokens: 20,
    reasoning_tokens: null,
    total_tokens: null,
  });
  assert.deepEqual(addTokenUsage({
    input_tokens: 100,
    output_tokens: 20,
  }, {
    input_tokens: 50,
    output_tokens: 30,
  }), {
    input_tokens: 150,
    cached_input_tokens: null,
    output_tokens: 50,
    reasoning_tokens: null,
    total_tokens: null,
  });
});

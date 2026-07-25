import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTelegramReply,
  renderTelegramHtml,
  splitTelegramReply,
} from "../src/transport/telegram-reply-normalizer.js";

const TELEGRAM_INDENT = "\u00A0\u00A0\u00A0\u00A0";

test("normalizeTelegramReply keeps plain session-friendly text and strips local file targets", () => {
  const source = [
    "Created [`test.js`](/path/to/workspace/test.js).",
    "Verified `SIGTERM` and **workspace**.",
    "",
    "See [documentation](https://example.com/docs).",
  ].join("\n");

  assert.equal(
    normalizeTelegramReply(source),
    [
      "Created test.js.",
      "Verified SIGTERM and workspace.",
      "",
      "See documentation: https://example.com/docs.",
    ].join("\n"),
  );
});

test("renderTelegramHtml converts supported Codex markdown to Telegram HTML", () => {
  const source = [
    "# Heading",
    "",
    "See [`README.md#L5`](/path/to/workspace/README.md#L5) and [documentation](https://example.com/docs).",
    "",
    "> Quote with `code`, **bold**, ~~strike~~ and ||spoiler||.",
    "",
    "```js",
    "console.log('hello');",
    "```",
  ].join("\n");

  assert.equal(
    renderTelegramHtml(source),
    [
      "<b>Heading</b>",
      "",
      'See <code>README.md#L5</code> and <a href="https://example.com/docs">documentation</a>.',
      "",
      "<blockquote>Quote with <code>code</code>, <b>bold</b>, strike and spoiler.</blockquote>",
      "",
      '<pre><code class="language-js">console.log(\'hello\');</code></pre>',
    ].join("\n"),
  );
});

test("renderTelegramHtml supports expandable blockquotes", () => {
  const source = [
    "Top block",
    "",
    ">> my mood: calm",
    ">> voice:",
    ">> Quietly working through the long file.",
    ">>",
    ">> project: gateway",
  ].join("\n");

  assert.equal(
    renderTelegramHtml(source),
    [
      "Top block",
      "",
      "<blockquote expandable>my mood: calm\nvoice:\nQuietly working through the long file.\n\nproject: gateway</blockquote>",
    ].join("\n"),
  );
});

test("renderTelegramHtml keeps nested list structure readable in Telegram", () => {
  const source = [
    "- top bullet",
    "  - nested bullet with `code`",
    "    - deep bullet",
    "1. first step",
    "  1. nested numbered step",
  ].join("\n");

  assert.equal(
    renderTelegramHtml(source),
    [
      "• top bullet",
      `${TELEGRAM_INDENT}◦ nested bullet with <code>code</code>`,
      `${TELEGRAM_INDENT}${TELEGRAM_INDENT}▪ deep bullet`,
      "1. first step",
      `${TELEGRAM_INDENT}1. nested numbered step`,
    ].join("\n"),
  );
});

test("splitTelegramReply keeps fenced code blocks valid across chunks", () => {
  const repeated = Array.from({ length: 12 }, (_, index) => `line-${index}-${"x".repeat(40)}`);
  const source = [
    "```txt",
    ...repeated,
    "```",
  ].join("\n");

  const chunks = splitTelegramReply(source, 220);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 220);
    assert.match(chunk, /^<pre>/u);
    assert.match(chunk, /<\/pre>$/u);
  }
});

test("splitTelegramReply handles very long unbroken words efficiently", () => {
  const source = "x".repeat(50_000);
  const startedAt = performance.now();
  const chunks = splitTelegramReply(source, 500);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(chunks.length > 1);
  assert.ok(elapsedMs < 1000);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
  }
});

test("splitTelegramReply handles very long single-line code fences efficiently", () => {
  const source = [
    "```txt",
    "x".repeat(50_000),
    "```",
  ].join("\n");
  const startedAt = performance.now();
  const chunks = splitTelegramReply(source, 500);
  const elapsedMs = performance.now() - startedAt;

  assert.ok(chunks.length > 1);
  assert.ok(elapsedMs < 1000);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500);
    assert.match(chunk, /^<pre>/u);
    assert.match(chunk, /<\/pre>$/u);
  }
});

test("telegram reply normalizer handles CRLF markdown safely", () => {
  const lfSource = [
    "# Header",
    "",
    "- bullet",
    "",
    "```txt",
    "line",
    "```",
  ].join("\n");
  const crlfSource = lfSource.replace(/\n/gu, "\r\n");

  assert.equal(
    normalizeTelegramReply(crlfSource),
    normalizeTelegramReply(lfSource),
  );
  assert.equal(
    renderTelegramHtml(crlfSource),
    renderTelegramHtml(lfSource),
  );
});

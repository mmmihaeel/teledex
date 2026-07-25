import test from "node:test";
import assert from "node:assert/strict";

import { buildCompactResumePrompt } from "../src/pty-worker/compact-resume.js";

function buildSession() {
  return {
    session_key: "-1000000:2203",
    topic_name: "codex-telegram",
    workspace_binding: {
      cwd: "/path/to/workspace",
    },
    exchange_log_entries: 764,
  };
}

test("buildCompactResumePrompt unwraps structured prompts before embedding the latest user request", () => {
  const prompt = buildCompactResumePrompt({
    session: buildSession(),
    prompt: [
      "Work Style:",
      "Keep it short and practical.",
      "",
      "User Prompt:",
      "Fix the broken import path without regressing smoke.",
    ].join("\n"),
    compactState: {
      activeBrief: "# Active brief\nready\n",
    },
    mode: "fresh-brief",
  });

  assert.match(prompt, /## Latest user request/u);
  assert.match(prompt, /Fix the broken import path without regressing smoke\./u);
  assert.doesNotMatch(prompt, /Work Style:/u);
  assert.doesNotMatch(prompt, /Keep it short and practical\./u);
});

test("buildCompactResumePrompt truncates oversized latest user requests", () => {
  const longPrompt = `User Prompt:\n${"x".repeat(5000)}`;
  const prompt = buildCompactResumePrompt({
    session: buildSession(),
    prompt: longPrompt,
    compactState: {
      activeBrief: "# Active brief\nready\n",
    },
  });

  assert.match(prompt, /\[truncated\]/u);
});

test("buildCompactResumePrompt keeps the latest request visible when attachments preface a structured prompt", () => {
  const prompt = buildCompactResumePrompt({
    session: buildSession(),
    prompt: [
      "Telegram attachments are included with this message. Use them as part of the context.",
      "- image: /tmp/input.png [image/png, 123 bytes]",
      "",
      "User Prompt:",
      "Fix the failure without breaking the smoke test.",
    ].join("\n"),
    compactState: {
      activeBrief: "# Active brief\nready\n",
    },
  });

  assert.match(prompt, /Fix the failure without breaking the smoke test\./u);
  assert.doesNotMatch(prompt, /Telegram attachments are included/u);
  assert.doesNotMatch(prompt, /- image: \/tmp\/input\.png/u);
});

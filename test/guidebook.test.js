import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __guidebookTest,
  generateGuidebookPdf,
} from "../src/telegram/guidebook.js";

test("generateGuidebookPdf creates the English beginner guide PDF", async () => {
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "teledex-guidebook-test-"),
  );
  const outputPath = path.join(outputDir, "guidebook-eng.pdf");

  const result = await generateGuidebookPdf({ outputPath });

  const pdf = await fs.readFile(outputPath);
  assert.match(pdf.subarray(0, 8).toString("utf8"), /^%PDF-/u);
  assert.equal(result.filePath, outputPath);
  assert.equal(result.fileName, "teledex-guidebook-eng.pdf");
  assert.ok(pdf.length > 1_000);

  const source = await fs.readFile(result.sourcePath, "utf8");
  assert.match(source, /Teledex Operator Guidebook/u);
  assert.doesNotMatch(source, /workspace\/project/iu);
});

test("guidebook markdown parser removes inline markdown markers from rendered prose", () => {
  const blocks = __guidebookTest.parseMarkdownBlocks(`
# Title

Use \`/new Topic Name\` in **General** and open /menu after that.

- Keep \`/q\` for queued work
 - Keep /model unchanged
  `);

  assert.deepEqual(blocks, [
    {
      type: "heading-1",
      text: "Title",
    },
    {
      type: "paragraph",
      text: "Use /new Topic Name in General and open /menu after that.",
    },
    {
      type: "bullets",
      items: ["Keep /q for queued work", "Keep /model unchanged"],
    },
  ]);
});

test("guidebook font resolution picks Unicode Windows fonts before PDF base fonts", () => {
  const fontSet = __guidebookTest.resolveFontSet({
    platform: "win32",
    env: {
      WINDIR: "C:\\Windows",
    },
    existsSync(candidate) {
      return /arial(?:bd)?\.ttf$|consola\.ttf$/iu.test(candidate);
    },
  });

  assert.match(fontSet.sans, /arial\.ttf$/iu);
  assert.match(fontSet.bold, /arialbd\.ttf$/iu);
  assert.match(fontSet.mono, /consola\.ttf$/iu);
});

test("guidebook font coverage fails loudly for non-ASCII text without a Unicode font", () => {
  assert.throws(
    () =>
      __guidebookTest.ensureUnicodeFontCoverage(
        "# Resume\n\nR\u00e9sum\u00e9",
        "/tmp/guidebook-localized.md",
        {
          sans: null,
          bold: null,
          mono: null,
        },
      ),
    /Unicode-capable PDF font for non-ASCII guidebook text/iu,
  );
});

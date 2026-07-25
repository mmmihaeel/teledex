import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import PDFDocument from "pdfkit";

import {
  TELEDEX_APP_NAME,
  TELEDEX_DISPLAY_NAME,
} from "../../config/app-identity.js";
import {
  GUIDEBOOK_RASTERIZE_SCRIPT,
  PAGE,
  getGuidebookFileName,
  getGuidebookSourcePath,
  getNormalizedLanguage,
  getRunbookFileName,
  getRunbookSourcePath,
} from "./config.js";
import { ensureUnicodeFontCoverage, getFontName, registerFonts } from "./fonts.js";
import { parseMarkdownBlocks } from "./markdown.js";

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) {
    doc.addPage();
  }
}

function drawPageHeader(doc, label, pageNumber) {
  const x = doc.page.margins.left;
  doc
    .font(getFontName("sans"))
    .fontSize(8.5)
    .fillColor("#94A3B8")
    .text(label, x, 18, {
      width: contentWidth(doc) / 2,
      lineBreak: false,
    })
    .text(String(pageNumber), x, 18, {
      width: contentWidth(doc),
      align: "right",
      lineBreak: false,
    });
  doc.x = x;
  doc.y = doc.page.margins.top;
}

function drawHeading(doc, text, level) {
  const size = level === 1 ? 20 : 13.5;
  const gap = level === 1 ? 14 : 10;
  doc.font(getFontName("bold")).fontSize(size);
  const height = doc.heightOfString(text, {
    width: contentWidth(doc),
    lineGap: 2,
  });
  ensureSpace(doc, height + gap);
  doc
    .font(getFontName("bold"))
    .fontSize(size)
    .fillColor(level === 1 ? "#0F172A" : "#111827")
    .text(text, doc.page.margins.left, doc.y, {
      width: contentWidth(doc),
      lineGap: 2,
    });
  doc.moveDown(level === 1 ? 0.5 : 0.3);
}

function drawParagraph(doc, text, lead) {
  const size = lead ? 11.2 : 10.2;
  const lineGap = lead ? 2.2 : 1.7;
  doc.font(getFontName("sans")).fontSize(size);
  const height = doc.heightOfString(text, {
    width: contentWidth(doc),
    lineGap,
  });
  ensureSpace(doc, height + 8);
  doc
    .font(getFontName("sans"))
    .fontSize(size)
    .fillColor(lead ? "#334155" : "#1F2937")
    .text(text, doc.page.margins.left, doc.y, {
      width: contentWidth(doc),
      lineGap,
    });
  doc.moveDown(0.35);
}

function drawList(doc, items, ordered) {
  const x = doc.page.margins.left;
  const markerWidth = 20;
  const textWidth = contentWidth(doc) - markerWidth;

  for (let index = 0; index < items.length; index += 1) {
    const marker = ordered ? `${index + 1}.` : "\u2022";
    doc.font(getFontName("sans")).fontSize(9.8);
    const height = Math.max(
      doc.heightOfString(marker, { width: markerWidth }),
      doc.heightOfString(items[index], { width: textWidth, lineGap: 1.7 }),
    );
    ensureSpace(doc, height + 4);
    const y = doc.y;
    doc.fillColor("#1F2937").text(marker, x, y, { width: markerWidth });
    doc.text(items[index], x + markerWidth, y, {
      width: textWidth,
      lineGap: 1.7,
    });
    doc.x = x;
    doc.y = y + height + 4;
  }
  doc.moveDown(0.2);
}

function drawCode(doc, text) {
  const padding = 8;
  const width = contentWidth(doc);
  doc.font(getFontName("mono")).fontSize(8.2);
  const textHeight = doc.heightOfString(text, {
    width: width - padding * 2,
    lineGap: 1.2,
  });
  const height = textHeight + padding * 2;
  ensureSpace(doc, height + 6);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.save().roundedRect(x, y, width, height, 10).fill("#F6EFD9").restore();
  doc
    .font(getFontName("mono"))
    .fontSize(8.2)
    .fillColor("#111827")
    .text(text, x + padding, y + padding, {
      width: width - padding * 2,
      lineGap: 1.2,
    });
  doc.x = x;
  doc.y = y + height + 6;
}

function renderBlocks(doc, blocks) {
  let hasLeadParagraph = false;
  for (const block of blocks) {
    if (block.type === "heading-1") {
      drawHeading(doc, block.text, 1);
    } else if (block.type === "heading-2") {
      drawHeading(doc, block.text, 2);
    } else if (block.type === "paragraph") {
      drawParagraph(doc, block.text, !hasLeadParagraph);
      hasLeadParagraph = true;
    } else if (block.type === "bullets") {
      drawList(doc, block.items, false);
    } else if (block.type === "numbered") {
      drawList(doc, block.items, true);
    } else if (block.type === "code") {
      drawCode(doc, block.text);
    }
  }
}

function withTeledexTitle(title) {
  const normalized = String(title || "").trim();
  if (!normalized) {
    return TELEDEX_DISPLAY_NAME;
  }
  return normalized.includes(TELEDEX_DISPLAY_NAME)
    ? normalized
    : `${TELEDEX_DISPLAY_NAME}: ${normalized}`;
}

async function execFileAsync(command, args) {
  await new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function renderVectorPdf({
  language,
  outputPath,
  sourcePathResolver,
  fileNameResolver,
  fallbackTitle,
  footerLabel,
}) {
  const normalizedLanguage = getNormalizedLanguage(language);
  const sourcePath = sourcePathResolver(normalizedLanguage);
  const markdown = await fsp.readFile(sourcePath, "utf8");
  ensureUnicodeFontCoverage(markdown, sourcePath);
  const blocks = parseMarkdownBlocks(markdown);
  const title = blocks.find((block) => block.type === "heading-1")?.text
    || fallbackTitle;

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      ...PAGE,
      bufferPages: true,
      info: {
        Title: withTeledexTitle(title),
        Author: TELEDEX_APP_NAME,
        Subject: footerLabel,
      },
    });
    const stream = fs.createWriteStream(outputPath);
    let pageNumber = 1;

    doc.pipe(stream);
    registerFonts(doc);
    drawPageHeader(doc, footerLabel, pageNumber);
    doc.on("pageAdded", () => {
      pageNumber += 1;
      drawPageHeader(doc, footerLabel, pageNumber);
    });
    renderBlocks(doc, blocks);
    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
  });

  return {
    filePath: outputPath,
    fileName: fileNameResolver(normalizedLanguage),
    contentType: "application/pdf",
    sourcePath,
  };
}

async function renderRasterizedPdf({ language, outputPath, renderVector }) {
  const vectorPath = `${outputPath}.vector-${process.pid}-${randomUUID()}.pdf`;
  const result = await renderVector({ language, outputPath: vectorPath });

  try {
    try {
      await execFileAsync("python3", [
        GUIDEBOOK_RASTERIZE_SCRIPT,
        vectorPath,
        outputPath,
      ]);
    } catch {
      await fsp.copyFile(vectorPath, outputPath);
    }
  } finally {
    await fsp.rm(vectorPath, { force: true });
  }

  return {
    ...result,
    filePath: outputPath,
  };
}

async function renderGuidebookVectorPdf({ language, outputPath }) {
  return renderVectorPdf({
    language,
    outputPath,
    sourcePathResolver: getGuidebookSourcePath,
    fileNameResolver: getGuidebookFileName,
    fallbackTitle: `${TELEDEX_DISPLAY_NAME} Guidebook`,
    footerLabel: `${TELEDEX_DISPLAY_NAME} guidebook`,
  });
}

async function renderRunbookVectorPdf({ language, outputPath }) {
  return renderVectorPdf({
    language,
    outputPath,
    sourcePathResolver: getRunbookSourcePath,
    fileNameResolver: getRunbookFileName,
    fallbackTitle: `${TELEDEX_DISPLAY_NAME} Runbook`,
    footerLabel: `${TELEDEX_DISPLAY_NAME} runbook`,
  });
}

export async function renderGuidebookPdf({ language, outputPath }) {
  return renderRasterizedPdf({
    language,
    outputPath,
    renderVector: renderGuidebookVectorPdf,
  });
}

export async function renderRunbookPdf({ language, outputPath }) {
  return renderRasterizedPdf({
    language,
    outputPath,
    renderVector: renderRunbookVectorPdf,
  });
}

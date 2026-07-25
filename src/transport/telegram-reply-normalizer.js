import { TELEGRAM_TEXT_LIMIT } from "./telegram-reply-normalizer/constants.js";
import {
  renderBlocksToChunks,
  splitOversizeBlock,
} from "./telegram-reply-normalizer/chunks.js";
import {
  renderMarkdownBlock,
  splitMarkdownBlocks,
} from "./telegram-reply-normalizer/markdown-renderer.js";
import {
  normalizeTelegramPlainReply,
  normalizeTelegramRichSource,
} from "./telegram-reply-normalizer/text.js";

export function normalizeTelegramReply(text) {
  return normalizeTelegramPlainReply(text);
}

export function renderTelegramHtml(text) {
  const blocks = splitMarkdownBlocks(normalizeTelegramRichSource(text));
  return renderBlocksToChunks(blocks, Number.MAX_SAFE_INTEGER).join("\n\n").trim();
}

export function splitTelegramReply(text, limit = TELEGRAM_TEXT_LIMIT) {
  const blocks = splitMarkdownBlocks(normalizeTelegramRichSource(text));
  const expandedBlocks = blocks.flatMap((block) =>
    splitOversizeBlock(block, limit),
  );
  return renderBlocksToChunks(expandedBlocks, limit, renderMarkdownBlock);
}

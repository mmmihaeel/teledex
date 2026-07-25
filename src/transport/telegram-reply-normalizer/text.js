import {
  FENCE_PATTERN,
  INLINE_CODE_PATTERN,
  MARKDOWN_LINK_PATTERN,
  SUPPORTED_URL_PATTERN,
} from "./constants.js";

function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/gu, "\n");
}

export function isSupportedLinkTarget(target) {
  return SUPPORTED_URL_PATTERN.test(String(target || "").trim());
}

function formatMarkdownLink(label, target) {
  const normalizedLabel = String(label || "").trim();
  const normalizedTarget = String(target || "").trim();

  if (!normalizedTarget) {
    return normalizedLabel;
  }

  if (isSupportedLinkTarget(normalizedTarget)) {
    if (!normalizedLabel || normalizedLabel === normalizedTarget) {
      return normalizedTarget;
    }

    return `${normalizedLabel}: ${normalizedTarget}`;
  }

  return normalizedLabel || normalizedTarget;
}

export function escapeHtml(text) {
  return String(text || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

export function escapeHtmlAttribute(text) {
  return escapeHtml(text).replace(/"/gu, "&quot;");
}

export function trimTrailingWhitespace(text) {
  return String(text || "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]+$/gu, "")
    .trim();
}

function normalizeMarkdownTextSegment(text) {
  return trimTrailingWhitespace(
    String(text || "").replace(MARKDOWN_LINK_PATTERN, (_match, label, target) => {
      const normalizedLabel = String(label || "").trim();
      const normalizedTarget = String(target || "").trim();
      if (!normalizedTarget) {
        return normalizedLabel;
      }

      if (isSupportedLinkTarget(normalizedTarget)) {
        if (!normalizedLabel || normalizedLabel === normalizedTarget) {
          return normalizedTarget;
        }
        return `[${normalizedLabel}](${normalizedTarget})`;
      }

      return normalizedLabel || normalizedTarget;
    }),
  );
}

function normalizePlainTextSegment(text) {
  return trimTrailingWhitespace(
    String(text || "")
      .replace(MARKDOWN_LINK_PATTERN, (_match, label, target) =>
        formatMarkdownLink(label, target),
      )
      .replace(INLINE_CODE_PATTERN, "$1")
      .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
      .replace(/__([^_\n]+)__/gu, "$1")
      .replace(/~~([^~\n]+)~~/gu, "$1")
      .replace(/\|\|([^|\n]+)\|\|/gu, "$1")
      .replace(/^#{1,6}\s+/gmu, "")
      .replace(/[ \t]+\n/gu, "\n"),
  );
}

function normalizeAroundFences(text, normalizeSegment) {
  const source = normalizeLineEndings(text);
  const chunks = [];
  let lastIndex = 0;

  for (const match of source.matchAll(FENCE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      chunks.push(normalizeSegment(source.slice(lastIndex, matchIndex)));
    }
    chunks.push(trimTrailingWhitespace(match[0]));
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < source.length) {
    chunks.push(normalizeSegment(source.slice(lastIndex)));
  }

  return chunks.join("").replace(/\n{3,}/gu, "\n\n").trim();
}

export function normalizeTelegramRichSource(text) {
  return normalizeAroundFences(text, normalizeMarkdownTextSegment);
}

export function normalizeTelegramPlainReply(text) {
  return normalizeAroundFences(text, normalizePlainTextSegment);
}

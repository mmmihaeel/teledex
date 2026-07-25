import {
  HEADING_PATTERN,
  INLINE_CODE_PATTERN,
  MARKDOWN_LINK_PATTERN,
  FENCE_PATTERN,
  ORDERED_LIST_PATTERN,
  PLACEHOLDER_PREFIX,
  PLACEHOLDER_SUFFIX,
  TELEGRAM_INDENT,
  UNORDERED_LIST_MARKERS,
  UNORDERED_LIST_PATTERN,
} from "./constants.js";
import {
  escapeHtml,
  escapeHtmlAttribute,
  isSupportedLinkTarget,
  trimTrailingWhitespace,
} from "./text.js";

function stashInlineHtml(stashed, html) {
  const index = stashed.push(html) - 1;
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

function restoreInlineHtml(text, stashed) {
  return String(text || "").replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "gu"),
    (_match, index) => stashed[Number(index)] || "",
  );
}

function renderDelimited(text, pattern, openTag, closeTag) {
  return text.replace(pattern, (_match, inner) => {
    const normalizedInner = String(inner || "").trim();
    return normalizedInner ? `${openTag}${normalizedInner}${closeTag}` : _match;
  });
}

function renderInlineMarkdown(text) {
  const stashed = [];
  let rendered = String(text || "");

  rendered = rendered.replace(MARKDOWN_LINK_PATTERN, (_match, label, target) => {
    const normalizedLabel = String(label || "").trim();
    const normalizedTarget = String(target || "").trim();
    if (!normalizedTarget) {
      return stashInlineHtml(stashed, escapeHtml(normalizedLabel));
    }

    if (!isSupportedLinkTarget(normalizedTarget)) {
      return stashInlineHtml(stashed, escapeHtml(normalizedLabel || normalizedTarget));
    }

    const linkLabel = escapeHtml(normalizedLabel || normalizedTarget);
    const href = escapeHtmlAttribute(normalizedTarget);
    return stashInlineHtml(stashed, `<a href="${href}">${linkLabel}</a>`);
  });

  rendered = rendered.replace(INLINE_CODE_PATTERN, (_match, code) =>
    stashInlineHtml(stashed, `<code>${escapeHtml(code)}</code>`),
  );

  rendered = escapeHtml(rendered);
  rendered = renderDelimited(rendered, /\*\*([^\n]+?)\*\*/gu, "<b>", "</b>");
  rendered = renderDelimited(rendered, /__([^\n]+?)__/gu, "<u>", "</u>");
  rendered = rendered.replace(/~~([^\n]+?)~~/gu, "$1");
  rendered = rendered.replace(/\|\|([^\n]+?)\|\|/gu, "$1");
  rendered = rendered.replace(/(^|[^\w\\])\*([^\s*][^*\n]*?)\*(?!\w)/gu, (_m, prefix, inner) =>
    `${prefix}<i>${inner}</i>`,
  );
  rendered = rendered.replace(/(^|[^\w\\])_([^\s_][^_\n]*?)_(?!\w)/gu, (_m, prefix, inner) =>
    `${prefix}<i>${inner}</i>`,
  );
  return restoreInlineHtml(rendered, stashed);
}

function countIndentColumns(whitespace) {
  return String(whitespace || "")
    .split("")
    .reduce((total, char) => total + (char === "\t" ? 2 : 1), 0);
}

function renderListLine(line) {
  const unorderedMatch = String(line || "").match(UNORDERED_LIST_PATTERN);
  if (unorderedMatch) {
    const [, whitespace, , content] = unorderedMatch;
    const depth = Math.max(0, Math.floor(countIndentColumns(whitespace) / 2));
    const indent = TELEGRAM_INDENT.repeat(depth);
    const marker = UNORDERED_LIST_MARKERS[
      Math.min(depth, UNORDERED_LIST_MARKERS.length - 1)
    ];
    return `${indent}${marker} ${renderInlineMarkdown(content)}`;
  }

  const orderedMatch = String(line || "").match(ORDERED_LIST_PATTERN);
  if (orderedMatch) {
    const [, whitespace, number, delimiter, content] = orderedMatch;
    const depth = Math.max(0, Math.floor(countIndentColumns(whitespace) / 2));
    const indent = TELEGRAM_INDENT.repeat(depth);
    return `${indent}${escapeHtml(`${number}${delimiter}`)} ${renderInlineMarkdown(content)}`;
  }

  return null;
}

function renderParagraphBlock(block) {
  return String(block || "")
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(HEADING_PATTERN);
      if (headingMatch) {
        return `<b>${renderInlineMarkdown(headingMatch[1].trim())}</b>`;
      }

      const listLine = renderListLine(line);
      if (listLine) {
        return listLine;
      }

      return renderInlineMarkdown(line);
    })
    .join("\n");
}

export function isFenceBlock(block) {
  return /^```/u.test(String(block || "").trim());
}

export function parseFenceBlock(block) {
  const match = String(block || "").match(/^```([^\n`]*)\n?([\s\S]*?)```$/u);
  if (!match) {
    return null;
  }

  return {
    language: String(match[1] || "").trim(),
    code: match[2] || "",
  };
}

function getBlockquoteMarker(line) {
  const trimmed = String(line || "").trimStart();
  if (trimmed.startsWith(">>")) {
    return ">>";
  }
  if (trimmed.startsWith(">")) {
    return ">";
  }
  return null;
}

export function parseBlockquoteBlock(block) {
  const lines = String(block || "").split("\n");
  let marker = null;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const lineMarker = getBlockquoteMarker(line);
    if (!lineMarker) {
      return null;
    }
    if (!marker) {
      marker = lineMarker;
      continue;
    }
    if (marker !== lineMarker) {
      return null;
    }
  }

  if (!marker) {
    return null;
  }

  const content = lines
    .map((line) => {
      if (!line.trim()) {
        return "";
      }

      return marker === ">>"
        ? line.replace(/^\s*>>\s?/u, "")
        : line.replace(/^\s*>\s?/u, "");
    })
    .join("\n")
    .trim();

  return {
    expandable: marker === ">>",
    marker,
    content,
  };
}

export function isBlockquoteBlock(block) {
  return Boolean(parseBlockquoteBlock(block));
}

function renderFenceBlock(block) {
  const parsed = parseFenceBlock(block);
  if (!parsed) {
    return `<pre>${escapeHtml(String(block || ""))}</pre>`;
  }

  const escapedCode = escapeHtml(parsed.code.replace(/\n+$/u, ""));
  if (parsed.language) {
    return `<pre><code class="language-${escapeHtmlAttribute(parsed.language)}">${escapedCode}</code></pre>`;
  }

  return `<pre>${escapedCode}</pre>`;
}

function renderBlockquoteBlock(block) {
  const parsed = parseBlockquoteBlock(block);
  if (!parsed) {
    return renderParagraphBlock(block);
  }

  const rendered = renderParagraphBlock(parsed.content);
  return parsed.expandable
    ? `<blockquote expandable>${rendered}</blockquote>`
    : `<blockquote>${rendered}</blockquote>`;
}

export function renderMarkdownBlock(block) {
  if (isFenceBlock(block)) {
    return renderFenceBlock(block);
  }

  if (isBlockquoteBlock(block)) {
    return renderBlockquoteBlock(block);
  }

  return renderParagraphBlock(block);
}

function splitNonFenceBlocks(segment) {
  return String(segment || "")
    .split(/\n{2,}/u)
    .map((block) => trimTrailingWhitespace(block))
    .filter(Boolean);
}

export function splitMarkdownBlocks(text) {
  const normalized = trimTrailingWhitespace(text);
  if (!normalized) {
    return [];
  }

  const blocks = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(FENCE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      blocks.push(...splitNonFenceBlocks(normalized.slice(lastIndex, matchIndex)));
    }
    blocks.push(trimTrailingWhitespace(match[0]));
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < normalized.length) {
    blocks.push(...splitNonFenceBlocks(normalized.slice(lastIndex)));
  }

  return blocks;
}

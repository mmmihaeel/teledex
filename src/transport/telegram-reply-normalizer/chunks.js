import { TELEGRAM_TEXT_LIMIT } from "./constants.js";
import {
  isBlockquoteBlock,
  isFenceBlock,
  parseBlockquoteBlock,
  parseFenceBlock,
  renderMarkdownBlock,
} from "./markdown-renderer.js";

function findLongestRenderablePrefix(value, limit, buildCandidate) {
  const source = String(value || "");
  if (!source) {
    return 0;
  }

  let low = 1;
  let high = source.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (renderMarkdownBlock(buildCandidate(source.slice(0, mid))).length <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function splitFenceCodeLines(language, code, limit) {
  const lines = String(code || "").split("\n");
  const chunks = [];
  let current = [];

  const buildFence = (candidateLines) => {
    const body = candidateLines.join("\n");
    return language ? `\`\`\`${language}\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\``;
  };

  const pushCurrent = () => {
    if (current.length > 0) {
      chunks.push(buildFence(current));
      current = [];
    }
  };

  for (const line of lines) {
    const candidate = buildFence([...current, line]);
    if (renderMarkdownBlock(candidate).length <= limit || current.length === 0) {
      current.push(line);
      if (renderMarkdownBlock(buildFence(current)).length <= limit) {
        continue;
      }
    }

    if (current.length > 0) {
      current.pop();
      pushCurrent();
    }

    let remainder = line;
    while (remainder.length > 0) {
      const sliceLength = findLongestRenderablePrefix(
        remainder,
        limit,
        (slice) => buildFence([slice]),
      );
      chunks.push(buildFence([remainder.slice(0, sliceLength)]));
      remainder = remainder.slice(sliceLength);
    }
  }

  pushCurrent();
  return chunks.filter(Boolean);
}

function splitBlockquoteLines(block, limit) {
  const parsed = parseBlockquoteBlock(block);
  const marker = parsed?.marker || ">";
  const lines = String(block || "")
    .split("\n")
    .filter((line) => line.trim());
  const chunks = [];
  let current = [];

  const buildBlock = (candidateLines) => candidateLines.join("\n");

  for (const line of lines) {
    const candidate = buildBlock([...current, line]);
    if (renderMarkdownBlock(candidate).length <= limit || current.length === 0) {
      current.push(line);
      if (renderMarkdownBlock(buildBlock(current)).length <= limit) {
        continue;
      }
    }

    if (current.length > 0) {
      current.pop();
      chunks.push(buildBlock(current));
      current = [];
    }

    let remainder = line;
    while (remainder.length > 0) {
      const sliceLength = findLongestRenderablePrefix(
        remainder,
        limit,
        (slice) => slice.startsWith(marker) ? slice : `${marker} ${slice}`,
      );
      const slice = remainder.slice(0, sliceLength);
      chunks.push(slice.startsWith(marker) ? slice : `${marker} ${slice}`);
      remainder = remainder.slice(sliceLength).trimStart();
    }
  }

  if (current.length > 0) {
    chunks.push(buildBlock(current));
  }

  return chunks.filter(Boolean);
}

function splitParagraphByWords(block, limit) {
  const lines = String(block || "").split("\n");
  const chunks = [];

  const splitLongUnit = (unit) => {
    const unitChunks = [];
    let remainder = unit;

    while (remainder.length > 0) {
      const sliceLength = findLongestRenderablePrefix(
        remainder,
        limit,
        (slice) => slice,
      );
      unitChunks.push(remainder.slice(0, sliceLength));
      remainder = remainder.slice(sliceLength);
    }

    return unitChunks;
  };

  const splitLine = (line) => {
    if (!line.trim()) {
      return [line];
    }

    const words = line.split(/\s+/u);
    const lineChunks = [];
    let current = "";

    const pushCurrent = () => {
      if (current) {
        lineChunks.push(current);
        current = "";
      }
    };

    for (const word of words) {
      if (!current) {
        if (renderMarkdownBlock(word).length <= limit) {
          current = word;
        } else {
          lineChunks.push(...splitLongUnit(word));
        }
        continue;
      }

      const candidate = `${current} ${word}`;
      if (renderMarkdownBlock(candidate).length <= limit) {
        current = candidate;
        continue;
      }

      pushCurrent();
      if (renderMarkdownBlock(word).length <= limit) {
        current = word;
      } else {
        lineChunks.push(...splitLongUnit(word));
      }
    }

    pushCurrent();
    return lineChunks;
  };

  for (const line of lines) {
    chunks.push(...splitLine(line));
  }

  return chunks.filter(Boolean);
}

export function splitOversizeBlock(block, limit = TELEGRAM_TEXT_LIMIT) {
  if (renderMarkdownBlock(block).length <= limit) {
    return [block];
  }

  if (isFenceBlock(block)) {
    const parsed = parseFenceBlock(block);
    return splitFenceCodeLines(parsed?.language || "", parsed?.code || "", limit);
  }

  if (isBlockquoteBlock(block)) {
    return splitBlockquoteLines(block, limit);
  }

  return splitParagraphByWords(block, limit);
}

export function renderBlocksToChunks(
  blocks,
  limit = TELEGRAM_TEXT_LIMIT,
  renderBlock = renderMarkdownBlock,
) {
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const block of blocks) {
    const rendered = renderBlock(block);
    if (!rendered) {
      continue;
    }

    const candidate = current ? `${current}\n\n${rendered}` : rendered;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    pushCurrent();
    current = rendered;
  }

  pushCurrent();
  return chunks;
}

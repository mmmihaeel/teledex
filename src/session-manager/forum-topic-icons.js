function normalizeCustomEmojiId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function extractForumTopicIconCustomEmojiIds(stickers) {
  if (!Array.isArray(stickers)) {
    return [];
  }

  const ids = [];
  const seen = new Set();
  for (const sticker of stickers) {
    const id = normalizeCustomEmojiId(sticker?.custom_emoji_id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function pickRandomForumTopicIconCustomEmojiId(customEmojiIds, {
  random = Math.random,
} = {}) {
  if (!Array.isArray(customEmojiIds) || customEmojiIds.length === 0) {
    return null;
  }

  const ids = customEmojiIds
    .map((entry) => normalizeCustomEmojiId(entry))
    .filter(Boolean);
  if (ids.length === 0) {
    return null;
  }

  const raw = Number(random());
  const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999999) : 0;
  return ids[Math.floor(bounded * ids.length)] || ids[0] || null;
}

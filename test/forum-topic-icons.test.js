import test from "node:test";
import assert from "node:assert/strict";

import {
  extractForumTopicIconCustomEmojiIds,
  pickRandomForumTopicIconCustomEmojiId,
} from "../src/session-manager/forum-topic-icons.js";

test("extractForumTopicIconCustomEmojiIds keeps valid unique custom emoji ids", () => {
  assert.deepEqual(
    extractForumTopicIconCustomEmojiIds([
      { custom_emoji_id: "111" },
      { custom_emoji_id: "222" },
      { custom_emoji_id: "111" },
      { custom_emoji_id: "" },
      {},
      null,
    ]),
    ["111", "222"],
  );
});

test("pickRandomForumTopicIconCustomEmojiId chooses a bounded id", () => {
  assert.equal(
    pickRandomForumTopicIconCustomEmojiId(["111", "222", "333"], {
      random: () => 0.5,
    }),
    "222",
  );
  assert.equal(
    pickRandomForumTopicIconCustomEmojiId(["111", "222", "333"], {
      random: () => 1,
    }),
    "333",
  );
  assert.equal(pickRandomForumTopicIconCustomEmojiId([]), null);
});

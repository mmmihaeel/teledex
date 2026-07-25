import test from "node:test";
import assert from "node:assert/strict";

import { renderTelegramHtml } from "../src/transport/telegram-reply-normalizer.js";
import {
  getZooPetTemperamentLabel,
  pickZooCharacterName,
} from "../src/zoo/creatures.js";
import {
  buildZooPetMarkup,
  buildZooPetText,
  buildZooRootText,
  buildZooRootMarkup,
  buildZooRootMarkupPage,
} from "../src/zoo/render.js";

test("buildZooPetText renders pose and stats as fenced code blocks and hides findings", () => {
  const text = buildZooPetText({
    language: "unexpected",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      temperament_id: "paladin",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: {
      mood: "calm",
      flavor_line: "I pad through the longest file 🐾.",
      project_summary: "A well-assembled project with strong tests.",
      next_focus: "Split the largest router.",
      findings: ["hidden finding"],
      refreshed_at: "2026-04-03T23:45:08.000Z",
      stats: {
        security: 85,
        shitcode: 18,
        junk: 12,
        tests: 98,
        structure: 93,
        docs: 92,
        operability: 95,
      },
      trends: {
        security: "same",
        shitcode: "same",
        junk: "same",
        tests: "same",
        structure: "same",
        docs: "same",
        operability: "same",
      },
    },
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: null,
      last_refresh_error_text: null,
    },
  });

  assert.doesNotMatch(text, /Project Project Catalog/u);
  assert.match(text, /```txt/u);
  assert.doesNotMatch(text, /Findings/u);
  assert.doesNotMatch(text, /hidden finding/u);
  assert.match(text, /Shitcode/u);
  assert.match(text, />> my mood: calm/u);
  assert.match(text, />> voice: I pad through the longest file 🐾\./u);
  assert.match(text, />> summary: A well-assembled project with strong tests\./u);
  assert.match(
    text,
    new RegExp(`cat · ${getZooPetTemperamentLabel({ pet_id: "pet-1", creature_kind: "cat", temperament_id: "paladin" }, "unexpected")}`, "u"),
  );
  assert.match(text, />> project: gateway/u);
  assert.ok(text.indexOf(">> project: gateway") > text.indexOf(">> next focus: Split the largest router."));
  assert.ok(text.indexOf(">> project: gateway") < text.indexOf(">> repo: apps/teledex"));
  assert.doesNotMatch(text, /"I pad/u);
  assert.doesNotMatch(text, /\p{Script=Cyrillic}/u);
  assert.doesNotMatch(text, new RegExp(`^${pickZooCharacterName("pet-1")}$`, "mu"));

  const html = renderTelegramHtml(text);
  const preCount = Array.from(html.matchAll(/<pre>/gu)).length;
  assert.equal(preCount, 1);
  assert.match(html, /<blockquote expandable>my mood: calm/u);
  assert.match(html, /voice: I pad through the longest file 🐾\./u);
});

test("Project Catalog render keeps buttons in English for unexpected locale input", () => {
  assert.deepEqual(
    buildZooPetMarkup("pet-1", { language: "unexpected" }).inline_keyboard[0].map((button) => button.text),
    ["Refresh", "Remove"],
  );
  assert.deepEqual(
    buildZooRootMarkup([], "eng").inline_keyboard.at(-1).map((button) => button.text),
    ["Add project", "Respawn menu"],
  );
});

test("Project Catalog root markup paginates after six pets", () => {
  const pets = Array.from({ length: 6 }, (_, index) => ({
    pet_id: `pet-${index + 1}`,
    display_name: `project-${index + 1}`,
  }));

  const firstPageMarkup = buildZooRootMarkupPage(pets, "eng", {
    currentPage: 0,
    totalPages: 2,
  });
  assert.deepEqual(
    firstPageMarkup.inline_keyboard.at(-2).map((button) => button.text),
    ["Next ›"],
  );

  const middlePageMarkup = buildZooRootMarkupPage(pets, "eng", {
    currentPage: 1,
    totalPages: 3,
  });
  assert.deepEqual(
    middlePageMarkup.inline_keyboard.at(-2).map((button) => button.text),
    ["‹ Back", "Next ›"],
  );

  const lastPageMarkup = buildZooRootMarkupPage(pets, "eng", {
    currentPage: 1,
    totalPages: 2,
  });
  assert.deepEqual(
    lastPageMarkup.inline_keyboard.at(-2).map((button) => button.text),
    ["‹ Back"],
  );
});

test("Project Catalog root markup keeps public/private suffixes visible on long duplicate names", () => {
  const markup = buildZooRootMarkupPage([
    {
      pet_id: "pet-private",
      display_name: "teledex-control-plane [priv]",
    },
    {
      pet_id: "pet-public",
      display_name: "teledex-control-plane [pub]",
    },
  ], "eng", {
    currentPage: 0,
    totalPages: 1,
  });

  assert.equal(markup.inline_keyboard[0][0].text, "teledex-contro... [priv]");
  assert.equal(markup.inline_keyboard[0][1].text, "teledex-control... [pub]");
});

test("buildZooRootText renders pending add-project confirmation inside the menu", () => {
  const text = buildZooRootText({
    language: "unexpected",
    pets: [],
    state: {
      active_screen: "root",
      selected_pet_id: null,
      pending_add: {
        stage: "await_confirmation",
        busy: false,
        candidate_path: "/path/to/workspace/project-a",
        candidate_reason: "This looks like the requested private gateway.",
        candidate_question: "Is this the right project? Reply Yes or No.",
      },
    },
  });

  assert.match(text, /add project:/u);
  assert.match(text, /\/path\/to\/workspace\/project-a/u);
  assert.match(text, /Reply Yes or No/u);
  assert.doesNotMatch(text, /\p{Script=Cyrillic}/u);
});

test("buildZooRootText does not duplicate the pet roster in plain text", () => {
  const text = buildZooRootText({
    language: "unexpected",
    pets: [
      { pet_id: "pet-1", display_name: "gateway-a" },
      { pet_id: "pet-2", display_name: "gateway-b" },
    ],
    totalPetCount: 2,
    state: {
      active_screen: "root",
      selected_pet_id: null,
    },
  });

  assert.match(text, /pets: 2/u);
  assert.doesNotMatch(text, /Command:/u);
  assert.doesNotMatch(text, /gateway-a/u);
  assert.doesNotMatch(text, /gateway-b/u);
});

test("buildZooPetText does not suggest refresh while the first refresh is already running", () => {
  const text = buildZooPetText({
    language: "unexpected",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: "pet-1",
      refresh_status_text: "Analyzing the full project...",
      last_refresh_error_text: null,
    },
  });

  assert.match(text, /First snapshot is brewing/u);
  assert.doesNotMatch(text, /Tap Refresh/u);
  assert.match(text, /Shitcode\s+\[\.\.\.\.\.\.\.\.\.\.\]\s+--\s+·/u);
  assert.match(text, />> status: Analyzing the full project/u);
});

test("buildZooPetText switches from generic start text to temperament voice on later refresh frames", () => {
  const text = buildZooPetText({
    language: "unexpected",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: "pet-1",
      refresh_status_text: "Analyzing the full project...",
      last_refresh_error_text: null,
    },
    poseFrameIndex: 1,
  });

  assert.match(text, />> status:/u);
  assert.doesNotMatch(text, />> status: Analyzing the full project/u);
});

test("buildZooPetText keeps placeholder stats in the unified card before the first snapshot exists", () => {
  const text = buildZooPetText({
    language: "unexpected",
    pet: {
      pet_id: "pet-new",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-new",
      refreshing_pet_id: null,
      last_refresh_error_text: null,
    },
  });

  const html = renderTelegramHtml(text);
  const preCount = Array.from(html.matchAll(/<pre>/gu)).length;
  assert.equal(preCount, 1);
  assert.match(text, /Security\s+\[\.\.\.\.\.\.\.\.\.\.\]\s+--\s+·/u);
  assert.match(text, /Shitcode\s+\[\.\.\.\.\.\.\.\.\.\.\]\s+--\s+·/u);
});

test("buildZooPetText renders arrows for changed stats and keeps equals for unchanged ones", () => {
  const text = buildZooPetText({
    language: "unexpected",
    pet: {
      pet_id: "pet-trends",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: {
      mood: "focused",
      flavor_line: "Today I am digging through the fresh diff.",
      project_summary: "The codebase is active and changing.",
      next_focus: "Polish the remaining rough edges.",
      findings: [],
      refreshed_at: "2026-04-04T12:40:00.000Z",
      stats: {
        security: 81,
        shitcode: 12,
        junk: 9,
        tests: 96,
        structure: 95,
        docs: 97,
        operability: 87,
      },
      trends: {
        security: "up",
        shitcode: "down",
        junk: "same",
        tests: "up",
        structure: "same",
        docs: "down",
        operability: "up",
      },
    },
    state: {
      selected_pet_id: "pet-trends",
      refreshing_pet_id: null,
      last_refresh_error_text: null,
    },
  });

  assert.match(text, /Security\s+\[########\.\.\]\s+81\s+↑/u);
  assert.match(text, /Shitcode\s+\[#\.\.\.\.\.\.\.\.\.\]\s+12\s+↓/u);
  assert.match(text, /Junk\s+\[#\.\.\.\.\.\.\.\.\.\]\s+\s*9\s+=/u);
});

test("buildZooPetText uses temperament-stable refresh voice for different pets", () => {
  const firstText = buildZooPetText({
    language: "eng",
    pet: {
      pet_id: "pet-1",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-1",
      refreshing_pet_id: "pet-1",
      refresh_status_text: null,
      last_refresh_error_text: null,
    },
  });
  const secondText = buildZooPetText({
    language: "eng",
    pet: {
      pet_id: "pet-6",
      display_name: "gateway",
      creature_kind: "cat",
      cwd_relative_to_workspace_root: "apps/teledex",
    },
    snapshot: null,
    state: {
      selected_pet_id: "pet-6",
      refreshing_pet_id: "pet-6",
      refresh_status_text: null,
      last_refresh_error_text: null,
    },
  });

  const firstStatusLine = firstText.split("\n").find((line) => line.startsWith(">> status: "));
  const secondStatusLine = secondText.split("\n").find((line) => line.startsWith(">> status: "));

  assert.ok(firstStatusLine);
  assert.ok(secondStatusLine);
  assert.notEqual(firstStatusLine, secondStatusLine);
});

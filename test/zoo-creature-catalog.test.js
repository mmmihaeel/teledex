import test from "node:test";
import assert from "node:assert/strict";

import {
  CREATURE_PROFILES,
  TEMPERAMENT_PROFILES,
  TEMPERAMENT_PROFILE_BY_ID,
  ZOO_CREATURE_KINDS,
  ZOO_TEMPERAMENT_IDS,
} from "../src/zoo/creature-catalog.js";

const ENGLISH_ONLY_KEYS = ["eng"];
const NON_LATIN_TEXT = /\p{Script=Cyrillic}/u;

test("Project Catalog creature catalog has complete profiles for every public kind", () => {
  assert.ok(ZOO_CREATURE_KINDS.length > 0);

  for (const kind of ZOO_CREATURE_KINDS) {
    const profile = CREATURE_PROFILES[kind];
    assert.ok(profile, `missing profile for ${kind}`);

    assert.deepEqual(Object.keys(profile.labels), ENGLISH_ONLY_KEYS);
    assert.equal(typeof profile.labels.eng, "string", `${kind} English label`);
    assert.ok(profile.labels.eng.trim(), `${kind} English label`);
    assert.deepEqual(Object.keys(profile.persona), ENGLISH_ONLY_KEYS);
    assert.equal(typeof profile.persona.eng, "string", `${kind} English persona`);
    assert.ok(profile.persona.eng.trim(), `${kind} English persona`);
    assert.deepEqual(Object.keys(profile.refreshStatus), ENGLISH_ONLY_KEYS);
    assert.ok(
      Array.isArray(profile.refreshStatus.eng)
        && profile.refreshStatus.eng.every((value) => String(value).trim()),
      `${kind} English refresh status`,
    );
    assert.doesNotMatch(JSON.stringify(profile), NON_LATIN_TEXT);

    assert.ok(
      Array.isArray(profile.idlePoses)
        && profile.idlePoses.every((pose) =>
          Array.isArray(pose) && pose.every((line) => typeof line === "string")),
      `${kind} idle poses`,
    );
    assert.ok(
      Array.isArray(profile.refreshPoses)
        && profile.refreshPoses.every((pose) =>
          Array.isArray(pose) && pose.every((line) => typeof line === "string")),
      `${kind} refresh poses`,
    );
  }
});

test("Project Catalog temperament catalog exports consistent ids and English-only prompts", () => {
  assert.ok(TEMPERAMENT_PROFILES.length > 0);
  assert.deepEqual(
    ZOO_TEMPERAMENT_IDS,
    TEMPERAMENT_PROFILES.map((profile) => profile.id),
  );
  assert.equal(new Set(ZOO_TEMPERAMENT_IDS).size, ZOO_TEMPERAMENT_IDS.length);

  for (const profile of TEMPERAMENT_PROFILES) {
    assert.equal(TEMPERAMENT_PROFILE_BY_ID.get(profile.id), profile);
    assert.deepEqual(Object.keys(profile.labels), ENGLISH_ONLY_KEYS);
    assert.equal(typeof profile.labels.eng, "string", `${profile.id} English label`);
    assert.ok(profile.labels.eng.trim(), `${profile.id} English label`);
    assert.deepEqual(Object.keys(profile.prompt), ENGLISH_ONLY_KEYS);
    assert.equal(typeof profile.prompt.eng, "string", `${profile.id} English prompt`);
    assert.ok(profile.prompt.eng.trim(), `${profile.id} English prompt`);
    assert.deepEqual(Object.keys(profile.refreshLead), ENGLISH_ONLY_KEYS);
    assert.ok(
      Array.isArray(profile.refreshLead.eng)
        && profile.refreshLead.eng.every((value) => String(value).trim()),
      `${profile.id} English refresh lead`,
    );
    assert.doesNotMatch(JSON.stringify(profile), NON_LATIN_TEXT);
  }
});

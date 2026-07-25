import crypto from "node:crypto";

import {
  CREATURE_PROFILES,
  TEMPERAMENT_PROFILES,
  TEMPERAMENT_PROFILE_BY_ID,
  ZOO_CHARACTER_NAMES,
} from "./creature-catalog.js";
export {
  ZOO_CHARACTER_NAMES,
  ZOO_CREATURE_KINDS,
  ZOO_TEMPERAMENT_IDS,
} from "./creature-catalog.js";

function stableIndex(seed, salt, size) {
  if (!Number.isInteger(size) || size <= 0) {
    return 0;
  }

  const digest = crypto
    .createHash("sha1")
    .update(`${String(seed || "")}:${salt}`)
    .digest();
  return digest[0] % size;
}

function normalizeIdentityText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function getZooCreatureProfile(kind) {
  return CREATURE_PROFILES[kind] || CREATURE_PROFILES.cat;
}

function getZooTemperamentProfile(seed, creatureKind = "cat") {
  return TEMPERAMENT_PROFILES[
    stableIndex(`${creatureKind}:${String(seed || "")}`, "temperament", TEMPERAMENT_PROFILES.length)
  ];
}

function getZooTemperamentProfileById(temperamentId) {
  return TEMPERAMENT_PROFILE_BY_ID.get(normalizeIdentityText(temperamentId)) || null;
}

export function pickZooCharacterName(seed) {
  return ZOO_CHARACTER_NAMES[stableIndex(seed, "pony-name", ZOO_CHARACTER_NAMES.length)];
}

export function getZooPetCharacterName(pet) {
  return normalizeIdentityText(pet?.character_name) || pickZooCharacterName(pet?.pet_id);
}

export function getZooPetTemperamentProfile(pet) {
  return (
    getZooTemperamentProfileById(pet?.temperament_id)
    || getZooTemperamentProfile(pet?.pet_id, pet?.creature_kind)
  );
}

export function getZooCreatureLabel(kind, _language = "eng") {
  const profile = getZooCreatureProfile(kind);
  return profile.labels.eng;
}

export function getZooCreatureVoicePrompt(kind, _language = "eng") {
  const profile = getZooCreatureProfile(kind);
  return profile.persona.eng;
}

export function getZooPetTemperamentLabel(pet, _language = "eng") {
  const profile = getZooPetTemperamentProfile(pet);
  return profile.labels.eng;
}

export function getZooPetTemperamentPrompt(pet, _language = "eng") {
  const profile = getZooPetTemperamentProfile(pet);
  return profile.prompt.eng;
}

function getZooPetTemperamentRefreshLead(
  pet,
  _language = "eng",
  frameIndex = 0,
) {
  const profile = getZooPetTemperamentProfile(pet);
  const variants = profile.refreshLead?.eng || [];
  if (!Array.isArray(variants) || variants.length === 0) {
    return "";
  }

  return variants[Math.abs(Number(frameIndex) || 0) % variants.length];
}

export function getZooPoseLines({
  creatureKind,
  mode = "idle",
  frameIndex = 0,
}) {
  const profile = getZooCreatureProfile(creatureKind);
  const frames = mode === "refresh" ? profile.refreshPoses : profile.idlePoses;
  if (!Array.isArray(frames) || frames.length === 0) {
    return [];
  }

  return frames[Math.abs(Number(frameIndex) || 0) % frames.length];
}

export function getZooPetRefreshStatus({
  pet,
  language = "eng",
  frameIndex = 0,
}) {
  const profile = getZooCreatureProfile(pet?.creature_kind);
  const variants = profile.refreshStatus.eng || [];
  if (!Array.isArray(variants) || variants.length === 0) {
    const fallback = "checking the project";
    const lead = getZooPetTemperamentRefreshLead(pet, language, frameIndex);
    return lead ? `${lead} ${fallback}` : fallback;
  }

  const lead = getZooPetTemperamentRefreshLead(pet, language, frameIndex);
  const base = variants[Math.abs(Number(frameIndex) || 0) % variants.length];
  return lead ? `${lead} ${base}` : base;
}

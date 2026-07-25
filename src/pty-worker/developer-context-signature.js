import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeOptionalText } from "./worker-pool-lifecycle-common.js";

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

async function listWorkspaceSkillEntries(workspaceRootPath) {
  const root = normalizeOptionalText(workspaceRootPath);
  if (!root) {
    return [];
  }

  const skillsRoot = path.join(root, ".teledex", "workflow-skills");
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return [];
    }
    throw error;
  }

  const skillNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const skillEntries = [];
  for (const skillName of skillNames) {
    const skillDir = path.join(skillsRoot, skillName);
    const skillMd = await readOptionalFile(path.join(skillDir, "SKILL.md"));
    const openaiYaml = await readOptionalFile(
      path.join(skillDir, "agents", "openai.yaml"),
    );
    skillEntries.push({
      name: skillName,
      skillMd: skillMd ?? "",
      openaiYaml: openaiYaml ?? "",
    });
  }
  return skillEntries;
}

export async function buildDeveloperContextSignature({
  developerInstructions = null,
  workspaceRootPath = null,
} = {}) {
  const hash = crypto.createHash("sha256");
  hash.update("teledex-developer-context-v1\n");
  hash.update(normalizeOptionalText(developerInstructions) || "");
  hash.update("\n---workflow-skills---\n");
  const skillEntries = await listWorkspaceSkillEntries(workspaceRootPath);
  for (const entry of skillEntries) {
    hash.update(`\n>>> ${entry.name}/SKILL.md\n`);
    hash.update(entry.skillMd);
    hash.update(`\n>>> ${entry.name}/agents/openai.yaml\n`);
    hash.update(entry.openaiYaml);
  }
  return `sha256:${hash.digest("hex")}`;
}

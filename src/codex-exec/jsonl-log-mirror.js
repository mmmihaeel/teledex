import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { appendTextFile, writeTextAtomic } from "../state/file-utils.js";

const INLINE_OBJECTIVE_MAX_BYTES = 320;
const TOOL_OUTPUT_INLINE_MAX_BYTES = 8 * 1024;

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function truncateUtf8(value, maxBytes, { suffix = "... [truncated]" } = {}) {
  const text = String(value ?? "");
  if (getUtf8ByteLength(text) <= maxBytes) {
    return text;
  }
  const suffixBytes = getUtf8ByteLength(suffix);
  const target = Math.max(maxBytes - suffixBytes, 0);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getUtf8ByteLength(text.slice(0, mid)) <= target) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}${suffix}`;
}

function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getGoalObject(event) {
  if (event?.method === "thread/goal/updated" && event.params?.goal) {
    return event.params.goal;
  }
  if (event?.type === "thread.goal.updated" && event.goal) {
    return event.goal;
  }
  return null;
}

function artifactDirectoryForLog(logPath, kind) {
  return path.join(path.dirname(logPath), "artifacts", kind);
}

export async function resetCompactJsonlLogMirrorArtifacts({
  jsonlLogPath = null,
} = {}) {
  const logPath = normalizeOptionalText(jsonlLogPath);
  if (!logPath) {
    return;
  }
  await Promise.all(
    ["goal-objectives", "tool-output"].map((kind) =>
      fs.rm(artifactDirectoryForLog(logPath, kind), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function writeArtifact({
  logPath,
  kind,
  content,
  hash,
  artifacts,
}) {
  const existing = artifacts.get(hash);
  if (existing) {
    return {
      path: existing,
      repeated: true,
    };
  }

  const directory = artifactDirectoryForLog(logPath, kind);
  const filePath = path.join(directory, `${hash}.txt`);
  await writeTextAtomic(filePath, content);
  artifacts.set(hash, filePath);
  return {
    path: filePath,
    repeated: false,
  };
}

async function compactGoalObjectiveLine({
  line,
  logPath,
  objectiveArtifacts,
}) {
  const event = parseJsonLine(line);
  const goal = getGoalObject(event);
  const objective = normalizeOptionalText(goal?.objective);
  if (!objective) {
    return line;
  }

  const objectiveBytes = getUtf8ByteLength(objective);
  if (objectiveBytes <= INLINE_OBJECTIVE_MAX_BYTES) {
    return line;
  }

  const hash = crypto.createHash("sha256").update(objective).digest("hex");
  const artifact = await writeArtifact({
    logPath,
    kind: "goal-objectives",
    content: objective,
    hash,
    artifacts: objectiveArtifacts,
  });
  const preview = artifact.repeated
    ? `[objective unchanged: sha256:${hash.slice(0, 12)} bytes=${objectiveBytes}]`
    : truncateUtf8(objective, INLINE_OBJECTIVE_MAX_BYTES, {
      suffix: "... [objective compacted]",
    });

  goal.objective = preview;
  goal.objective_compacted = {
    schema_version: 1,
    hash,
    bytes: objectiveBytes,
    artifact_path: artifact.path,
    repeated: artifact.repeated,
    preview_bytes: getUtf8ByteLength(preview),
  };
  return JSON.stringify(event);
}

function getCommandOutputRef(event) {
  const legacyItem = event?.item;
  if (
    event?.type
    && ["item.started", "item.updated", "item.completed"].includes(event.type)
    && legacyItem?.type === "command_execution"
  ) {
    return {
      item: legacyItem,
      key: "aggregated_output",
      command: legacyItem.command || null,
    };
  }

  const appServerItem = event?.params?.item;
  if (
    event?.method
    && String(event.method).startsWith("item/")
    && appServerItem?.type === "commandExecution"
  ) {
    return {
      item: appServerItem,
      key: "aggregatedOutput",
      command: appServerItem.command || null,
    };
  }

  return null;
}

function compactToolOutputSummary({
  outputBytes,
  outputLines,
  artifact,
  hash,
  repeated,
  command,
}) {
  const commandLabel = normalizeOptionalText(command) || "command";
  return [
    "[teledex-log-mirror: command output compacted]",
    `command: ${truncateUtf8(commandLabel, 240)}`,
    `original_bytes: ${outputBytes}`,
    `original_lines: ${outputLines}`,
    `artifact: ${artifact}`,
    `sha256: ${hash}`,
    `repeated: ${repeated}`,
  ].join("\n");
}

async function compactCommandOutputLine({
  line,
  logPath,
  outputArtifacts,
}) {
  const event = parseJsonLine(line);
  const ref = getCommandOutputRef(event);
  if (!ref || typeof ref.item?.[ref.key] !== "string") {
    return line;
  }

  const output = ref.item[ref.key];
  const outputBytes = getUtf8ByteLength(output);
  if (outputBytes <= TOOL_OUTPUT_INLINE_MAX_BYTES) {
    return line;
  }

  const hash = crypto.createHash("sha256").update(output).digest("hex");
  const artifact = await writeArtifact({
    logPath,
    kind: "tool-output",
    content: output,
    hash,
    artifacts: outputArtifacts,
  });
  const outputLines = output.split("\n").length - (output.endsWith("\n") ? 1 : 0);

  ref.item[ref.key] = compactToolOutputSummary({
    outputBytes,
    outputLines,
    artifact: artifact.path,
    hash,
    repeated: artifact.repeated,
    command: ref.command,
  });
  ref.item.output_compacted = {
    schema_version: 1,
    hash,
    bytes: outputBytes,
    lines: outputLines,
    artifact_path: artifact.path,
    repeated: artifact.repeated,
    preview_bytes: getUtf8ByteLength(ref.item[ref.key]),
  };
  return JSON.stringify(event);
}

async function compactJsonlMirrorLine({
  line,
  logPath,
  objectiveArtifacts,
  outputArtifacts,
}) {
  const goalCompacted = await compactGoalObjectiveLine({
    line,
    logPath,
    objectiveArtifacts,
  });
  return compactCommandOutputLine({
    line: goalCompacted,
    logPath,
    outputArtifacts,
  });
}

export function createCompactJsonlLogMirror({
  jsonlLogPath = null,
  onWarning = null,
  label = "Codex JSONL",
} = {}) {
  const logPath = normalizeOptionalText(jsonlLogPath);
  if (!logPath) {
    return null;
  }

  const objectiveArtifacts = new Map();
  const outputArtifacts = new Map();
  let writeChain = Promise.resolve();
  let warningEmitted = false;

  const appendLine = (line) => {
    writeChain = writeChain
      .then(async () => {
        const compactedLine = await compactJsonlMirrorLine({
          line: String(line ?? ""),
          logPath,
          objectiveArtifacts,
          outputArtifacts,
        });
        await appendTextFile(logPath, `${compactedLine}\n`);
      })
      .catch((error) => {
        if (!warningEmitted) {
          warningEmitted = true;
          onWarning?.(`Failed to mirror ${label}: ${error.message}`);
        }
      });
  };

  return {
    appendLine,
    appendEvent(event) {
      appendLine(JSON.stringify(event));
    },
    async settle() {
      await writeChain;
    },
  };
}

export const testInternals = {
  compactGoalObjectiveLine,
  getUtf8ByteLength,
  truncateUtf8,
};

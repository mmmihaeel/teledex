import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCUMENT_LANGUAGE = "eng";
const GUIDEBOOK_SOURCE = fileURLToPath(
  new URL("../../../docs/guidebook-eng.md", import.meta.url),
);
const RUNBOOK_SOURCE = fileURLToPath(
  new URL("../../../docs/runbook.md", import.meta.url),
);

export const GUIDEBOOK_RASTERIZE_SCRIPT = fileURLToPath(
  new URL("../../../scripts/rasterize-pdf.py", import.meta.url),
);

const GUIDEBOOK_FILE_NAME = "teledex-guidebook-eng.pdf";
const RUNBOOK_FILE_NAME = "teledex-runbook-eng.pdf";

export const PAGE = {
  size: "A4",
  margins: {
    top: 44,
    bottom: 48,
    left: 46,
    right: 46,
  },
};

export function getNormalizedLanguage() {
  return DOCUMENT_LANGUAGE;
}

export function getGuidebookSourcePath() {
  return GUIDEBOOK_SOURCE;
}

export function getGuidebookFileName() {
  return GUIDEBOOK_FILE_NAME;
}

export function getRunbookSourcePath() {
  return RUNBOOK_SOURCE;
}

export function getRunbookFileName() {
  return RUNBOOK_FILE_NAME;
}

export function resolveGuidebookOutputPath(_language, stateRoot = null) {
  const outputRoot = stateRoot
    ? path.join(stateRoot, "tmp", "guidebook")
    : path.join(os.tmpdir(), "teledex-guidebook");
  return path.join(outputRoot, GUIDEBOOK_FILE_NAME);
}

export function resolveRunbookOutputPath(_language, stateRoot = null) {
  const outputRoot = stateRoot
    ? path.join(stateRoot, "tmp", "runbook")
    : path.join(os.tmpdir(), "teledex-runbook");
  return path.join(outputRoot, RUNBOOK_FILE_NAME);
}

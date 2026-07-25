import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const outRoot = path.resolve(process.argv[2] ?? ".");
const requiredFiles = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".gitignore",
  ".env.example",
  "examples/teledex.env.example",
  "package.json",
  "package-lock.json",
  "Makefile",
  "docs/index.md",
  "docs/install-with-codez.md",
  "docs/config.md",
  "docs/architecture.md",
  "docs/telegram-surface.md",
  "docs/state-contract.md",
  "docs/deployment.md",
  "docs/runbook.md",
  "docs/security.md",
  "docs/testing.md",
  "docs/troubleshooting.md",
  "docs/compatibility.md",
  "docs/stack.md",
  "docs/guidebook-eng.md",
  "docs/zoo-concept.md",
  "src/cli/run.js",
  "src/app-server-v2/app-server-v2-runner.js",
  "src/telegram/bot-api-client.js",
  "src/session-manager/session-service.js",
  "src/pty-worker/worker-pool.js",
  "src/config/runtime-config.js",
  "scripts/check-syntax.mjs",
  "scripts/smoke-config.mjs",
  "scripts/run-node-tests.mjs",
  "test/app-server-v2-runner.test.js",
  "test/worker-pool.test.js",
  "test-support/tmp.js",
];
const requiredDirs = [
  "src/cli",
  "src/app-server-v2",
  "src/codex-exec",
  "src/codex-runtime",
  "src/telegram",
  "src/session-manager",
  "src/pty-worker",
  "src/config",
  "src/runtime",
  "src/hosts",
  "src/transport",
  "src/emergency",
  "src/deepseek-runtime",
  "src/workspace",
  "src/state",
  "src/live-user",
  "src/rollout",
  "src/i18n",
  "src/zoo",
  "test",
  "test-support",
];
const requiredHelpAssets = [
  "assets/help/telegram-help-card-eng-1.png",
  "assets/help/telegram-help-card-eng-2.png",
];
const retiredProjectionFiles = [
  ".public-projection/exclusions.tsv",
  ".public-projection/manifest.json",
  ".public-projection/sanitizer-manifest.tsv",
];
const legacyIdentityPattern = new RegExp(
  `\\b(?:${
    [
      ["Krab", "lante"].join(""),
      ["Crab", "Lant"].join(""),
      ["G", "626"].join(""),
      ["blo", "ob"].join(""),
    ].join("|")
  })\\b`,
  "iu",
);
const nonEnglishLocaleMarkers = [
  ["r", "ussian"].join(""),
  ["r", "us"].join(""),
  ["r", "u"].join(""),
];
const nonEnglishLocaleTextPattern = new RegExp(
  `(?:^|[^A-Za-z0-9])(?:${nonEnglishLocaleMarkers.join("|")})(?=$|[^A-Za-z0-9])`,
  "iu",
);
const nonEnglishLocalePathPattern = new RegExp(
  `(?:^|[/_.-])(?:${nonEnglishLocaleMarkers.join("|")})(?=$|[/_.-])`,
  "iu",
);
const forbiddenPathParts = [
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  "cache",
  ".cache",
  "public",
  "public-dist",
  "logs",
  "state",
  "sessions",
  "indexes",
  "incoming",
  "emergency",
  "settings",
];

function fail(message, details = []) {
  console.error("public projection audit failed: " + message);
  for (const detail of details.slice(0, 80)) {
    console.error(detail);
  }
  process.exit(1);
}

async function exists(rel) {
  try {
    await fs.access(path.join(outRoot, rel));
    return true;
  } catch {
    return false;
  }
}

async function walk(root, prefix = "") {
  const entries = (await fs.readdir(path.join(root, prefix), { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const paths = [];
  for (const entry of entries) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        continue;
      }
      if (entry.name === "node_modules") {
        paths.push(rel + "/");
        continue;
      }
      paths.push(rel + "/");
      paths.push(...await walk(root, rel));
    } else if (entry.isFile()) {
      paths.push(rel);
    }
  }
  return paths;
}

function isText(buffer) {
  if (buffer.includes(0)) {
    return false;
  }
  return !buffer.toString("utf8").includes("\uFFFD");
}

function readPngDimensions(buffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function normalizeSecretValue(rawValue) {
  return String(rawValue ?? "")
    .trim()
    .replace(/\\[rn].*$/u, "")
    .replace(/^["'(]+|["',);]+$/g, "");
}

function isAllowedPlaceholderSecretValue(value) {
  const normalized = normalizeSecretValue(value).toLowerCase();
  return normalized === ""
    || normalized === "replace-me"
    || normalized === "secret"
    || normalized === "secret-token"
    || normalized === "secret-value"
    || normalized === "must-not-leak"
    || normalized === "must-not-load"
    || normalized === "legacy"
    || normalized === "repo"
    || normalized === "state"
    || normalized === "placeholder"
    || normalized === "redacted"
    || normalized === "example"
    || normalized === "test"
    || normalized === "test-token"
    || normalized === "dummy"
    || normalized.startsWith("dummy-")
    || normalized.startsWith("fake-")
    || normalized.startsWith("example-")
    || normalized.endsWith("-env")
    || normalized.endsWith("-secret");
}

function containsNonEnglishScript(text) {
  return Array.from(String(text || "")).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      (codePoint >= 0x0400 && codePoint <= 0x052f)
      || (codePoint >= 0x2de0 && codePoint <= 0x2dff)
      || (codePoint >= 0xa640 && codePoint <= 0xa69f)
    );
  });
}

function scanText(rel, text) {
  const hits = [];
  const patterns = [
    [legacyIdentityPattern, "legacy repository identity"],
    [nonEnglishLocaleTextPattern, "non-English locale marker"],
    [/\\u(?:04|05|2d|a6)[0-9a-f]{2}/iu, "non-English Unicode escape"],
    [/\/home\/(?!example\b|local\b|workera\b|workerb\b|workerc\b|workerz\b)[A-Za-z0-9._-]+(?:\/|$)/u, "non-generic home path"],
    [/[A-Za-z]:[\\/]+Users[\\/]+(?!(?:example|alice|Friend)(?:[\\/]|(?=$|[\s"']))|Public(?:[\\/]|(?=$|[\s"']))|Default(?:[\\/]|(?=$|[\s"'])))[^\\/\s"']+/u, "non-generic Windows user path"],
    [/\/[a-z]\/Users\/(?!example\/)[^/\s]+/u, "non-generic MSYS user path"],
    [/(^|[\s"'=])\/workspace\/(?!workspace\b|project\b|example\b|examples\b|work\b)[A-Za-z0-9._-]+(?:\/|$)/u, "non-generic container workspace path"],
    [/\.env(?:\.[A-Za-z0-9_-]+)?=/u, "env filename used as assignment"],
    [/-100[0-9]{8,}\b/u, "telegram-shaped chat id"],
    [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/u, "telegram bot token-shaped value"],
    [/-----BEGIN (?:RSA |DSA |EC |OPENSSH |)?PRIVATE KEY-----/u, "private key block"],
  ];
  const lines = text.split(/\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmedLine = line.trim();
    if (containsNonEnglishScript(line)) {
      hits.push(rel + ":" + (index + 1) + ": non-English public text: " + line.slice(0, 220));
    }
    if (
      rel === ".gitignore"
      && [
        ["AG", "ENTS.md"].join(""),
        ["AG", "ENTS.local.md"].join(""),
        [".ag", "ents/"].join(""),
        ["at", "las.toml"].join(""),
      ].includes(trimmedLine)
    ) {
      continue;
    }
    for (const [pattern, label] of patterns) {
      if (pattern.test(line)) {
        hits.push(rel + ":" + (index + 1) + ": " + label + ": " + line.slice(0, 220));
      }
    }
    const secretMatch = line.match(/\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)=([^\s#]+)/u);
    if (secretMatch && !isAllowedPlaceholderSecretValue(secretMatch[1])) {
      hits.push(rel + ":" + (index + 1) + ": non-placeholder secret-like env value: " + line.slice(0, 220));
    }
  }
  return hits;
}

async function main() {
  if (!await exists(".")) {
    fail("missing output directory " + outRoot);
  }
  const missing = [];
  for (const rel of requiredFiles) {
    if (!await exists(rel)) {
      missing.push(rel);
    }
  }
  for (const rel of requiredDirs) {
    const stat = await fs.stat(path.join(outRoot, rel)).catch(() => null);
    if (!stat?.isDirectory()) {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    fail("required full-source files/dirs are missing", missing);
  }
  const retiredFilesPresent = [];
  for (const rel of retiredProjectionFiles) {
    if (await exists(rel)) {
      retiredFilesPresent.push(rel);
    }
  }
  if (retiredFilesPresent.length > 0) {
    fail("retired projection metadata is still present", retiredFilesPresent);
  }
  const paths = await walk(outRoot);
  const files = paths.filter((rel) => !rel.endsWith("/"));
  const badPaths = paths.filter((rel) => {
    const normalizedRel = rel.replace(/\/$/u, "");
    const parts = normalizedRel.split("/");
    return forbiddenPathParts.some((part) => {
      if (["logs", "state", "sessions", "indexes", "incoming", "emergency", "settings", "cache", ".cache"].includes(part)) {
        return parts[0] === part;
      }
      return parts.includes(part) || normalizedRel === part;
    });
  });
  if (badPaths.length > 0) {
    fail("forbidden path present", badPaths);
  }
  const nonEnglishPaths = paths.filter((rel) =>
    nonEnglishLocalePathPattern.test(rel)
  );
  if (nonEnglishPaths.length > 0) {
    fail("non-English locale marker found in public path", nonEnglishPaths);
  }
  const expectedFileList = (await fs.readFile(path.join(outRoot, ".public-projection", "expected-files.txt"), "utf8"))
    .split(/\n/u)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const actualFileList = [...files].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(expectedFileList) !== JSON.stringify(actualFileList)) {
    const expectedSet = new Set(expectedFileList);
    const actualSet = new Set(actualFileList);
    fail("expected-files manifest does not match generated public tree", [
      ...actualFileList.filter((rel) => !expectedSet.has(rel)).slice(0, 40).map((rel) => "unexpected actual file: " + rel),
      ...expectedFileList.filter((rel) => !actualSet.has(rel)).slice(0, 40).map((rel) => "missing actual file: " + rel),
    ]);
  }
  const sourceFiles = files.filter((rel) => rel.startsWith("src/") && rel.endsWith(".js"));
  const testFiles = files.filter((rel) => rel.startsWith("test/") && rel.endsWith(".js"));
  const supportFiles = files.filter((rel) => rel.startsWith("test-support/") && rel.endsWith(".js"));
  if (sourceFiles.length < 250 || testFiles.length < 120 || supportFiles.length < 6) {
    fail("projection is too small", [
      "src js files: " + sourceFiles.length,
      "test js files: " + testFiles.length,
      "test-support js files: " + supportFiles.length,
    ]);
  }
  const badHelpAssets = [];
  const actualHelpAssets = (await fs.readdir(path.join(outRoot, "assets", "help"), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile())
    .map((entry) => `assets/help/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
  const expectedHelpAssets = [...requiredHelpAssets]
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualHelpAssets) !== JSON.stringify(expectedHelpAssets)) {
    fail("assets/help must contain exactly two English PNG cards", [
      ...actualHelpAssets
        .filter((rel) => !expectedHelpAssets.includes(rel))
        .map((rel) => `unexpected help asset: ${rel}`),
      ...expectedHelpAssets
        .filter((rel) => !actualHelpAssets.includes(rel))
        .map((rel) => `missing help asset: ${rel}`),
    ]);
  }
  for (const rel of requiredHelpAssets) {
    const buffer = await fs.readFile(path.join(outRoot, rel)).catch(() => null);
    const dimensions = buffer ? readPngDimensions(buffer) : null;
    if (!buffer || !dimensions || buffer.length < 10000 || dimensions.width < 800 || dimensions.height < 800) {
      badHelpAssets.push(rel + ": " + (
        dimensions
          ? dimensions.width + "x" + dimensions.height + ", " + buffer.length + " bytes"
          : "missing or invalid PNG"
      ));
    }
  }
  if (badHelpAssets.length > 0) {
    fail("help-card assets must be real public PNG cards, not placeholders", badHelpAssets);
  }
  const hits = [];
  for (const rel of files) {
    const buffer = await fs.readFile(path.join(outRoot, rel));
    if (isText(buffer)) {
      hits.push(...scanText(rel, buffer.toString("utf8")));
    }
  }
  if (hits.length > 0) {
    fail("private or unsafe marker found", hits);
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(outRoot, "package.json"), "utf8"));
  if (packageJson.private) {
    fail("package.json must not be private in public projection");
  }
  const scripts = packageJson.scripts ?? {};
  if (scripts["test:live"] && !scripts["test:live"].includes("app-server-v2")) {
    fail("public test:live must use app-server-v2");
  }
  if (!scripts["audit:public"]?.includes("--no-export")) {
    fail("public audit:public must audit the current public tree");
  }
  if (scripts["export:public"]) {
    fail("public package must not expose the private publication exporter");
  }
  const binTarget = packageJson.bin?.teledex;
  if (binTarget) {
    const binText = await fs.readFile(path.join(outRoot, binTarget), "utf8").catch(() => null);
    if (!binText?.startsWith("#!/usr/bin/env node")) {
      fail("public package bin target must be directly executable with a Node shebang", [binTarget]);
    }
  }
  const commandSurface = [
    await fs.readFile(path.join(outRoot, "package.json"), "utf8"),
    await fs.readFile(path.join(outRoot, "Makefile"), "utf8"),
  ];
  for (const rel of files.filter((file) => file.startsWith("scripts/windows/") && file.endsWith(".cmd"))) {
    commandSurface.push(await fs.readFile(path.join(outRoot, rel), "utf8"));
  }
  const legacyCommandHit = commandSurface.join("\n").match(/--app-server(?!-v2)\b/u);
  if (legacyCommandHit) {
    fail("public command surface must not expose legacy app-server backend", [legacyCommandHit[0]]);
  }
  const envExamples = [
    ".env.example",
    "examples/teledex.env.example",
  ];
  for (const rel of envExamples) {
    const envExample = await fs.readFile(path.join(outRoot, rel), "utf8");
    if (!/TELEDEX_BACKEND=app-server-v2/u.test(envExample) || !/TELEDEX_ENABLE_APP_SERVER_V2=1/u.test(envExample)) {
      fail("public env example must select the supported Codez App Server v2 backend", [rel]);
    }
    const removedNoOpKeys = [
      "CODEZ_APP_SERVER_URL",
      "TELEDEX_MODEL",
      "TELEDEX_REASONING_EFFORT",
      "TELEDEX_UI_LANGUAGE",
    ].filter((key) => new RegExp(`^${key}=`, "mu").test(envExample));
    if (removedNoOpKeys.length > 0) {
      fail("public env example contains unsupported settings", [
        `${rel}: ${removedNoOpKeys.join(", ")}`,
      ]);
    }
  }
  console.log("public projection audit OK: " + outRoot);
  console.log("source files: " + sourceFiles.length + "; test files: " + testFiles.length + "; test-support files: " + supportFiles.length);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

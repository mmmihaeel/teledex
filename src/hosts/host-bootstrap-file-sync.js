import fs from "node:fs/promises";
import path from "node:path";

import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "./host-command-runner.js";

export async function assertReadableFile(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing readable ${label}: ${filePath}`);
  }
}

export async function assertReadableDirectory(directoryPath, label) {
  try {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(`Missing readable ${label}: ${directoryPath}`);
  }
}

export async function copyLocalFileToHost({
  connectTimeoutSecs,
  copyLinks = false,
  currentHostId,
  execFileImpl,
  host,
  localPath,
  remotePath,
  chmod = null,
}) {
  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remotePath)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'mkdir -p "$(dirname "$target")"',
      'printf "%s\\n" "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });
  const resolvedRemotePath = stdout.trim().split("\n").at(-1) || remotePath;
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      ...(copyLinks ? ["--copy-links"] : []),
      ...(chmod ? [`--chmod=${chmod}`] : []),
      normalizeRsyncLocalPath(localPath),
      buildRsyncRemotePath(host.ssh_target, resolvedRemotePath),
    ],
    {
      execFileImpl,
      timeoutMs: 30_000,
    },
  );
}

export async function removeRemoteFile({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  remotePath,
}) {
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remotePath)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'rm -f "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });
}

export async function syncLocalDirectoryToHost({
  connectTimeoutSecs,
  currentHostId,
  deleteExtra = false,
  deleteExcluded = false,
  execFileImpl,
  host,
  localPath,
  remotePath,
  exclude = [],
  protect = [],
}) {
  const { stdout } = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remotePath)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'mkdir -p "$target"',
      'printf "%s\\n" "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });
  const resolvedRemotePath = stdout.trim().split("\n").at(-1) || remotePath;

  const sourceRoot = localPath.endsWith(path.sep) ? localPath : `${localPath}${path.sep}`;
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      ...(deleteExtra ? ["--delete"] : []),
      ...protect.flatMap((pattern) => ["--filter", `P ${pattern}`]),
      ...(deleteExtra && deleteExcluded ? ["--delete-excluded"] : []),
      ...exclude.flatMap((pattern) => ["--exclude", pattern]),
      normalizeRsyncLocalPath(sourceRoot),
      buildRsyncRemotePath(host.ssh_target, `${resolvedRemotePath}/`),
    ],
    {
      execFileImpl,
      timeoutMs: 60_000,
    },
  );
}

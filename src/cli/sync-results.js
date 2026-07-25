export function syncResultsHaveFailures(results) {
  return Array.isArray(results) && results.some((result) => result?.status === "failed");
}

export function setExitCodeForSyncResults(results, processLike = process) {
  if (syncResultsHaveFailures(results)) {
    processLike.exitCode = 1;
  }
}

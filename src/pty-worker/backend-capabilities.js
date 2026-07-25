function normalizeWorkerBackend(value) {
  return String(value || "").trim().toLowerCase();
}

export function isLegacyAppServerBackend(value) {
  const backend = normalizeWorkerBackend(value);
  return backend === "app-server";
}

export function supportsCodexRolloutPathContinuity(value) {
  const backend = normalizeWorkerBackend(value);
  return isLegacyAppServerBackend(backend) || backend === "app-server-v2";
}

export function supportsManagedGoalStart(value) {
  return normalizeWorkerBackend(value) === "app-server-v2";
}

import {
  loadAvailableCodexModels,
  loadVisibleCodexModels,
} from "./codex-runtime-settings.js";
import {
  expandHomePath,
  getCodexSpaceRootFromRegistryPath,
  getHostModelsCacheMirrorPath,
  getModelsCachePathForConfigPath,
} from "../hosts/codex-model-catalog.js";

const MISSING_REMOTE_MODELS_CACHE_PATH =
  "/__teledex_missing_remote_models_cache__/models_cache.json";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function buildCatalogPaths(configPath, modelsCachePath = undefined) {
  const normalizedConfigPath = normalizeOptionalText(configPath) || undefined;
  return {
    configPath: normalizedConfigPath,
    modelsCachePath:
      normalizeOptionalText(modelsCachePath)
      || getModelsCachePathForConfigPath(normalizedConfigPath)
      || undefined,
  };
}

export async function resolveCodexCatalogPathsForSession({
  session = null,
  defaultConfigPath = null,
  hostRegistryService = null,
} = {}) {
  const normalizedDefaultConfigPath = expandHomePath(defaultConfigPath) || defaultConfigPath;
  const hostId = normalizeOptionalText(session?.execution_host_id);
  if (!hostId || typeof hostRegistryService?.getHost !== "function") {
    return buildCatalogPaths(normalizedDefaultConfigPath);
  }

  try {
    const host = await hostRegistryService.getHost(hostId);
    const hostConfigPath = normalizeOptionalText(host?.codex_config_path);
    if (!hostConfigPath) {
      return buildCatalogPaths(normalizedDefaultConfigPath);
    }

    const currentHostId = normalizeOptionalText(hostRegistryService?.currentHostId);
    if (hostId === currentHostId) {
      const expandedConfigPath = expandHomePath(hostConfigPath) || normalizedDefaultConfigPath;
      return buildCatalogPaths(expandedConfigPath);
    }

    const codexSpaceRoot = getCodexSpaceRootFromRegistryPath(
      hostRegistryService?.registryPath,
    );
    const mirrorPath = getHostModelsCacheMirrorPath(codexSpaceRoot, hostId);
    return buildCatalogPaths(
      normalizedDefaultConfigPath,
      mirrorPath || MISSING_REMOTE_MODELS_CACHE_PATH,
    );
  } catch {
    return buildCatalogPaths(normalizedDefaultConfigPath);
  }
}

export async function loadAvailableCodexModelsForSession({
  session = null,
  defaultConfigPath = null,
  hostRegistryService = null,
} = {}) {
  const { configPath, modelsCachePath } = await resolveCodexCatalogPathsForSession({
    session,
    defaultConfigPath,
    hostRegistryService,
  });
  return loadAvailableCodexModels({ configPath, modelsCachePath });
}

export async function loadVisibleCodexModelsForSession({
  session = null,
  defaultConfigPath = null,
  hostRegistryService = null,
} = {}) {
  const { configPath, modelsCachePath } = await resolveCodexCatalogPathsForSession({
    session,
    defaultConfigPath,
    hostRegistryService,
  });
  return loadVisibleCodexModels({ configPath, modelsCachePath });
}

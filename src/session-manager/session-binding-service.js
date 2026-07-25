import { markSessionSeen } from "../runtime/service-state.js";
import { cloneJson } from "../state/file-utils.js";
import { appendTopicHostSuffix, getHostRecordId } from "../hosts/topic-host.js";
import {
  normalizeDeepSeekModel,
  normalizeOpenRouterModel,
  normalizeSessionRuntimeProvider,
  SESSION_PROVIDER_CODEX,
  SESSION_PROVIDER_DEEPSEEK,
  SESSION_PROVIDER_OPENROUTER,
} from "./codex-runtime-profiles.js";
import { createWorkspaceDiffArtifact } from "../workspace/diff-artifact.js";
import { resolveWorkspaceBinding } from "../workspace/binding-resolver.js";
import { getSessionKey, getTopicIdFromMessage } from "./session-key.js";
import {
  extractForumTopicIconCustomEmojiIds,
  pickRandomForumTopicIconCustomEmojiId,
} from "./forum-topic-icons.js";

function buildGeneratedTopicName() {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `Codex ${timestamp} UTC`;
}

function normalizeTopicName(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return buildGeneratedTopicName();
  }

  return trimmed.slice(0, 128);
}

function buildFallbackExecutionHost(config = {}) {
  const currentHostId = config?.currentHostId || "local";
  return {
    ok: true,
    hostId: currentHostId,
    hostLabel: currentHostId,
    lastReadyAt: new Date().toISOString(),
    failureReason: null,
  };
}

function buildExecutionHostUnavailableError(executionHost = {}) {
  const hostId = String(executionHost.hostId || "unknown").trim() || "unknown";
  const hostLabel = String(executionHost.hostLabel || hostId).trim() || hostId;
  const error = new Error(`Execution host unavailable: ${hostLabel}`);
  error.code = "EXECUTION_HOST_UNAVAILABLE";
  error.hostId = hostId;
  error.hostLabel = hostLabel;
  error.failureReason = executionHost.failureReason || "host-unavailable";
  return error;
}

function buildRuntimeSelectionError(message, details = {}) {
  const error = new Error(message);
  error.code = "RUNTIME_SELECTION_INVALID";
  Object.assign(error, details);
  return error;
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function isDeepSeekHostAllowed(config, hostId) {
  const allowedHostIds = Array.isArray(config?.deepSeekRuntimeHostIds)
    ? config.deepSeekRuntimeHostIds
      .map((entry) => normalizeOptionalText(entry)?.toLowerCase())
      .filter(Boolean)
    : [];
  if (allowedHostIds.length === 0) {
    return true;
  }
  return allowedHostIds.includes(normalizeOptionalText(hostId)?.toLowerCase());
}

function isOpenRouterHostAllowed(config, hostId) {
  const allowedHostIds = Array.isArray(config?.openRouterRuntimeHostIds)
    ? config.openRouterRuntimeHostIds
      .map((entry) => normalizeOptionalText(entry)?.toLowerCase())
      .filter(Boolean)
    : [];
  if (allowedHostIds.length === 0) {
    return true;
  }
  return allowedHostIds.includes(normalizeOptionalText(hostId)?.toLowerCase());
}

export class SessionBindingService {
  constructor({
    sessionStore,
    config,
    runtimeObserver = null,
    hostRegistryService = null,
    forumTopicIconRandom = Math.random,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.runtimeObserver = runtimeObserver;
    this.hostRegistryService = hostRegistryService;
    this.defaultBindingPromise = null;
    this.forumTopicIconCustomEmojiIdsPromise = null;
    this.forumTopicIconRandom =
      typeof forumTopicIconRandom === "function" ? forumTopicIconRandom : Math.random;
  }

  async getDefaultBinding() {
    if (!this.defaultBindingPromise) {
      this.defaultBindingPromise = resolveWorkspaceBinding({
        workspaceRootPath: this.config.workspaceRootPath,
        requestedPath: this.config.defaultSessionBindingPath,
      }).catch((error) => {
        this.defaultBindingPromise = null;
        throw error;
      });
    }

    return this.defaultBindingPromise;
  }

  async resolveBindingPath(requestedPath) {
    return resolveWorkspaceBinding({
      workspaceRootPath: this.config.workspaceRootPath,
      requestedPath,
    });
  }

  async resolveTopicCreationHost(executionHostId = null) {
    return typeof this.hostRegistryService?.resolveTopicCreationHost === "function"
      ? this.hostRegistryService.resolveTopicCreationHost(executionHostId)
      : buildFallbackExecutionHost(this.config);
  }

  async listTopicCreationHosts() {
    if (typeof this.hostRegistryService?.listTopicCreationHosts === "function") {
      return this.hostRegistryService.listTopicCreationHosts();
    }

    return [buildFallbackExecutionHost(this.config)];
  }

  async resolveSessionExecution(session) {
    return typeof this.hostRegistryService?.resolveSessionExecution === "function"
      ? this.hostRegistryService.resolveSessionExecution(session)
      : buildFallbackExecutionHost(this.config);
  }

  async listKnownExecutionHostIds() {
    if (typeof this.hostRegistryService?.listHosts === "function") {
      const hosts = await this.hostRegistryService.listHosts();
      return [...new Set(
        hosts
          .map((host) => getHostRecordId(host))
          .filter(Boolean),
      )];
    }

    const currentHostId = String(this.config?.currentHostId ?? "").trim().toLowerCase();
    return currentHostId ? [currentHostId] : [];
  }

  async listForumTopicIconCustomEmojiIds(api) {
    if (typeof api?.getForumTopicIconStickers !== "function") {
      return [];
    }

    if (!this.forumTopicIconCustomEmojiIdsPromise) {
      this.forumTopicIconCustomEmojiIdsPromise = api.getForumTopicIconStickers()
        .then((stickers) => extractForumTopicIconCustomEmojiIds(stickers))
        .catch(async (error) => {
          this.forumTopicIconCustomEmojiIdsPromise = null;
          await this.runtimeObserver?.appendEvent?.("forum_topic_icon.lookup_failed", {
            error: error?.message || String(error),
          }).catch(() => {});
          return [];
        });
    }

    return this.forumTopicIconCustomEmojiIdsPromise;
  }

  async resolveRandomForumTopicIconCustomEmojiId(api) {
    const customEmojiIds = await this.listForumTopicIconCustomEmojiIds(api);
    return pickRandomForumTopicIconCustomEmojiId(customEmojiIds, {
      random: this.forumTopicIconRandom,
    });
  }

  async ensureSessionForMessage(message) {
    return this.ensureSessionForMessageInternal(message, { reactivate: false });
  }

  async ensureRunnableSessionForMessage(message) {
    return this.ensureSessionForMessageInternal(message, { reactivate: true });
  }

  async ensureSessionForMessageInternal(message, { reactivate }) {
    const topicId = getTopicIdFromMessage(message);
    if (!topicId) {
      return null;
    }

    const existingSession = await this.sessionStore.load(message.chat.id, topicId);
    const workspaceBinding = await this.getDefaultBinding();
    if (!existingSession) {
      return this.sessionStore.ensure({
        chatId: message.chat.id,
        topicId,
        workspaceBinding,
        createdVia: "topic/implicit-attach",
        executionHostId: null,
        executionHostLabel: null,
        executionHostBoundAt: null,
        executionHostLastReadyAt: null,
        executionHostLastFailure: "binding-missing",
        reactivate: false,
      });
    }

    const shouldBackfillExecutionHost =
      !existingSession.execution_host_id
      && existingSession.created_via !== "topic/implicit-attach";
    const executionHost = existingSession.execution_host_id
      ? await this.resolveTopicCreationHost(existingSession.execution_host_id)
      : shouldBackfillExecutionHost
        ? await this.resolveTopicCreationHost()
        : null;
    return this.sessionStore.ensure({
      chatId: message.chat.id,
      topicId,
      workspaceBinding,
      createdVia: reactivate ? "topic/reactivate" : "topic/implicit-attach",
      executionHostId: executionHost?.ok ? executionHost.hostId : null,
      executionHostLabel: executionHost?.ok ? executionHost.hostLabel : null,
      executionHostBoundAt: executionHost?.ok ? new Date().toISOString() : null,
      executionHostLastReadyAt:
        executionHost?.ok ? executionHost.lastReadyAt ?? null : null,
      executionHostLastFailure:
        executionHost?.ok ? null : executionHost?.failureReason ?? null,
      reactivate,
    });
  }

  async createTopicSession({
    api,
    executionHostId = null,
    message,
    runtimeModel = null,
    runtimeProvider = null,
    runtimeProfileId = null,
    title,
    uiLanguage = null,
    workspaceBinding,
    inheritedFromSessionKey,
  }) {
    const executionHost = await this.resolveTopicCreationHost(executionHostId);
    if (!executionHost?.ok) {
      throw buildExecutionHostUnavailableError(executionHost);
    }
    const requestedRuntimeProvider = normalizeOptionalText(runtimeProvider);
    const requestedRuntimeModel = normalizeOptionalText(runtimeModel);
    const requestedRuntimeProfileId = normalizeOptionalText(runtimeProfileId);
    const normalizedRuntimeProvider = requestedRuntimeProvider
      ? normalizeSessionRuntimeProvider(requestedRuntimeProvider)
      : requestedRuntimeModel
        ? SESSION_PROVIDER_DEEPSEEK
        : requestedRuntimeProfileId
          ? null
          : SESSION_PROVIDER_CODEX;
    if (!normalizedRuntimeProvider) {
      if (requestedRuntimeProvider) {
        throw buildRuntimeSelectionError(
          `Unsupported runtime provider: ${runtimeProvider}`,
          {
            reason: "unsupported-runtime-provider",
            runtimeProvider,
          },
        );
      }
    }
    if (normalizedRuntimeProvider === SESSION_PROVIDER_CODEX && requestedRuntimeModel) {
      throw buildRuntimeSelectionError(
        `Codex runtime does not accept runtime model selector: ${runtimeModel}`,
        {
          reason: "codex-model-selector",
          runtimeModel,
        },
      );
    }
    if (normalizedRuntimeProvider === SESSION_PROVIDER_DEEPSEEK && requestedRuntimeProfileId) {
      throw buildRuntimeSelectionError(
        "DeepSeek provider uses model=flash|pro, not profile=...",
        {
          reason: "deepseek-profile-conflict",
          runtimeProfileId,
        },
      );
    }
    if (
      normalizedRuntimeProvider === SESSION_PROVIDER_DEEPSEEK
      && !isDeepSeekHostAllowed(this.config, executionHost.hostId)
    ) {
      throw buildRuntimeSelectionError(
        `DeepSeek runtime is not configured for host: ${executionHost.hostId}`,
        {
          reason: "deepseek-host-not-configured",
          executionHostId: executionHost.hostId,
        },
      );
    }
    if (normalizedRuntimeProvider === SESSION_PROVIDER_OPENROUTER && requestedRuntimeProfileId) {
      throw buildRuntimeSelectionError(
        "OpenRouter provider uses model=<provider/model>, not profile=...",
        {
          reason: "openrouter-profile-conflict",
          runtimeProfileId,
        },
      );
    }
    if (
      normalizedRuntimeProvider === SESSION_PROVIDER_OPENROUTER
      && !isOpenRouterHostAllowed(this.config, executionHost.hostId)
    ) {
      throw buildRuntimeSelectionError(
        `OpenRouter runtime is not configured for host: ${executionHost.hostId}`,
        {
          reason: "openrouter-host-not-configured",
          executionHostId: executionHost.hostId,
        },
      );
    }
    const normalizedRuntimeModel =
      normalizedRuntimeProvider === SESSION_PROVIDER_DEEPSEEK
        ? normalizeDeepSeekModel(runtimeModel)
        : normalizedRuntimeProvider === SESSION_PROVIDER_OPENROUTER
          ? normalizeOpenRouterModel(runtimeModel)
        : null;
    if (normalizedRuntimeProvider === SESSION_PROVIDER_DEEPSEEK && !normalizedRuntimeModel) {
      throw buildRuntimeSelectionError(`Unsupported DeepSeek model: ${runtimeModel}`, {
        reason: "unsupported-deepseek-model",
        runtimeModel,
      });
    }
    if (normalizedRuntimeProvider === SESSION_PROVIDER_OPENROUTER && !normalizedRuntimeModel) {
      throw buildRuntimeSelectionError(
        `Unsupported OpenRouter model: ${runtimeModel}. Use an OpenRouter model id like provider/model.`,
        {
          reason: "unsupported-openrouter-model",
          runtimeModel,
        },
      );
    }
    const knownHostIds = await this.listKnownExecutionHostIds();
    const topicName = appendTopicHostSuffix(
      normalizeTopicName(title),
      executionHost.hostId,
      128,
      knownHostIds,
    );
    const createForumTopicPayload = {
      chat_id: message.chat.id,
      name: topicName,
    };
    const iconCustomEmojiId = await this.resolveRandomForumTopicIconCustomEmojiId(api);
    if (iconCustomEmojiId) {
      createForumTopicPayload.icon_custom_emoji_id = iconCustomEmojiId;
    }
    const forumTopic = await api.createForumTopic(createForumTopicPayload);
    const resolvedBinding = workspaceBinding || (await this.getDefaultBinding());
    const session = await this.sessionStore.ensure({
      chatId: message.chat.id,
      topicId: forumTopic.message_thread_id,
      topicName: forumTopic.name,
      uiLanguage,
      workspaceBinding: resolvedBinding,
      createdVia: "command/new",
      inheritedFromSessionKey,
      executionHostId: executionHost.hostId,
      executionHostLabel: executionHost.hostLabel,
      executionHostBoundAt: new Date().toISOString(),
      executionHostLastReadyAt: executionHost.lastReadyAt ?? null,
      executionHostLastFailure: null,
      runtimeModel: normalizedRuntimeModel,
      runtimeProvider: normalizedRuntimeProvider,
      runtimeProfileId,
    });

    return {
      forumTopic,
      session,
    };
  }

  async resolveInheritedBinding(message) {
    const currentSession = await this.ensureSessionForMessage(message);
    if (!currentSession) {
      return {
        binding: cloneJson(await this.getDefaultBinding()),
        inheritedFromSessionKey: null,
      };
    }

    return {
      binding: cloneJson(currentSession.workspace_binding),
      inheritedFromSessionKey: currentSession.session_key,
      inheritedFromSession: currentSession,
    };
  }

  async recordHandledSession(serviceState, session, commandName) {
    const updated = await this.sessionStore.touchCommand(session, commandName);
    markSessionSeen(serviceState, updated.session_key);
    return updated;
  }

  async createDiffArtifact(session) {
    return createWorkspaceDiffArtifact({
      session,
      sessionStore: this.sessionStore,
      config: this.config,
      hostRegistryService: this.hostRegistryService,
    });
  }

  getSessionKeyForMessage(message) {
    const topicId = getTopicIdFromMessage(message);
    if (!topicId) {
      return null;
    }

    return getSessionKey(message.chat.id, topicId);
  }
}

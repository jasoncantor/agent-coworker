import path from "node:path";

import {
  CONVERSATION_SEARCH_MODEL_KEYS,
  CONVERSATION_SEARCH_MODEL_SPECS,
  ConversationSearchCancelledError,
  type ConversationSearchAvailability,
  type ConversationSearchDownloadStatus,
  type ConversationSearchIndexStatus,
  type ConversationSearchMode,
  type ConversationSearchResponse,
  type ConversationSearchServiceListener,
  type ConversationSearchStatusPayload,
} from "../../src/server/conversationSearch";
import { SessionDb, type PersistedSessionRecord } from "../../src/server/sessionDb";

export function coworkPaths(homeDir: string) {
  const rootDir = path.join(homeDir, ".cowork");
  return {
    rootDir,
    sessionsDir: path.join(rootDir, "sessions"),
  };
}

export async function persistRootSession(
  homeDir: string,
  opts: {
    sessionId: string;
    title: string;
    workingDirectory: string;
    messages: PersistedSessionRecord["messages"];
    createdAt?: string;
    updatedAt?: string;
  },
): Promise<void> {
  const paths = coworkPaths(homeDir);
  const db = await SessionDb.create({ paths });
  try {
    const createdAt = opts.createdAt ?? opts.updatedAt ?? new Date().toISOString();
    const updatedAt = opts.updatedAt ?? createdAt;
    db.persistSessionMutation({
      sessionId: opts.sessionId,
      eventType: "session.created",
      snapshot: {
        sessionKind: "root",
        parentSessionId: null,
        agentType: null,
        title: opts.title,
        titleSource: "default",
        titleModel: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        workingDirectory: opts.workingDirectory,
        enableMcp: true,
        backupsEnabledOverride: null,
        createdAt,
        updatedAt,
        status: "active",
        hasPendingAsk: false,
        hasPendingApproval: false,
        systemPrompt: "system",
        messages: opts.messages,
        providerState: null,
        todos: [],
        harnessContext: null,
        costTracker: null,
      },
    });
  } finally {
    db.close();
  }
}

export async function waitFor<T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await read();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for condition${lastValue === undefined ? "" : `; last value: ${JSON.stringify(lastValue)}`}`);
}

export function createConversationSearchStatus(
  workspacePath: string,
  opts: {
    enabled?: boolean;
    availability?: ConversationSearchAvailability;
    downloadStatus?: ConversationSearchDownloadStatus;
    indexStatus?: ConversationSearchIndexStatus;
    sessionCount?: number;
    chunkCount?: number;
    lastError?: string | null;
  } = {},
): ConversationSearchStatusPayload {
  const availability = opts.availability ?? (opts.enabled ? "pending_models" : "disabled");
  const enabled = opts.enabled ?? availability !== "disabled";
  const readyModels = availability === "ready" || availability === "indexing";
  const downloadingModels = availability === "downloading_models";
  const errored = availability === "error";
  const indexStatus =
    opts.indexStatus
    ?? (availability === "ready"
      ? "ready"
      : availability === "indexing"
        ? "indexing"
        : errored
          ? "error"
          : "idle");
  const downloadStatus =
    opts.downloadStatus
    ?? (downloadingModels ? "running" : availability === "pending_models" ? "idle" : "idle");

  return {
    workspacePath,
    enabled,
    availability,
    models: {
      query: {
        key: "query",
        modelId: CONVERSATION_SEARCH_MODEL_SPECS.query.modelId,
        revision: CONVERSATION_SEARCH_MODEL_SPECS.query.revision,
        status: errored ? "error" : readyModels ? "ready" : downloadingModels ? "downloading" : "missing",
        bytesDownloaded: readyModels ? 100 : downloadingModels ? 50 : null,
        bytesTotal: readyModels || downloadingModels ? 100 : null,
        progressPercent: readyModels ? 100 : downloadingModels ? 50 : null,
        downloadedAt: readyModels ? "2026-03-13T00:00:00.000Z" : null,
        error: errored ? opts.lastError ?? "boom" : null,
      },
      context: {
        key: "context",
        modelId: CONVERSATION_SEARCH_MODEL_SPECS.context.modelId,
        revision: CONVERSATION_SEARCH_MODEL_SPECS.context.revision,
        status: errored ? "error" : readyModels ? "ready" : downloadingModels ? "downloading" : "missing",
        bytesDownloaded: readyModels ? 100 : downloadingModels ? 50 : null,
        bytesTotal: readyModels || downloadingModels ? 100 : null,
        progressPercent: readyModels ? 100 : downloadingModels ? 50 : null,
        downloadedAt: readyModels ? "2026-03-13T00:00:00.000Z" : null,
        error: errored ? opts.lastError ?? "boom" : null,
      },
    },
    download: {
      status: downloadStatus,
      activeModel: downloadingModels ? "query" : null,
      startedAt: downloadingModels ? "2026-03-13T00:00:00.000Z" : null,
      updatedAt: "2026-03-13T00:00:00.000Z",
      bytesDownloaded: downloadingModels ? 50 : null,
      bytesTotal: downloadingModels ? 100 : null,
      progressPercent: downloadingModels ? 50 : null,
      canCancel: downloadingModels,
      error: errored ? opts.lastError ?? "boom" : null,
    },
    index: {
      status: indexStatus,
      sessionCount: opts.sessionCount ?? 0,
      chunkCount: opts.chunkCount ?? 0,
      lastIndexedAt: indexStatus === "ready" ? "2026-03-13T00:00:01.000Z" : null,
      lastError: errored ? opts.lastError ?? "boom" : null,
      updatedAt: "2026-03-13T00:00:01.000Z",
    },
  };
}

export class FakeConversationSearchService {
  private readonly listeners = new Set<ConversationSearchServiceListener>();
  private readonly statuses = new Map<string, ConversationSearchStatusPayload>();

  readonly registerCalls: Array<{ workspacePath: string; enabled: boolean }> = [];
  readonly rebuildCalls: string[] = [];
  readonly persistedCalls: Array<{ workspacePath: string; sessionId: string }> = [];
  readonly searchCalls: Array<{
    workspacePath: string;
    enabled: boolean;
    query: string;
    mode: ConversationSearchMode;
    offset: number;
    limit: number;
  }> = [];

  queueModelDownloadCalls = 0;
  cancelModelDownloadCalls = 0;
  deleteModelsCalls = 0;
  disposed = false;

  searchImpl?: (opts: {
    workspacePath: string;
    enabled: boolean;
    query: string;
    mode: ConversationSearchMode;
    offset: number;
    limit: number;
  }) => Promise<ConversationSearchResponse> | ConversationSearchResponse;

  constructor(initialStatuses: ConversationSearchStatusPayload[] = []) {
    for (const status of initialStatuses) {
      this.statuses.set(status.workspacePath, status);
    }
  }

  subscribe(listener: ConversationSearchServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCachedStatus(workspacePath: string, enabled: boolean): ConversationSearchStatusPayload {
    const status = this.statuses.get(workspacePath) ?? createConversationSearchStatus(workspacePath, { enabled });
    if (status.enabled === enabled) return status;
    return createConversationSearchStatus(workspacePath, {
      enabled,
      availability: enabled ? status.availability : "disabled",
      downloadStatus: status.download.status,
      indexStatus: status.index.status,
      sessionCount: status.index.sessionCount,
      chunkCount: status.index.chunkCount,
      lastError: status.index.lastError,
    });
  }

  async getStatus(workspacePath: string, enabled: boolean): Promise<ConversationSearchStatusPayload> {
    return this.getCachedStatus(workspacePath, enabled);
  }

  isToolAvailable(workspacePath: string, enabled: boolean): boolean {
    return this.getCachedStatus(workspacePath, enabled).availability === "ready";
  }

  setStatus(status: ConversationSearchStatusPayload): void {
    this.statuses.set(status.workspacePath, status);
  }

  emit(workspacePath?: string): void {
    for (const listener of this.listeners) {
      listener(workspacePath);
    }
  }

  async registerWorkspace(workspacePath: string, enabled: boolean): Promise<void> {
    this.registerCalls.push({ workspacePath, enabled });
    this.statuses.set(workspacePath, this.getCachedStatus(workspacePath, enabled));
    this.emit(workspacePath);
  }

  async queueModelDownload(): Promise<void> {
    this.queueModelDownloadCalls += 1;
    for (const status of this.statuses.values()) {
      if (!status.enabled) continue;
      this.setStatus(createConversationSearchStatus(status.workspacePath, {
        enabled: true,
        availability: "downloading_models",
      }));
      this.emit(status.workspacePath);
    }
  }

  async cancelModelDownload(): Promise<void> {
    this.cancelModelDownloadCalls += 1;
    for (const status of this.statuses.values()) {
      if (!status.enabled) continue;
      this.setStatus(createConversationSearchStatus(status.workspacePath, {
        enabled: true,
        availability: "pending_models",
        downloadStatus: "cancelled",
        indexStatus: status.index.status,
        sessionCount: status.index.sessionCount,
        chunkCount: status.index.chunkCount,
      }));
      this.emit(status.workspacePath);
    }
  }

  async deleteModels(): Promise<void> {
    this.deleteModelsCalls += 1;
    for (const status of this.statuses.values()) {
      this.setStatus(createConversationSearchStatus(status.workspacePath, {
        enabled: status.enabled,
        availability: status.enabled ? "pending_models" : "disabled",
        downloadStatus: "idle",
        sessionCount: 0,
        chunkCount: 0,
      }));
      this.emit(status.workspacePath);
    }
  }

  async rebuildWorkspaceIndex(workspacePath: string): Promise<void> {
    this.rebuildCalls.push(workspacePath);
    const current = this.statuses.get(workspacePath) ?? createConversationSearchStatus(workspacePath, { enabled: true, availability: "ready" });
    this.setStatus(createConversationSearchStatus(workspacePath, {
      enabled: current.enabled,
      availability: "indexing",
      sessionCount: current.index.sessionCount,
      chunkCount: current.index.chunkCount,
    }));
    this.emit(workspacePath);
  }

  async notifySessionPersisted(opts: { workspacePath: string; sessionId: string }): Promise<void> {
    this.persistedCalls.push(opts);
  }

  async search(opts: {
    workspacePath: string;
    enabled: boolean;
    query: string;
    mode: ConversationSearchMode;
    offset: number;
    limit: number;
  }): Promise<ConversationSearchResponse> {
    this.searchCalls.push(opts);
    if (this.searchImpl) {
      return await this.searchImpl(opts);
    }
    return {
      workspacePath: opts.workspacePath,
      query: opts.query,
      mode: opts.mode,
      offset: opts.offset,
      limit: opts.limit,
      total: 0,
      hasMore: false,
      results: [],
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class FakeEmbeddingModelManager {
  private readonly downloadDelayMs: number;

  disposed = false;

  constructor(opts: { downloadDelayMs?: number } = {}) {
    this.downloadDelayMs = opts.downloadDelayMs ?? 0;
  }

  async downloadAll(opts: {
    shouldCancel?: () => boolean;
    onProgress?: (key: "query" | "context", event: {
      status?: string;
      progress?: number;
      loaded?: number;
      total?: number;
    }) => void;
  }): Promise<void> {
    for (const key of CONVERSATION_SEARCH_MODEL_KEYS) {
      opts.onProgress?.(key, {
        status: "downloading",
        progress: 50,
        loaded: 50,
        total: 100,
      });
      if (this.downloadDelayMs > 0) {
        await Bun.sleep(this.downloadDelayMs);
      }
      if (opts.shouldCancel?.()) {
        throw new ConversationSearchCancelledError();
      }
      opts.onProgress?.(key, {
        status: "done",
        progress: 100,
        loaded: 100,
        total: 100,
      });
    }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vectorize(text);
  }

  async embedContexts(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.vectorize(text));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private vectorize(text: string): Float32Array {
    const value = text.toLowerCase();
    return Float32Array.from([
      value.includes("alpha") ? 1 : 0,
      value.includes("beta") ? 1 : 0,
      value.includes("search") ? 1 : 0,
      value.includes("tool") ? 1 : 0,
      Math.min(value.length, 100) / 100,
    ]);
  }
}

import fs from "node:fs/promises";
import path from "node:path";

import type { AiCoworkerPaths } from "../../connect";
import type { ModelMessage } from "../../types";
import type { PersistedSessionRecord, SessionDb } from "../sessionDb";
import {
  listPersistedSessionSnapshots,
  readPersistedSessionSnapshot,
  type PersistedSessionSnapshot,
} from "../sessionStore";
import { ConversationSearchIndexStore, type IndexedSession, type KeywordChunkMatch } from "./indexStore";
import {
  ConversationSearchCancelledError,
  ConversationSearchModelManager,
  type ConversationSearchModelManagerDeps,
} from "./modelManager";
import {
  ensureConversationSearchDirs,
  getConversationSearchPaths,
  type ConversationSearchPaths,
  writeConversationSearchJson,
  workspaceLockKey,
} from "./paths";
import { buildSnippet, extractSearchableMessageChunks, keywordMatchQuery } from "./text";
import {
  CONVERSATION_SEARCH_AVAILABILITIES,
  CONVERSATION_SEARCH_DOWNLOAD_STATUSES,
  CONVERSATION_SEARCH_INDEX_STATUSES,
  CONVERSATION_SEARCH_MODEL_KEYS,
  CONVERSATION_SEARCH_MODEL_SPECS,
  CONVERSATION_SEARCH_MODEL_STATUSES,
  type ConversationSearchAvailability,
  type ConversationSearchDownloadState,
  type ConversationSearchIndexState,
  type ConversationSearchMode,
  type ConversationSearchModelKey,
  type ConversationSearchModelState,
  type ConversationSearchResponse,
  type ConversationSearchResult,
  type ConversationSearchStatusPayload,
} from "./types";

type SearchableSessionRecord = {
  sessionId: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  messages: ModelMessage[];
};

type PersistedWorkspaceState = {
  index: ConversationSearchIndexState;
};

type PersistedDownloadState = Omit<ConversationSearchDownloadState, "canCancel"> & {
  jobId: string | null;
};

type PersistedState = {
  version: 1;
  models: Record<ConversationSearchModelKey, ConversationSearchModelState>;
  download: PersistedDownloadState;
  workspaces: Record<string, PersistedWorkspaceState>;
};

type SearchJob = {
  full: boolean;
  sessionId?: string;
};

type LockHandle = {
  path: string;
  release: () => Promise<void>;
};

export type ConversationSearchServiceListener = (workspacePath?: string) => void;

export type ConversationSearchServiceOptions = {
  paths: Pick<AiCoworkerPaths, "rootDir" | "sessionsDir">;
  sessionDb: SessionDb | null;
  pollIntervalMs?: number;
  now?: () => string;
  modelManagerDeps?: ConversationSearchModelManagerDeps;
  modelManager?: ConversationSearchModelManager;
  indexStore?: ConversationSearchIndexStore;
};

function defaultModelState(key: ConversationSearchModelKey): ConversationSearchModelState {
  return {
    key,
    modelId: CONVERSATION_SEARCH_MODEL_SPECS[key].modelId,
    revision: CONVERSATION_SEARCH_MODEL_SPECS[key].revision,
    status: "missing",
    bytesDownloaded: null,
    bytesTotal: null,
    progressPercent: null,
    downloadedAt: null,
    error: null,
  };
}

function defaultDownloadState(): PersistedDownloadState {
  return {
    status: "idle",
    jobId: null,
    activeModel: null,
    startedAt: null,
    updatedAt: null,
    bytesDownloaded: null,
    bytesTotal: null,
    progressPercent: null,
    error: null,
  };
}

function defaultIndexState(): ConversationSearchIndexState {
  return {
    status: "idle",
    sessionCount: 0,
    chunkCount: 0,
    lastIndexedAt: null,
    lastError: null,
    updatedAt: null,
  };
}

function defaultState(): PersistedState {
  return {
    version: 1,
    models: {
      query: defaultModelState("query"),
      context: defaultModelState("context"),
    },
    download: defaultDownloadState(),
    workspaces: {},
  };
}

function normalizeState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultState();
  }
  const record = raw as Record<string, unknown>;
  const base = defaultState();

  const models = { ...base.models };
  if (record.models && typeof record.models === "object" && !Array.isArray(record.models)) {
    const rawModels = record.models as Record<string, unknown>;
    for (const key of CONVERSATION_SEARCH_MODEL_KEYS) {
      const rawModel = rawModels[key];
      if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
      const modelRecord = rawModel as Record<string, unknown>;
      models[key] = {
        ...defaultModelState(key),
        key,
        modelId: typeof modelRecord.modelId === "string" ? modelRecord.modelId : base.models[key].modelId,
        revision: typeof modelRecord.revision === "string" ? modelRecord.revision : base.models[key].revision,
        status: CONVERSATION_SEARCH_MODEL_STATUSES.includes(modelRecord.status as ConversationSearchModelState["status"])
          ? modelRecord.status as ConversationSearchModelState["status"]
          : "missing",
        bytesDownloaded: typeof modelRecord.bytesDownloaded === "number" ? modelRecord.bytesDownloaded : null,
        bytesTotal: typeof modelRecord.bytesTotal === "number" ? modelRecord.bytesTotal : null,
        progressPercent: typeof modelRecord.progressPercent === "number" ? modelRecord.progressPercent : null,
        downloadedAt: typeof modelRecord.downloadedAt === "string" ? modelRecord.downloadedAt : null,
        error: typeof modelRecord.error === "string" ? modelRecord.error : null,
      };
    }
  }

  const download = { ...base.download };
  if (record.download && typeof record.download === "object" && !Array.isArray(record.download)) {
    const rawDownload = record.download as Record<string, unknown>;
    download.status = CONVERSATION_SEARCH_DOWNLOAD_STATUSES.includes(rawDownload.status as PersistedDownloadState["status"])
      ? rawDownload.status as PersistedDownloadState["status"]
      : "idle";
    download.jobId = typeof rawDownload.jobId === "string" ? rawDownload.jobId : null;
    download.activeModel = CONVERSATION_SEARCH_MODEL_KEYS.includes(rawDownload.activeModel as ConversationSearchModelKey)
      ? rawDownload.activeModel as ConversationSearchModelKey
      : null;
    download.startedAt = typeof rawDownload.startedAt === "string" ? rawDownload.startedAt : null;
    download.updatedAt = typeof rawDownload.updatedAt === "string" ? rawDownload.updatedAt : null;
    download.bytesDownloaded = typeof rawDownload.bytesDownloaded === "number" ? rawDownload.bytesDownloaded : null;
    download.bytesTotal = typeof rawDownload.bytesTotal === "number" ? rawDownload.bytesTotal : null;
    download.progressPercent = typeof rawDownload.progressPercent === "number" ? rawDownload.progressPercent : null;
    download.error = typeof rawDownload.error === "string" ? rawDownload.error : null;
  }

  const workspaces: PersistedState["workspaces"] = {};
  if (record.workspaces && typeof record.workspaces === "object" && !Array.isArray(record.workspaces)) {
    for (const [workspacePath, rawWorkspace] of Object.entries(record.workspaces as Record<string, unknown>)) {
      if (!rawWorkspace || typeof rawWorkspace !== "object" || Array.isArray(rawWorkspace)) continue;
      const workspaceRecord = rawWorkspace as Record<string, unknown>;
      const rawIndex = workspaceRecord.index;
      if (!rawIndex || typeof rawIndex !== "object" || Array.isArray(rawIndex)) continue;
      const indexRecord = rawIndex as Record<string, unknown>;
      workspaces[workspacePath] = {
        index: {
          status: CONVERSATION_SEARCH_INDEX_STATUSES.includes(indexRecord.status as ConversationSearchIndexState["status"])
            ? indexRecord.status as ConversationSearchIndexState["status"]
            : "idle",
          sessionCount: typeof indexRecord.sessionCount === "number" ? Math.max(0, Math.floor(indexRecord.sessionCount)) : 0,
          chunkCount: typeof indexRecord.chunkCount === "number" ? Math.max(0, Math.floor(indexRecord.chunkCount)) : 0,
          lastIndexedAt: typeof indexRecord.lastIndexedAt === "string" ? indexRecord.lastIndexedAt : null,
          lastError: typeof indexRecord.lastError === "string" ? indexRecord.lastError : null,
          updatedAt: typeof indexRecord.updatedAt === "string" ? indexRecord.updatedAt : null,
        },
      };
    }
  }

  return {
    version: 1,
    models,
    download,
    workspaces,
  };
}

function similarityScore(left: Float32Array, right: Float32Array): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) return 0;
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    sum += left[index]! * right[index]!;
  }
  return sum;
}

function groupMatches(
  matches: Array<{
    sessionId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    hit: ConversationSearchResult["hits"][number];
  }>,
  offset: number,
  limit: number,
): { results: ConversationSearchResponse["results"]; total: number; hasMore: boolean } {
  const grouped = new Map<string, ConversationSearchResult>();

  for (const match of matches) {
    const existing = grouped.get(match.sessionId);
    if (!existing) {
      grouped.set(match.sessionId, {
        sessionId: match.sessionId,
        title: match.title,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
        messageCount: match.messageCount,
        score: match.hit.score,
        hits: [match.hit],
      });
      continue;
    }

    existing.score = Math.max(existing.score, match.hit.score);
    if (existing.hits.length < 3) {
      existing.hits.push(match.hit);
      existing.hits.sort((left, right) => right.score - left.score);
    }
  }

  const ranked = [...grouped.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  const total = ranked.length;
  return {
    results: ranked.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

export class ConversationSearchService {
  private readonly paths: ConversationSearchPaths;
  private readonly snapshotPaths: Pick<AiCoworkerPaths, "sessionsDir">;
  private readonly sessionDb: SessionDb | null;
  private readonly now: () => string;
  private readonly indexStore: ConversationSearchIndexStore;
  private readonly modelManager: ConversationSearchModelManager;
  private readonly listeners = new Set<ConversationSearchServiceListener>();
  private readonly registeredWorkspaces = new Map<string, boolean>();
  private readonly workspaceJobs = new Map<string, Promise<void>>();
  private readonly pollIntervalMs: number;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stateCache: PersistedState = defaultState();
  private stateMtimeMs: number | null = null;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  private downloadPromise: Promise<void> | null = null;
  private disposed = false;

  private constructor(opts: {
    paths: ConversationSearchPaths;
    snapshotPaths: Pick<AiCoworkerPaths, "sessionsDir">;
    sessionDb: SessionDb | null;
    now: () => string;
    pollIntervalMs: number;
    indexStore: ConversationSearchIndexStore;
    modelManager: ConversationSearchModelManager;
  }) {
    this.paths = opts.paths;
    this.snapshotPaths = opts.snapshotPaths;
    this.sessionDb = opts.sessionDb;
    this.now = opts.now;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.indexStore = opts.indexStore;
    this.modelManager = opts.modelManager;
  }

  static async create(opts: ConversationSearchServiceOptions): Promise<ConversationSearchService> {
    const paths = getConversationSearchPaths(opts.paths.rootDir);
    await ensureConversationSearchDirs(paths);

    const service = new ConversationSearchService({
      paths,
      snapshotPaths: { sessionsDir: opts.paths.sessionsDir },
      sessionDb: opts.sessionDb,
      now: opts.now ?? (() => new Date().toISOString()),
      pollIntervalMs: Math.max(250, opts.pollIntervalMs ?? 1000),
      indexStore: opts.indexStore ?? new ConversationSearchIndexStore(paths.indexDbPath),
      modelManager: opts.modelManager ?? new ConversationSearchModelManager(paths.modelsDir, opts.modelManagerDeps),
    });
    await service.refreshStateFromDisk(true);
    service.startPolling();
    return service;
  }

  subscribe(listener: ConversationSearchServiceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCachedStatus(workspacePath: string, enabled: boolean): ConversationSearchStatusPayload {
    const state = this.stateCache;
    const index = state.workspaces[workspacePath]?.index
      ?? (this.disposed ? defaultIndexState() : this.indexStore.getWorkspaceState(workspacePath));
    const models = {
      query: state.models.query,
      context: state.models.context,
    };
    const download: ConversationSearchDownloadState = {
      ...state.download,
      canCancel: state.download.status === "queued" || state.download.status === "running" || state.download.status === "cancelling",
    };
    const availability = this.computeAvailability(enabled, models, download, index);

    return {
      workspacePath,
      enabled,
      availability,
      models,
      download,
      index,
    };
  }

  async getStatus(workspacePath: string, enabled: boolean): Promise<ConversationSearchStatusPayload> {
    if (this.disposed) {
      return this.getCachedStatus(workspacePath, enabled);
    }
    await this.refreshStateFromDisk();
    return this.getCachedStatus(workspacePath, enabled);
  }

  isToolAvailable(workspacePath: string, enabled: boolean): boolean {
    return this.getCachedStatus(workspacePath, enabled).availability === "ready";
  }

  async registerWorkspace(workspacePath: string, enabled: boolean): Promise<void> {
    this.registeredWorkspaces.set(workspacePath, enabled);
    if (enabled) {
      const status = await this.getStatus(workspacePath, enabled);
      if (status.models.query.status === "ready" && status.models.context.status === "ready") {
        if (status.index.status !== "ready") {
          void this.queueWorkspaceIndex(workspacePath, { full: true });
        }
      } else {
        void this.queueModelDownload();
      }
    }
    this.notifyListeners(workspacePath);
  }

  async queueModelDownload(): Promise<void> {
    if (this.disposed) return;
    if (this.downloadPromise) return;

    this.downloadPromise = (async () => {
      const lock = await this.acquireLock("models.lock");
      if (!lock) {
        await this.refreshStateFromDisk();
        return;
      }

      const jobId = crypto.randomUUID();
      try {
        await this.updateState((state) => {
          state.download = {
            ...state.download,
            status: "running",
            jobId,
            activeModel: null,
            startedAt: state.download.startedAt ?? this.now(),
            updatedAt: this.now(),
            error: null,
          };
          for (const key of CONVERSATION_SEARCH_MODEL_KEYS) {
            if (state.models[key].status !== "ready") {
              state.models[key] = {
                ...state.models[key],
                status: "queued",
                error: null,
              };
            }
          }
        });

        await this.modelManager.downloadAll({
          shouldCancel: () => this.stateCache.download.status === "cancelling",
          onProgress: (key, event) => {
            void this.updateState((state) => {
              const nextStatus = event.status === "done" ? "ready" : "downloading";
              state.models[key] = {
                ...state.models[key],
                status: nextStatus,
                bytesDownloaded: typeof event.loaded === "number" ? event.loaded : state.models[key].bytesDownloaded,
                bytesTotal: typeof event.total === "number" ? event.total : state.models[key].bytesTotal,
                progressPercent: typeof event.progress === "number" ? event.progress : state.models[key].progressPercent,
                downloadedAt: nextStatus === "ready" ? this.now() : state.models[key].downloadedAt,
                error: null,
              };
              state.download = {
                ...state.download,
                status: state.download.status === "cancelling" ? "cancelling" : "running",
                jobId,
                activeModel: key,
                startedAt: state.download.startedAt ?? this.now(),
                updatedAt: this.now(),
                bytesDownloaded: typeof event.loaded === "number" ? event.loaded : state.download.bytesDownloaded,
                bytesTotal: typeof event.total === "number" ? event.total : state.download.bytesTotal,
                progressPercent: typeof event.progress === "number" ? event.progress : state.download.progressPercent,
                error: null,
              };
            });
          },
        });

        await this.updateState((state) => {
          for (const key of CONVERSATION_SEARCH_MODEL_KEYS) {
            state.models[key] = {
              ...state.models[key],
              status: "ready",
              downloadedAt: state.models[key].downloadedAt ?? this.now(),
              error: null,
            };
          }
          state.download = {
            ...defaultDownloadState(),
            updatedAt: this.now(),
          };
        });

        if (!this.disposed) {
          for (const [workspacePath, enabled] of this.registeredWorkspaces) {
            if (!enabled) continue;
            void this.queueWorkspaceIndex(workspacePath, { full: true });
          }
        }
      } catch (error) {
        if (error instanceof ConversationSearchCancelledError) {
          await this.updateState((state) => {
            if (state.download.jobId !== jobId && state.download.jobId !== null) return;
            const activeModel = state.download.activeModel;
            if (activeModel) {
              state.models[activeModel] = {
                ...state.models[activeModel],
                status: state.models[activeModel].downloadedAt ? "ready" : "missing",
                error: null,
                progressPercent: null,
                bytesDownloaded: null,
                bytesTotal: null,
              };
            }
            state.download = {
              ...defaultDownloadState(),
              status: "cancelled",
              updatedAt: this.now(),
            };
          });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          await this.updateState((state) => {
            const activeModel = state.download.activeModel;
            if (activeModel) {
              state.models[activeModel] = {
                ...state.models[activeModel],
                status: "error",
                error: message,
              };
            }
            state.download = {
              ...defaultDownloadState(),
              status: "error",
              updatedAt: this.now(),
              error: message,
            };
          });
        }
      } finally {
        await lock.release();
      }
    })().finally(() => {
      this.downloadPromise = null;
      this.notifyListeners();
    });
  }

  async cancelModelDownload(): Promise<void> {
    await this.updateState((state) => {
      if (state.download.status === "running" || state.download.status === "queued") {
        state.download = {
          ...state.download,
          status: "cancelling",
          updatedAt: this.now(),
        };
      }
    });
    this.notifyListeners();
  }

  async deleteModels(): Promise<void> {
    await this.cancelModelDownload();
    if (this.downloadPromise) {
      await this.downloadPromise.catch(() => {});
    }

    const lock = await this.acquireLock("models.lock");
    if (!lock) {
      throw new Error("Conversation search models are busy in another server process");
    }

    try {
      await this.modelManager.dispose();
      await fs.rm(this.paths.modelsDir, { recursive: true, force: true });
      await ensureConversationSearchDirs(this.paths);
      this.indexStore.clearAll();
      await this.updateState((state) => {
        state.models = {
          query: defaultModelState("query"),
          context: defaultModelState("context"),
        };
        state.download = {
          ...defaultDownloadState(),
          updatedAt: this.now(),
        };
        for (const workspaceState of Object.values(state.workspaces)) {
          workspaceState.index = defaultIndexState();
        }
      });
    } finally {
      await lock.release();
    }
  }

  async rebuildWorkspaceIndex(workspacePath: string): Promise<void> {
    void this.queueWorkspaceIndex(workspacePath, { full: true });
  }

  async notifySessionPersisted(opts: { workspacePath: string; sessionId: string }): Promise<void> {
    if (!this.registeredWorkspaces.get(opts.workspacePath)) return;
    if (!this.isModelsReady()) return;
    void this.queueWorkspaceIndex(opts.workspacePath, { full: false, sessionId: opts.sessionId });
  }

  async search(opts: {
    workspacePath: string;
    enabled: boolean;
    query: string;
    mode: ConversationSearchMode;
    offset: number;
    limit: number;
  }): Promise<ConversationSearchResponse> {
    const status = await this.getStatus(opts.workspacePath, opts.enabled);
    if (status.availability !== "ready") {
      throw new Error(`Conversation search is not ready for ${opts.workspacePath} (${status.availability})`);
    }

    let matches: Array<{
      sessionId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      messageCount: number;
      hit: ConversationSearchResult["hits"][number];
    }> = [];

    if (opts.mode === "keyword") {
      let keywordMatches: KeywordChunkMatch[];
      try {
        keywordMatches = this.indexStore.searchKeyword(opts.workspacePath, keywordMatchQuery(opts.query));
      } catch {
        keywordMatches = this.indexStore.searchKeyword(
          opts.workspacePath,
          `"${opts.query.replace(/"/g, '""')}"`,
        );
      }
      matches = keywordMatches.map((match) => ({
        sessionId: match.sessionId,
        title: match.title,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
        messageCount: match.messageCount,
        hit: match.hit,
      }));
    } else {
      const queryVector = await this.modelManager.embedQuery(opts.query);
      const candidates = this.indexStore.listSemanticCandidates(opts.workspacePath)
        .map((candidate) => ({
          ...candidate,
          score: similarityScore(queryVector, candidate.vector),
        }))
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return right.updatedAt.localeCompare(left.updatedAt);
        });

      matches = candidates.map((candidate) => ({
        sessionId: candidate.sessionId,
        title: candidate.title,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        messageCount: candidate.messageCount,
        hit: {
          messageIndex: candidate.messageIndex,
          role: candidate.role,
          snippet: candidate.snippet,
          score: candidate.score,
        },
      }));
    }

    const grouped = groupMatches(matches, opts.offset, opts.limit);
    return {
      workspacePath: opts.workspacePath,
      query: opts.query,
      mode: opts.mode,
      offset: opts.offset,
      limit: opts.limit,
      total: grouped.total,
      hasMore: grouped.hasMore,
      results: grouped.results,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
    await Promise.allSettled([...this.workspaceJobs.values()]);
    await this.stateWriteQueue.catch(() => {});
    await this.modelManager.dispose();
    this.indexStore.close();
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.refreshStateFromDisk();
    }, this.pollIntervalMs);
  }

  private async queueWorkspaceIndex(workspacePath: string, job: SearchJob): Promise<void> {
    const previous = this.workspaceJobs.get(workspacePath) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // keep the queue alive after failures
      })
      .then(async () => {
        if (this.disposed) return;
        if (!this.isModelsReady()) return;

        const lock = await this.acquireLock(`workspace-${workspaceLockKey(workspacePath)}.lock`);
        if (!lock) {
          await this.refreshStateFromDisk();
          return;
        }

        try {
          if (this.disposed) return;
          const currentCounts = this.indexStore.getWorkspaceCounts(workspacePath);
          const indexingState: ConversationSearchIndexState = {
            status: "indexing",
            sessionCount: currentCounts.sessionCount,
            chunkCount: currentCounts.chunkCount,
            lastIndexedAt: this.stateCache.workspaces[workspacePath]?.index.lastIndexedAt ?? null,
            lastError: null,
            updatedAt: this.now(),
          };
          this.indexStore.setWorkspaceState(workspacePath, indexingState);
          await this.updateState((state) => {
            state.workspaces[workspacePath] = { index: indexingState };
          }, false);
          this.notifyListeners(workspacePath);

          if (job.full) {
            const sessions = await this.loadWorkspaceSessions(workspacePath);
            const indexedSessions = await Promise.all(sessions.map(async (session) => await this.indexSession(session)));
            this.indexStore.replaceWorkspaceSessions(
              workspacePath,
              indexedSessions.filter((session): session is IndexedSession => session !== null),
            );
          } else if (job.sessionId) {
            const session = await this.loadSessionById(workspacePath, job.sessionId);
            if (!session) {
              this.indexStore.deleteSession(job.sessionId);
            } else {
              const indexed = await this.indexSession(session);
              if (indexed) {
                this.indexStore.replaceSession(indexed);
              } else {
                this.indexStore.deleteSession(job.sessionId);
              }
            }
          }

          const counts = this.indexStore.getWorkspaceCounts(workspacePath);
          const readyState: ConversationSearchIndexState = {
            status: "ready",
            sessionCount: counts.sessionCount,
            chunkCount: counts.chunkCount,
            lastIndexedAt: this.now(),
            lastError: null,
            updatedAt: this.now(),
          };
          this.indexStore.setWorkspaceState(workspacePath, readyState);
          await this.updateState((state) => {
            state.workspaces[workspacePath] = { index: readyState };
          }, false);
          this.notifyListeners(workspacePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const counts = this.indexStore.getWorkspaceCounts(workspacePath);
          const errorState: ConversationSearchIndexState = {
            status: "error",
            sessionCount: counts.sessionCount,
            chunkCount: counts.chunkCount,
            lastIndexedAt: this.stateCache.workspaces[workspacePath]?.index.lastIndexedAt ?? null,
            lastError: message,
            updatedAt: this.now(),
          };
          this.indexStore.setWorkspaceState(workspacePath, errorState);
          await this.updateState((state) => {
            state.workspaces[workspacePath] = { index: errorState };
          }, false);
          this.notifyListeners(workspacePath);
        } finally {
          await lock.release();
        }
      })
      .finally(() => {
        if (this.workspaceJobs.get(workspacePath) === next) {
          this.workspaceJobs.delete(workspacePath);
        }
      });

    this.workspaceJobs.set(workspacePath, next);
  }

  private async indexSession(session: SearchableSessionRecord): Promise<IndexedSession | null> {
    const chunks = extractSearchableMessageChunks(session.messages);
    if (chunks.length === 0) {
      return null;
    }

    const embeddings = await this.embedContextBatches(chunks.map((chunk) => chunk.text));
    return {
      workspacePath: session.workspacePath,
      sessionId: session.sessionId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      chunks: chunks.map((chunk, index) => ({
        chunkId: `${session.sessionId}:${chunk.messageIndex}`,
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        messageIndex: chunk.messageIndex,
        role: chunk.role,
        contentText: chunk.text,
        snippetText: buildSnippet(chunk.text),
        embedding: embeddings[index] ?? null,
        embeddingModelId: embeddings[index] ? CONVERSATION_SEARCH_MODEL_SPECS.context.modelId : null,
      })),
    };
  }

  private async embedContextBatches(texts: string[]): Promise<Float32Array[]> {
    const batchSize = 8;
    const vectors: Float32Array[] = [];
    for (let index = 0; index < texts.length; index += batchSize) {
      const batch = texts.slice(index, index + batchSize);
      const embedded = await this.modelManager.embedContexts(batch);
      vectors.push(...embedded);
    }
    return vectors;
  }

  private async loadWorkspaceSessions(workspacePath: string): Promise<SearchableSessionRecord[]> {
    if (this.sessionDb) {
      return this.sessionDb.listSessionsByWorkspace(workspacePath)
        .map((summary) => this.sessionDb?.getSessionRecord(summary.sessionId) ?? null)
        .filter((record): record is PersistedSessionRecord => record !== null)
        .filter((record) => record.sessionKind === "root" && record.workingDirectory === workspacePath)
        .map((record) => this.mapPersistedRecord(record));
    }

    const summaries = await listPersistedSessionSnapshots(this.snapshotPaths, { workingDirectory: workspacePath });
    const sessions: SearchableSessionRecord[] = [];
    for (const summary of summaries) {
      const snapshot = await readPersistedSessionSnapshot({
        paths: this.snapshotPaths,
        sessionId: summary.sessionId,
      });
      if (!snapshot) continue;
      const mapped = this.mapSnapshot(snapshot);
      if (mapped && mapped.workspacePath === workspacePath) {
        sessions.push(mapped);
      }
    }
    return sessions;
  }

  private async loadSessionById(workspacePath: string, sessionId: string): Promise<SearchableSessionRecord | null> {
    if (this.sessionDb) {
      const record = this.sessionDb.getSessionRecord(sessionId);
      if (!record) return null;
      if (record.sessionKind !== "root" || record.workingDirectory !== workspacePath) return null;
      return this.mapPersistedRecord(record);
    }

    const snapshot = await readPersistedSessionSnapshot({
      paths: this.snapshotPaths,
      sessionId,
    });
    if (!snapshot) return null;
    const mapped = this.mapSnapshot(snapshot);
    if (!mapped || mapped.workspacePath !== workspacePath) return null;
    return mapped;
  }

  private mapPersistedRecord(record: PersistedSessionRecord): SearchableSessionRecord {
    return {
      sessionId: record.sessionId,
      workspacePath: record.workingDirectory,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messageCount,
      messages: record.messages,
    };
  }

  private mapSnapshot(snapshot: PersistedSessionSnapshot): SearchableSessionRecord | null {
    const sessionKind =
      snapshot.version === 3 || snapshot.version === 4 || snapshot.version === 5
        ? snapshot.session.sessionKind
        : "root";
    if (sessionKind !== "root") return null;
    return {
      sessionId: snapshot.sessionId,
      workspacePath: snapshot.config.workingDirectory,
      title: snapshot.session.title,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      messageCount: snapshot.context.messages.length,
      messages: snapshot.context.messages,
    };
  }

  private computeAvailability(
    enabled: boolean,
    models: Record<ConversationSearchModelKey, ConversationSearchModelState>,
    download: ConversationSearchDownloadState,
    index: ConversationSearchIndexState,
  ): ConversationSearchAvailability {
    if (!enabled) return "disabled";
    if (download.status === "running" || download.status === "queued" || download.status === "cancelling") {
      return "downloading_models";
    }
    if (Object.values(models).some((model) => model.status === "error")) {
      return "error";
    }
    if (index.status === "error") {
      return "error";
    }
    if (!this.isModelsReady(models)) {
      return "pending_models";
    }
    if (index.status === "indexing") {
      return "indexing";
    }
    if (index.status === "idle") {
      return "indexing";
    }
    return "ready";
  }

  private isModelsReady(models = this.stateCache.models): boolean {
    return models.query.status === "ready" && models.context.status === "ready";
  }

  private async refreshStateFromDisk(force = false): Promise<void> {
    if (this.disposed) return;
    try {
      const stat = await fs.stat(this.paths.stateFile);
      if (!force && this.stateMtimeMs !== null && stat.mtimeMs === this.stateMtimeMs) {
        return;
      }
      this.stateMtimeMs = stat.mtimeMs;
      this.stateCache = normalizeState(await readJsonFile(this.paths.stateFile));
      this.notifyListeners();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code === "ENOENT") {
        this.stateCache = defaultState();
        this.stateMtimeMs = null;
        return;
      }
      throw error;
    }
  }

  private async updateState(
    update: (state: PersistedState) => void,
    notify = true,
  ): Promise<void> {
    if (this.disposed) return;
    const run = async () => {
      if (this.disposed) return;
      const next = normalizeState(this.stateCache);
      update(next);
      this.stateCache = next;
      await writeConversationSearchJson(this.paths.stateFile, next);
      try {
        const stat = await fs.stat(this.paths.stateFile);
        this.stateMtimeMs = stat.mtimeMs;
      } catch {
        this.stateMtimeMs = null;
      }
      if (notify) {
        this.notifyListeners();
      }
    };

    this.stateWriteQueue = this.stateWriteQueue
      .catch(() => {
        // keep state queue alive after prior failures
      })
      .then(run);
    await this.stateWriteQueue;
  }

  private notifyListeners(workspacePath?: string): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(workspacePath);
      } catch {
        // listener failures should not break status fanout
      }
    }
  }

  private async acquireLock(lockName: string): Promise<LockHandle | null> {
    const lockPath = path.join(this.paths.locksDir, lockName);
    await this.clearStaleLock(lockPath);
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: this.now() }, null, 2)}\n`, "utf-8");
      await handle.close();
      return {
        path: lockPath,
        release: async () => {
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code === "EEXIST") {
        return null;
      }
      throw error;
    }
  }

  private async clearStaleLock(lockPath: string): Promise<void> {
    try {
      const raw = await fs.readFile(lockPath, "utf-8");
      const payload = JSON.parse(raw) as { pid?: unknown };
      if (typeof payload.pid !== "number") return;
      try {
        process.kill(payload.pid, 0);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code === "ESRCH") {
          await fs.rm(lockPath, { force: true });
        }
      }
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code === "ENOENT") return;
      if (error instanceof SyntaxError) {
        await fs.rm(lockPath, { force: true });
      }
    }
  }
}

export type { SearchableSessionRecord };

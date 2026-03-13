export const CONVERSATION_SEARCH_MODES = ["keyword", "semantic"] as const;
export type ConversationSearchMode = (typeof CONVERSATION_SEARCH_MODES)[number];

export const CONVERSATION_SEARCH_MODEL_SPECS = {
  query: {
    modelId: "perplexity-ai/pplx-embed-v1-0.6b",
    revision: "main",
  },
  context: {
    modelId: "perplexity-ai/pplx-embed-context-v1-0.6b",
    revision: "main",
  },
} as const;

export const CONVERSATION_SEARCH_MODEL_KEYS = ["query", "context"] as const;
export type ConversationSearchModelKey = (typeof CONVERSATION_SEARCH_MODEL_KEYS)[number];

export const CONVERSATION_SEARCH_MODEL_STATUSES = [
  "missing",
  "queued",
  "downloading",
  "ready",
  "error",
] as const;
export type ConversationSearchModelStatus = (typeof CONVERSATION_SEARCH_MODEL_STATUSES)[number];

export const CONVERSATION_SEARCH_DOWNLOAD_STATUSES = [
  "idle",
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "error",
] as const;
export type ConversationSearchDownloadStatus = (typeof CONVERSATION_SEARCH_DOWNLOAD_STATUSES)[number];

export const CONVERSATION_SEARCH_INDEX_STATUSES = [
  "idle",
  "indexing",
  "ready",
  "error",
] as const;
export type ConversationSearchIndexStatus = (typeof CONVERSATION_SEARCH_INDEX_STATUSES)[number];

export const CONVERSATION_SEARCH_AVAILABILITIES = [
  "disabled",
  "pending_models",
  "downloading_models",
  "indexing",
  "ready",
  "error",
] as const;
export type ConversationSearchAvailability = (typeof CONVERSATION_SEARCH_AVAILABILITIES)[number];

export type ConversationSearchModelState = {
  key: ConversationSearchModelKey;
  modelId: string;
  revision: string | null;
  status: ConversationSearchModelStatus;
  bytesDownloaded: number | null;
  bytesTotal: number | null;
  progressPercent: number | null;
  downloadedAt: string | null;
  error: string | null;
};

export type ConversationSearchDownloadState = {
  status: ConversationSearchDownloadStatus;
  activeModel: ConversationSearchModelKey | null;
  startedAt: string | null;
  updatedAt: string | null;
  bytesDownloaded: number | null;
  bytesTotal: number | null;
  progressPercent: number | null;
  canCancel: boolean;
  error: string | null;
};

export type ConversationSearchIndexState = {
  status: ConversationSearchIndexStatus;
  sessionCount: number;
  chunkCount: number;
  lastIndexedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

export type ConversationSearchStatusPayload = {
  workspacePath: string;
  enabled: boolean;
  availability: ConversationSearchAvailability;
  models: Record<ConversationSearchModelKey, ConversationSearchModelState>;
  download: ConversationSearchDownloadState;
  index: ConversationSearchIndexState;
};

export type ConversationSearchHit = {
  messageIndex: number;
  role: string;
  snippet: string;
  score: number;
};

export type ConversationSearchResult = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  score: number;
  hits: ConversationSearchHit[];
};

export type ConversationSearchResponse = {
  workspacePath: string;
  query: string;
  mode: ConversationSearchMode;
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  results: ConversationSearchResult[];
};

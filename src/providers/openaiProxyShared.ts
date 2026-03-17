import type { AgentConfig } from "../types";

type MaybeEnv = Record<string, string | undefined> | NodeJS.ProcessEnv;

export type OpenAiProxyDiscoveredModel = {
  id: string;
  displayName: string;
  supportsImageInput: boolean;
  knowledgeCutoff: "Unknown";
};

const DEFAULT_DISCOVERY_TIMEOUT_MS = 7_500;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!url.protocol.startsWith("http")) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function titleCaseSegment(value: string): string {
  if (!value) return value;
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function displayNameForModelId(modelId: string): string {
  const compact = modelId.trim();
  if (!compact) return modelId;
  const vendorSplit = compact.split("/");
  const base = vendorSplit[vendorSplit.length - 1] ?? compact;
  return titleCaseSegment(base);
}

function supportsImageByMetadata(rawModel: Record<string, unknown>): boolean {
  const modalities = Array.isArray(rawModel.modalities) ? rawModel.modalities : [];
  const hasImageModality = modalities.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("image"));
  if (hasImageModality) return true;

  const inputModalities = Array.isArray(rawModel.input_modalities) ? rawModel.input_modalities : [];
  const hasImageInput = inputModalities.some((entry) => typeof entry === "string" && entry.toLowerCase().includes("image"));
  if (hasImageInput) return true;

  const id = asNonEmptyString(rawModel.id)?.toLowerCase() ?? "";
  return id.includes("vision") || id.includes("multimodal");
}

function parseDiscoveredModels(raw: unknown): OpenAiProxyDiscoveredModel[] {
  if (typeof raw !== "object" || raw === null) return [];
  const record = raw as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const models = data
    .map((entry) => (typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : null))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: asNonEmptyString(entry.id) ?? "",
      supportsImageInput: supportsImageByMetadata(entry),
    }))
    .filter((entry) => entry.id.length > 0);

  if (models.length === 0) return [];

  const uniqueById = new Map<string, { id: string; supportsImageInput: boolean }>();
  for (const model of models) {
    const existing = uniqueById.get(model.id);
    if (!existing) {
      uniqueById.set(model.id, model);
      continue;
    }
    if (!existing.supportsImageInput && model.supportsImageInput) {
      uniqueById.set(model.id, model);
    }
  }

  const deduped = [...uniqueById.values()];
  const claudeModels = deduped.filter((entry) => {
    const lower = entry.id.toLowerCase();
    return lower.includes("claude") || lower.includes("anthropic");
  });
  const preferred = claudeModels.length > 0 ? claudeModels : deduped;

  return preferred
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      displayName: displayNameForModelId(entry.id),
      supportsImageInput: entry.supportsImageInput,
      knowledgeCutoff: "Unknown" as const,
    }));
}

export function resolveOpenAiProxyApiKey(opts: {
  savedKey?: string;
  env?: MaybeEnv;
} = {}): string | undefined {
  const savedKey = opts.savedKey?.trim();
  if (savedKey) return savedKey;
  const envValue = (opts.env ?? process.env).OPENAI_PROXY_API_KEY?.trim();
  return envValue ? envValue : undefined;
}

export function resolveOpenAiProxyBaseUrl(opts: {
  baseUrl?: string;
  config?: AgentConfig;
  env?: MaybeEnv;
} = {}): string | undefined {
  if (opts.baseUrl) {
    const normalized = normalizeBaseUrl(opts.baseUrl);
    if (normalized) return normalized;
  }
  const configValue = opts.config?.openaiProxyBaseUrl;
  if (configValue) {
    const normalized = normalizeBaseUrl(configValue);
    if (normalized) return normalized;
  }
  const envValue = (opts.env ?? process.env).OPENAI_PROXY_BASE_URL;
  if (!envValue) return undefined;
  return normalizeBaseUrl(envValue) ?? undefined;
}

export function openAiProxyForcedHeaders(): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
}

export async function discoverOpenAiProxyModels(opts: {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<OpenAiProxyDiscoveredModel[]> {
  const baseUrl = opts.baseUrl;
  if (!baseUrl) return [];

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      ...openAiProxyForcedHeaders(),
    };
    const apiKey = opts.apiKey?.trim();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const body = await response.json().catch(() => null);
    return parseDiscoveredModels(body);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

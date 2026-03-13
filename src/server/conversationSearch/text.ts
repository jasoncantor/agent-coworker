const MAX_COLLECT_DEPTH = 6;
const MAX_SNIPPET_CHARS = 220;
const SEARCHABLE_ROLES = new Set(["user", "assistant", "tool"]);
const TEXT_PRIORITY_KEYS = ["text", "inputText", "outputText", "content", "message", "title"] as const;

export type SearchableMessageChunk = {
  messageIndex: number;
  role: string;
  text: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

function collectText(value: unknown, out: string[], depth = 0): void {
  if (depth > MAX_COLLECT_DEPTH || value === null || value === undefined) return;

  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    if (normalized) out.push(normalized);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, out, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  for (const key of TEXT_PRIORITY_KEYS) {
    if (record[key] !== undefined) {
      collectText(record[key], out, depth + 1);
    }
  }

  if (typeof record.type === "string" && record.type.includes("image")) {
    return;
  }

  for (const [key, nested] of Object.entries(record)) {
    if (TEXT_PRIORITY_KEYS.includes(key as (typeof TEXT_PRIORITY_KEYS)[number])) continue;
    if (key === "type" || key === "id" || key === "name" || key.endsWith("Url") || key.endsWith("URI")) {
      continue;
    }
    collectText(nested, out, depth + 1);
  }
}

export function normalizeSearchText(value: unknown): string {
  const parts: string[] = [];
  collectText(value, parts, 0);
  return normalizeWhitespace(parts.join("\n"));
}

export function extractSearchableMessageChunks(messages: Array<{ role?: unknown; content?: unknown }>): SearchableMessageChunk[] {
  const chunks: SearchableMessageChunk[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = typeof message?.role === "string" ? message.role : "";
    if (!SEARCHABLE_ROLES.has(role)) continue;
    const text = normalizeSearchText(message?.content);
    if (!text) continue;
    chunks.push({
      messageIndex: index,
      role,
      text,
    });
  }
  return chunks;
}

export function buildSnippet(text: string, query?: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return "";

  const trimmedQuery = normalizeWhitespace(query ?? "");
  if (!trimmedQuery) {
    return normalized.length <= MAX_SNIPPET_CHARS
      ? normalized
      : `${normalized.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
  }

  const lowerText = normalized.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const hitIndex = lowerText.indexOf(lowerQuery);
  if (hitIndex < 0) {
    return normalized.length <= MAX_SNIPPET_CHARS
      ? normalized
      : `${normalized.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
  }

  const halfWindow = Math.floor(MAX_SNIPPET_CHARS / 2);
  const start = Math.max(0, hitIndex - halfWindow);
  const end = Math.min(normalized.length, start + MAX_SNIPPET_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

export function keywordMatchQuery(query: string): string {
  const terms = normalizeWhitespace(query)
    .split(" ")
    .map((term) => term.replace(/"/g, '""'))
    .filter(Boolean)
    .slice(0, 16);
  if (terms.length === 0) {
    return `"${normalizeWhitespace(query).replace(/"/g, '""')}"`;
  }
  return terms.map((term) => `"${term}"*`).join(" AND ");
}

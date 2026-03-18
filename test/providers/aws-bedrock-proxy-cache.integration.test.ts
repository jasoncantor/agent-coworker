import { describe, expect, test } from "bun:test";

import { awsBedrockProxyForcedHeaders } from "../../src/providers/awsBedrockProxyShared";

const runLiveApiTests = process.env.RUN_LIVE_API_TESTS === "1";
const proxyBaseUrl = process.env.AWS_BEDROCK_PROXY_TEST_BASE_URL?.trim() || process.env.OPENAI_PROXY_TEST_BASE_URL?.trim();
const proxyApiKey = process.env.AWS_BEDROCK_PROXY_TEST_API_KEY?.trim() || process.env.OPENAI_PROXY_TEST_API_KEY?.trim();
const proxyModel = process.env.AWS_BEDROCK_PROXY_TEST_MODEL?.trim() || process.env.OPENAI_PROXY_TEST_MODEL?.trim();

type CacheTelemetry = {
  score: number | null;
  signals: Record<string, number>;
};

function shouldRunLiveCacheTest(): boolean {
  if (!runLiveApiTests) {
    console.warn("[aws-bedrock-proxy live cache] skipping: set RUN_LIVE_API_TESTS=1 to enable.");
    return false;
  }
  if (!proxyBaseUrl || !proxyApiKey || !proxyModel) {
    console.warn(
      "[aws-bedrock-proxy live cache] skipping: set AWS_BEDROCK_PROXY_TEST_BASE_URL, AWS_BEDROCK_PROXY_TEST_API_KEY, and AWS_BEDROCK_PROXY_TEST_MODEL (or legacy OPENAI_PROXY_TEST_*)."
    );
    return false;
  }
  return true;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function extractCacheTelemetry(payload: unknown): CacheTelemetry {
  const signals: Record<string, number> = {};
  const candidatePaths: ReadonlyArray<readonly string[]> = [
    ["usage", "cachedPromptTokens"],
    ["usage", "cacheRead"],
    ["usage", "cache_read"],
    ["usage", "prompt_cache_hit_tokens"],
    ["usage", "prompt_tokens_details", "cached_tokens"],
    ["usage", "promptTokensDetails", "cachedTokens"],
    ["usage", "input_tokens_details", "cached_tokens"],
    ["usage", "inputTokensDetails", "cachedTokens"],
    ["cachedPromptTokens"],
    ["cacheRead"],
    ["cache_read"],
    ["prompt_cache_hit_tokens"],
  ];

  for (const candidatePath of candidatePaths) {
    const value = toFiniteNumber(readPath(payload, candidatePath));
    if (value === undefined) continue;
    signals[candidatePath.join(".")] = value;
  }

  const recursiveSignalName = new Set([
    "cachedprompttokens",
    "cacheread",
    "cache_read",
    "prompt_cache_hit_tokens",
    "cached_tokens",
    "cache_hit",
    "cachehit",
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]);

  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${prefix}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const normalized = key.toLowerCase();
      const numeric = toFiniteNumber(raw);
      if (numeric !== undefined && recursiveSignalName.has(normalized)) {
        signals[path] = numeric;
      }
      walk(raw, path);
    }
  };
  walk(payload, "");

  const entries = Object.values(signals).filter((value) => Number.isFinite(value));
  if (entries.length === 0) {
    return { score: null, signals };
  }
  const score = entries.reduce((sum, value) => sum + value, 0);
  return { score, signals };
}

async function invokeProxyChatCompletions(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<{ payload: unknown; telemetry: CacheTelemetry }> {
  const url = chatCompletionsUrl(opts.baseUrl);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    ...awsBedrockProxyForcedHeaders(),
  };
  const request = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      stream: false,
      temperature: 0,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: opts.prompt,
        },
      ],
    }),
  });

  expect(request.headers.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")).toBe("1");

  const response = await fetch(request);
  const rawText = await response.text();
  const payload = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
  if (!response.ok) {
    throw new Error(`[aws-bedrock-proxy live cache] ${response.status} ${response.statusText}: ${rawText}`);
  }
  return {
    payload,
    telemetry: extractCacheTelemetry(payload),
  };
}

describe("aws-bedrock-proxy live cache verification", () => {
  test("reports cache-hit progression on repeated prompts when telemetry is available", async () => {
    if (!shouldRunLiveCacheTest()) return;

    const prompt = [
      "Cache verification probe: repeat this exact prompt across two requests.",
      "Return a short summary only.",
      "Block:",
      "0123456789abcdefghijklmnopqrstuvwxyz".repeat(500),
    ].join("\n");

    const first = await invokeProxyChatCompletions({
      baseUrl: proxyBaseUrl as string,
      apiKey: proxyApiKey as string,
      model: proxyModel as string,
      prompt,
    });
    const second = await invokeProxyChatCompletions({
      baseUrl: proxyBaseUrl as string,
      apiKey: proxyApiKey as string,
      model: proxyModel as string,
      prompt,
    });

    if (first.telemetry.score === null || second.telemetry.score === null) {
      console.warn(
        `[aws-bedrock-proxy live cache] inconclusive: cache telemetry missing. first=${JSON.stringify(first.telemetry.signals)} second=${JSON.stringify(second.telemetry.signals)}`
      );
      return;
    }

    expect(second.telemetry.score).toBeGreaterThan(first.telemetry.score);
  }, 240_000);
});

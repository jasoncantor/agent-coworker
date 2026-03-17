import { describe, expect, test } from "bun:test";

import {
  discoverOpenAiProxyModels,
  openAiProxyForcedHeaders,
  resolveOpenAiProxyApiKey,
  resolveOpenAiProxyBaseUrl,
} from "../../src/providers/openaiProxyShared";

describe("openaiProxyShared", () => {
  test("resolves API key with saved-key precedence over env", () => {
    expect(resolveOpenAiProxyApiKey({
      savedKey: "saved-key",
      env: { OPENAI_PROXY_API_KEY: "env-key" },
    })).toBe("saved-key");
    expect(resolveOpenAiProxyApiKey({
      env: { OPENAI_PROXY_API_KEY: "env-key" },
    })).toBe("env-key");
  });

  test("resolves normalized base URL from config or env", () => {
    expect(resolveOpenAiProxyBaseUrl({
      config: { openaiProxyBaseUrl: " https://proxy.internal/v1/ " } as any,
    })).toBe("https://proxy.internal/v1");
    expect(resolveOpenAiProxyBaseUrl({
      env: { OPENAI_PROXY_BASE_URL: "https://proxy.env/v1/" },
    })).toBe("https://proxy.env/v1");
  });

  test("returns forced header required for Claude cache compatibility", () => {
    expect(openAiProxyForcedHeaders()).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });
  });

  test("discovers models and prefers claude/anthropic ids when available", async () => {
    const models = await discoverOpenAiProxyModels({
      baseUrl: "https://proxy.internal/v1",
      apiKey: "proxy-key",
      fetchImpl: async (_url, init) => {
        expect((init?.headers as any).authorization).toBe("Bearer proxy-key");
        expect((init?.headers as any).CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-4o-mini" },
            { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", input_modalities: ["text", "image"] },
            { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", input_modalities: ["text"] },
          ],
        }), { status: 200 });
      },
    });

    expect(models).toEqual([
      {
        id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        displayName: "Anthropic.claude 3 5 Sonnet 20241022 V2:0",
        knowledgeCutoff: "Unknown",
        supportsImageInput: true,
      },
    ]);
  });

  test("returns an empty model list when discovery fails", async () => {
    const models = await discoverOpenAiProxyModels({
      baseUrl: "https://proxy.internal/v1",
      fetchImpl: async () => new Response("failed", { status: 500 }),
    });
    expect(models).toEqual([]);
  });

  test("returns an empty model list when /models payload has no usable ids", async () => {
    const models = await discoverOpenAiProxyModels({
      baseUrl: "https://proxy.internal/v1",
      fetchImpl: async () => new Response(JSON.stringify({
        data: [
          { id: "   " },
          { object: "model" },
        ],
      }), { status: 200 }),
    });
    expect(models).toEqual([]);
  });
});

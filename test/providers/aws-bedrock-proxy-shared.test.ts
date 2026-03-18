import { describe, expect, test } from "bun:test";

import {
  awsBedrockProxyForcedHeaders,
  discoverAwsBedrockProxyModelsDetailed,
  discoverAwsBedrockProxyModels,
  formatAwsBedrockProxyDiscoveryFailure,
  resolveAwsBedrockProxyApiKey,
  resolveAwsBedrockProxyBaseUrl,
} from "../../src/providers/awsBedrockProxyShared";

describe("awsBedrockProxyShared", () => {
  test("resolves API key with saved-key precedence over env", () => {
    expect(resolveAwsBedrockProxyApiKey({
      savedKey: "saved-key",
      env: { AWS_BEDROCK_PROXY_API_KEY: "env-key" },
    })).toBe("saved-key");
    expect(resolveAwsBedrockProxyApiKey({
      env: { AWS_BEDROCK_PROXY_API_KEY: "env-key" },
    })).toBe("env-key");
    expect(resolveAwsBedrockProxyApiKey({
      env: { OPENAI_PROXY_API_KEY: "legacy-env-key" },
    })).toBe("legacy-env-key");
  });

  test("resolves normalized base URL from config or env", () => {
    expect(resolveAwsBedrockProxyBaseUrl({
      config: { awsBedrockProxyBaseUrl: " https://proxy.internal/v1/ " } as any,
    })).toBe("https://proxy.internal/v1");
    expect(resolveAwsBedrockProxyBaseUrl({
      config: { openaiProxyBaseUrl: " https://legacy.proxy.internal/v1/ " } as any,
    })).toBe("https://legacy.proxy.internal/v1");
    expect(resolveAwsBedrockProxyBaseUrl({
      env: { AWS_BEDROCK_PROXY_BASE_URL: "https://proxy.env/v1/" },
    })).toBe("https://proxy.env/v1");
    expect(resolveAwsBedrockProxyBaseUrl({
      env: { OPENAI_PROXY_BASE_URL: "https://legacy.proxy.env/v1/" },
    })).toBe("https://legacy.proxy.env/v1");
  });

  test("returns forced header required for Claude cache compatibility", () => {
    expect(awsBedrockProxyForcedHeaders()).toEqual({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });
  });

  test("discovers models and prefers claude/anthropic ids when available", async () => {
    const models = await discoverAwsBedrockProxyModels({
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
    const models = await discoverAwsBedrockProxyModels({
      baseUrl: "https://proxy.internal/v1",
      fetchImpl: async () => new Response("failed", { status: 500 }),
    });
    expect(models).toEqual([]);
  });

  test("returns an empty model list when /models payload has no usable ids", async () => {
    const models = await discoverAwsBedrockProxyModels({
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

  test("returns structured discovery failure for 401 responses", async () => {
    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.internal/v1",
      apiKey: "sk-upstream-key",
      fetchImpl: async () => new Response(JSON.stringify({
        error: {
          message: "Invalid proxy server token passed.",
        },
      }), { status: 401 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unauthorized");
    expect(result.status).toBe(401);
    expect(formatAwsBedrockProxyDiscoveryFailure(result)).toContain("Proxy token rejected");
  });

  test("returns structured discovery failure for malformed payloads", async () => {
    const result = await discoverAwsBedrockProxyModelsDetailed({
      baseUrl: "https://proxy.internal/v1",
      apiKey: "proxy-token",
      fetchImpl: async () => new Response(JSON.stringify({ object: "not-a-model-list" }), { status: 200 }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_payload");
  });
});

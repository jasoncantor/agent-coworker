import type { AgentConfig } from "../types";
import { createOpenAiProxyModelAdapter } from "./modelAdapter";

export const awsBedrockProxyProvider = {
  keyCandidates: ["aws-bedrock-proxy"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createOpenAiProxyModelAdapter(config, modelId, savedKey),
};

/**
 * @deprecated Use awsBedrockProxyProvider instead.
 */
export const openAiProxyProvider = awsBedrockProxyProvider;

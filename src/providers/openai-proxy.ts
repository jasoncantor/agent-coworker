import type { AgentConfig } from "../types";
import { createOpenAiProxyModelAdapter } from "./modelAdapter";

export const openAiProxyProvider = {
  keyCandidates: ["openai-proxy"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createOpenAiProxyModelAdapter(config, modelId, savedKey),
};

import { createBasetenModelAdapter } from "./modelAdapter";
import type { AgentConfig } from "../types";

export const basetenProvider = {
  keyCandidates: ["baseten"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createBasetenModelAdapter(modelId, savedKey),
};

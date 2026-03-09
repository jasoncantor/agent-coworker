import type { AgentConfig, RuntimeName } from "../types";

import { createPiRuntime } from "./piRuntime";
import { createOpenAiResponsesRuntime } from "./openaiResponsesRuntime";

import type { LlmRuntime } from "./types";

export function resolveRuntimeName(config: AgentConfig): RuntimeName {
  return config.runtime ?? "pi";
}

export function createRuntime(config: AgentConfig): LlmRuntime {
  const runtimeName = resolveRuntimeName(config);
  switch (runtimeName) {
    case "pi":
      if (config.provider === "openai" || config.provider === "codex-cli") {
        return createOpenAiResponsesRuntime();
      }
      return createPiRuntime();
  }
}

export * from "./types";

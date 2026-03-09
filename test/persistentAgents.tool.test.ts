import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import {
  createCloseAgentTool,
  createListPersistentAgentsTool,
  createSendAgentInputTool,
  createSpawnPersistentAgentTool,
  createWaitForAgentTool,
} from "../src/tools/persistentAgents";
import type { AgentConfig } from "../src/types";
import type { ToolContext } from "../src/tools/context";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = "/tmp/persistent-agent-tools";
  return {
    provider: "openai",
    model: "gpt-5.2",
    subAgentModel: "gpt-5.2-mini",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    ...overrides,
  };
}

describe("persistent agent tools", () => {
  test("spawnPersistentAgent forwards task and returns the created child session", async () => {
    const spawn = mock(async ({ task, agentType }: { task: string; agentType?: string }) => ({
      sessionId: "child-1",
      parentSessionId: "root-1",
      agentType: agentType ?? "general",
      title: task,
      provider: "openai" as const,
      model: "gpt-5.2-mini",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      status: "active" as const,
      busy: true,
    }));
    const tool: any = createSpawnPersistentAgentTool(makeCtx({
      persistentAgentControl: {
        spawn,
        list: async () => [],
        sendInput: async () => {},
        wait: async () => ({ agentId: "child-1", sessionId: "child-1", status: "running", busy: true }),
        close: async () => ({
          sessionId: "child-1",
          parentSessionId: "root-1",
          agentType: "general",
          title: "child",
          provider: "openai",
          model: "gpt-5.2-mini",
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          status: "closed",
          busy: false,
        }),
      },
    }));

    const result = await tool.execute({ task: "Investigate", agentType: "research" });

    expect(spawn).toHaveBeenCalledWith({ task: "Investigate", agentType: "research" });
    expect(result.sessionId).toBe("child-1");
    expect(result.agentType).toBe("research");
  });

  test("list/send/wait/close tools forward to session-backed controls", async () => {
    const list = mock(async () => [{
      sessionId: "child-1",
      parentSessionId: "root-1",
      agentType: "general" as const,
      title: "Child",
      provider: "openai" as const,
      model: "gpt-5.2-mini",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      status: "active" as const,
      busy: false,
    }]);
    const sendInput = mock(async () => {});
    const wait = mock(async () => ({
      agentId: "child-1",
      sessionId: "child-1",
      status: "completed" as const,
      busy: false,
      text: "done",
    }));
    const close = mock(async () => ({
      sessionId: "child-1",
      parentSessionId: "root-1",
      agentType: "general" as const,
      title: "Child",
      provider: "openai" as const,
      model: "gpt-5.2-mini",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      status: "closed" as const,
      busy: false,
    }));
    const ctx = makeCtx({
      persistentAgentControl: {
        spawn: async () => {
          throw new Error("unused");
        },
        list,
        sendInput,
        wait,
        close,
      },
    });

    const listTool: any = createListPersistentAgentsTool(ctx);
    const sendTool: any = createSendAgentInputTool(ctx);
    const waitTool: any = createWaitForAgentTool(ctx);
    const closeTool: any = createCloseAgentTool(ctx);

    expect(await listTool.execute({})).toHaveLength(1);
    await expect(sendTool.execute({ agentId: "child-1", task: "next step" })).resolves.toEqual({
      agentId: "child-1",
      queued: true,
    });
    await expect(waitTool.execute({ agentId: "child-1", timeoutMs: 10 })).resolves.toEqual({
      agentId: "child-1",
      sessionId: "child-1",
      status: "completed",
      busy: false,
      text: "done",
    });
    await expect(closeTool.execute({ agentId: "child-1" })).resolves.toMatchObject({
      sessionId: "child-1",
      status: "closed",
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith({ agentId: "child-1", task: "next step" });
    expect(wait).toHaveBeenCalledWith({ agentId: "child-1", timeoutMs: 10 });
    expect(close).toHaveBeenCalledWith({ agentId: "child-1" });
  });

  test("tools reject calls when no persistent agent control is available", async () => {
    const tool: any = createSpawnPersistentAgentTool(makeCtx());
    await expect(tool.execute({ task: "Investigate" })).rejects.toThrow(
      "Persistent subagents are unavailable outside a session-backed turn.",
    );
  });
});

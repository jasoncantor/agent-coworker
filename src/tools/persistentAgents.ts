import { z } from "zod";

import { SUBAGENT_AGENT_TYPE_VALUES } from "../shared/persistentSubagents";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function requirePersistentAgentControl(ctx: ToolContext) {
  if (!ctx.persistentAgentControl) {
    throw new Error("Persistent subagents are unavailable outside a session-backed turn.");
  }
  return ctx.persistentAgentControl;
}

export function createSpawnPersistentAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Create a durable subagent session, queue its initial task, and return the child session handle immediately.",
    inputSchema: z.object({
      task: z.string().trim().min(1).max(20_000),
      agentType: z.enum(SUBAGENT_AGENT_TYPE_VALUES).optional().default("general"),
    }),
    execute: async ({ task, agentType }: { task: string; agentType: "explore" | "research" | "general" }) => {
      ctx.log(`tool> spawnPersistentAgent ${JSON.stringify({ agentType })}`);
      const result = await requirePersistentAgentControl(ctx).spawn({ task, agentType });
      ctx.log(`tool< spawnPersistentAgent ${JSON.stringify({ sessionId: result.sessionId })}`);
      return result;
    },
  });
}

export function createListPersistentAgentsTool(ctx: ToolContext) {
  return defineTool({
    description: "List durable child subagent sessions for the current parent session.",
    inputSchema: z.object({}).strict(),
    execute: async () => await requirePersistentAgentControl(ctx).list(),
  });
}

export function createSendAgentInputTool(ctx: ToolContext) {
  return defineTool({
    description: "Send a follow-up task or message to an existing durable subagent session.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
      task: z.string().trim().min(1).max(20_000),
    }),
    execute: async ({ agentId, task }: { agentId: string; task: string }) => {
      ctx.log(`tool> sendAgentInput ${JSON.stringify({ agentId })}`);
      await requirePersistentAgentControl(ctx).sendInput({ agentId, task });
      ctx.log(`tool< sendAgentInput ${JSON.stringify({ agentId })}`);
      return { agentId, queued: true };
    },
  });
}

export function createWaitForAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Wait until a durable subagent session is idle or the timeout elapses, then return its latest status.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
      timeoutMs: z.number().int().min(1).max(300_000).optional(),
    }),
    execute: async ({ agentId, timeoutMs }: { agentId: string; timeoutMs?: number }) =>
      await requirePersistentAgentControl(ctx).wait({ agentId, timeoutMs }),
  });
}

export function createCloseAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Close a durable subagent session without deleting its persisted history.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
    }),
    execute: async ({ agentId }: { agentId: string }) => {
      ctx.log(`tool> closeAgent ${JSON.stringify({ agentId })}`);
      const result = await requirePersistentAgentControl(ctx).close({ agentId });
      ctx.log(`tool< closeAgent ${JSON.stringify({ agentId })}`);
      return result;
    },
  });
}

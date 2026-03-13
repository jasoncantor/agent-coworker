import { z } from "zod";

import { CONVERSATION_SEARCH_MODES } from "../server/conversationSearch";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function requireConversationSearch(ctx: ToolContext) {
  if (!ctx.conversationSearchControl) {
    throw new Error("conversationSearch is unavailable until workspace conversation search is enabled and ready.");
  }
  return ctx.conversationSearchControl;
}

export function createConversationSearchTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Search prior conversations from the current workspace using the local conversation-search index. Returns matching sessions and transcript snippets.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(2_000),
      mode: z.enum(CONVERSATION_SEARCH_MODES).optional().default("semantic"),
      limit: z.number().int().min(1).max(10).optional().default(5),
      offset: z.number().int().min(0).max(5_000).optional().default(0),
    }),
    execute: async ({
      query,
      mode,
      limit,
      offset,
    }: {
      query: string;
      mode: "keyword" | "semantic";
      limit: number;
      offset: number;
    }) => {
      ctx.log(`tool> conversationSearch ${JSON.stringify({ mode, limit, offset })}`);
      const result = await requireConversationSearch(ctx).search({
        query,
        mode,
        limit,
        offset,
      });
      ctx.log(`tool< conversationSearch ${JSON.stringify({ total: result.total, returned: result.results.length })}`);
      return result;
    },
  });
}

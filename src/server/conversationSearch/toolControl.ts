import type { ConversationSearchService } from "./searchService";
import type { ConversationSearchMode, ConversationSearchResponse } from "./types";

export type ConversationSearchToolControl = {
  search: (opts: {
    query: string;
    mode?: ConversationSearchMode;
    limit?: number;
    offset?: number;
  }) => Promise<ConversationSearchResponse>;
};

export function createConversationSearchToolControl(opts: {
  service: ConversationSearchService | null | undefined;
  workspacePath: string;
  enabled: boolean;
}): ConversationSearchToolControl | undefined {
  if (!opts.service) return undefined;
  const service = opts.service;
  if (!service.isToolAvailable(opts.workspacePath, opts.enabled)) return undefined;

  return {
    search: async ({ query, mode = "semantic", limit = 5, offset = 0 }) =>
      await service.search({
        workspacePath: opts.workspacePath,
        enabled: opts.enabled,
        query,
        mode,
        limit,
        offset,
      }),
  };
}

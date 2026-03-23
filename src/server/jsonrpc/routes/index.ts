import { JSONRPC_ERROR_CODES } from "../protocol";

import { createProviderAndMcpRouteHandlers } from "./providerAndMcp";
import { createSessionAndWorkspaceControlRouteHandlers } from "./sessionAndWorkspaceControl";
import { createSkillsMemoryAndWorkspaceBackupRouteHandlers } from "./skillsMemoryAndWorkspaceBackup";
import { createThreadAndTurnRouteHandlers } from "./threadAndTurn";
import type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createJsonRpcRequestRouter(context: JsonRpcRouteContext): JsonRpcRequestHandler {
  const handlers: JsonRpcRequestHandlerMap = {
    ...createThreadAndTurnRouteHandlers(context),
    ...createSessionAndWorkspaceControlRouteHandlers(context),
    ...createProviderAndMcpRouteHandlers(context),
    ...createSkillsMemoryAndWorkspaceBackupRouteHandlers(context),
  };

  return async (ws, message) => {
    const handler = handlers[message.method];
    if (!handler) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.methodNotFound,
        message: `Unknown method: ${message.method}`,
      });
      return;
    }

    await handler(ws, message);
  };
}

import type { AgentConfig } from "../../../types";
import type { ServerEvent } from "../../protocol";
import type { AgentSession } from "../../session/AgentSession";
import { JSONRPC_ERROR_CODES } from "../protocol";

import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type JsonRpcSessionError = Extract<ServerEvent, { type: "error" }>;
type JsonRpcSessionOutcome<T extends ServerEvent> = T | JsonRpcSessionError;

async function captureWorkspaceControlEvent<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<T> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await context.events.capture(
      binding,
      async () => await action(session),
      predicate,
    )
  );
}

async function captureWorkspaceControlOutcome<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T>> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await context.events.capture(
      binding,
      async () => await action(session),
      (event): event is JsonRpcSessionOutcome<T> => predicate(event) || context.utils.isSessionError(event),
    )
  );
}

function sendSessionMutationError(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["send"]>[0],
  id: string | number | null,
  event: JsonRpcSessionError,
) {
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidRequest,
    message: event.message,
  });
}

export function createProviderAndMcpRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/provider/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.emitProviderCatalog(),
        (event): event is Extract<ServerEvent, { type: "provider_catalog" }> => event.type === "provider_catalog",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/authMethods/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        (session) => session.emitProviderAuthMethods(),
        (event): event is Extract<ServerEvent, { type: "provider_auth_methods" }> => event.type === "provider_auth_methods",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/status/refresh": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.refreshProviderStatus(),
        (event): event is Extract<ServerEvent, { type: "provider_status" }> => event.type === "provider_status",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/auth/authorize": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      if (!provider || !methodId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and methodId`,
        });
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.authorizeProviderAuth(provider, methodId),
        (event): event is Extract<ServerEvent, { type: "provider_auth_challenge" | "provider_auth_result" }> => (
          (event.type === "provider_auth_challenge" || event.type === "provider_auth_result")
          && event.provider === provider
          && event.methodId === methodId
        ),
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/auth/logout": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      if (!provider) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider`,
        });
        return;
      }
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.logoutProviderAuth(provider),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result" && event.provider === provider
        ),
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/auth/callback": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      const code = typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
      if (!provider || !methodId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and methodId`,
        });
        return;
      }
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.callbackProviderAuth(provider, methodId, code),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result"
          && event.provider === provider
          && event.methodId === methodId
        ),
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/auth/setApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
      if (!provider || !methodId || !apiKey) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider, methodId, and apiKey`,
        });
        return;
      }
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.setProviderApiKey(provider, methodId, apiKey),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result"
          && event.provider === provider
          && event.methodId === methodId
        ),
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/provider/auth/copyApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const sourceProvider = typeof params.sourceProvider === "string"
        ? params.sourceProvider as AgentConfig["provider"]
        : undefined;
      if (!provider || !sourceProvider) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and sourceProvider`,
        });
        return;
      }
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.copyProviderApiKey(provider, sourceProvider),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result" && event.provider === provider
        ),
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/servers/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.emitMcpServers(),
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/server/upsert": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const server = params.server as any;
      const previousName = typeof params.previousName === "string" ? params.previousName : undefined;
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => {
          await session.upsertMcpServer(server, previousName);
          await session.emitMcpServers();
        },
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/server/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => {
          await session.deleteMcpServer(name);
          await session.emitMcpServers();
        },
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/server/validate": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.validateMcpServer(name),
        (event): event is Extract<ServerEvent, { type: "mcp_server_validation" }> =>
          event.type === "mcp_server_validation" && event.name === name,
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/server/auth/authorize": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.authorizeMcpServerAuth(name),
        (event): event is Extract<ServerEvent, { type: "mcp_server_auth_challenge" | "mcp_server_auth_result" }> => (
          (event.type === "mcp_server_auth_challenge" || event.type === "mcp_server_auth_result")
          && event.name === name
        ),
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/server/auth/callback": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const code = typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.callbackMcpServerAuth(name, code),
        (event): event is Extract<ServerEvent, { type: "mcp_server_auth_result" }> =>
          event.type === "mcp_server_auth_result" && event.name === name,
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/server/auth/setApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => await session.setMcpServerApiKey(name, apiKey),
        (event): event is Extract<ServerEvent, { type: "mcp_server_auth_result" }> =>
          event.type === "mcp_server_auth_result" && event.name === name,
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/mcp/legacy/migrate": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : "workspace";
      const event = await captureWorkspaceControlEvent(
        context,
        cwd,
        async (session) => {
          await session.migrateLegacyMcpServers(scope);
          await session.emitMcpServers();
        },
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}

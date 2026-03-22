import type { AgentConfig } from "../../../types";
import type { ServerEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { projectThreadTurnsFromJournal } from "../threadReadProjector";

import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type JsonRpcSessionError = Extract<ServerEvent, { type: "error" }>;
type JsonRpcTurnStartOutcome =
  | Extract<ServerEvent, { type: "session_busy" }>
  | JsonRpcSessionError;
type JsonRpcTurnSteerOutcome =
  | Extract<ServerEvent, { type: "steer_accepted" }>
  | JsonRpcSessionError;

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

export function createThreadAndTurnRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "thread/start": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const model = typeof params.model === "string" ? params.model : undefined;
      const cwd = typeof params.cwd === "string" && params.cwd.trim()
        ? params.cwd.trim()
        : context.getConfig().workingDirectory;
      const session = context.threads.create({ cwd, provider, model });
      context.threads.subscribe(ws, session.id);
      const thread = context.utils.buildThreadFromSession(session);
      void context.journal.enqueue({
        threadId: session.id,
        ts: new Date().toISOString(),
        eventType: "thread/started",
        turnId: null,
        itemId: null,
        requestId: null,
        payload: { thread },
      }).catch(() => {
        // Best-effort journal persistence.
      });
      context.jsonrpc.sendResult(ws, message.id, { thread });
      context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
    },

    "thread/resume": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const afterSeq = typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq)
        ? Math.max(0, Math.floor(params.afterSeq))
        : 0;
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "thread/resume requires threadId",
        });
        return;
      }
      const binding = context.threads.load(threadId);
      if (!binding?.session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const thread = context.utils.buildThreadFromSession(binding.session);
      if (afterSeq > 0) {
        await context.journal.waitForIdle(threadId);
        binding.session.ensureDisconnectedReplayBuffer();
        context.journal.replay(ws, threadId, afterSeq);
      }
      context.threads.subscribe(
        ws,
        threadId,
        {
          ...(binding.session.activeTurnId
            ? {
                initialActiveTurnId: binding.session.activeTurnId,
                initialAgentText: binding.session.getLatestAssistantText() ?? "",
              }
            : {}),
          ...(afterSeq > 0 ? { drainDisconnectedReplayBuffer: true } : {}),
        },
      );
      context.jsonrpc.sendResult(ws, message.id, { thread });
      context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
    },

    "thread/list": (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;
      const threads = new Map<string, ReturnType<JsonRpcRouteContext["utils"]["buildThreadFromRecord"]>>();
      for (const record of context.threads.listPersisted({ ...(cwd ? { cwd } : {}) })) {
        if (!context.utils.shouldIncludeThreadSummary({
          titleSource: record.titleSource,
          messageCount: record.messageCount,
          hasPendingAsk: record.hasPendingAsk,
          hasPendingApproval: record.hasPendingApproval,
          executionState: record.executionState ?? null,
        })) {
          continue;
        }
        threads.set(record.sessionId, context.utils.buildThreadFromRecord(record));
      }
      for (const session of context.threads.listLiveRoot({ ...(cwd ? { cwd } : {}) })) {
        threads.set(session.id, context.utils.buildThreadFromSession(session));
      }
      context.jsonrpc.sendResult(ws, message.id, {
        threads: [...threads.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      });
    },

    "thread/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "thread/read requires threadId",
        });
        return;
      }
      const snapshot = context.threads.readSnapshot(threadId);
      if (!snapshot) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const binding = context.threads.getLive(threadId);
      const thread = binding?.session
        ? context.utils.buildThreadFromSession(binding.session)
        : context.utils.buildThreadFromRecord(context.threads.getPersisted(threadId)!);
      await context.journal.waitForIdle(threadId);
      const journalEvents = params.includeTurns === true
        ? context.journal.list(threadId)
        : [];
      context.jsonrpc.sendResult(ws, message.id, {
        thread: {
          ...thread,
          ...(params.includeTurns === true ? { turns: projectThreadTurnsFromJournal(journalEvents) } : {}),
        },
        coworkSnapshot: snapshot,
        ...(params.includeTurns === true
          ? { journalTailSeq: journalEvents.at(-1)?.seq ?? 0 }
          : {}),
      });
    },

    "thread/unsubscribe": (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "thread/unsubscribe requires threadId",
        });
        return;
      }
      const status = context.threads.unsubscribe(ws, threadId);
      context.jsonrpc.sendResult(ws, message.id, { status });
      if (status === "unsubscribed") {
        context.jsonrpc.send(ws, {
          method: "thread/closed",
          params: { threadId },
        });
      }
    },

    "turn/start": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const text = context.utils.extractTextInput(params.input);
      const clientMessageId =
        typeof params.clientMessageId === "string" && params.clientMessageId.trim()
          ? params.clientMessageId.trim()
          : undefined;
      if (!threadId || !text) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "turn/start requires threadId and non-empty text input",
        });
        return;
      }
      const binding = context.threads.subscribe(ws, threadId);
      if (!binding?.session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const outcome = await context.events.capture(
        binding,
        () => binding.session!.sendUserMessage(text, clientMessageId),
        (event): event is JsonRpcTurnStartOutcome => (
          (event.type === "session_busy"
            && event.sessionId === binding.session!.id
            && event.busy === true
            && typeof event.turnId === "string"
            && event.turnId.trim().length > 0)
          || context.utils.isSessionError(event)
        ),
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        turn: {
          id: outcome.turnId,
          threadId,
          status: "inProgress",
          items: [],
        },
      });
    },

    "turn/steer": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const text = context.utils.extractTextInput(params.input);
      const clientMessageId =
        typeof params.clientMessageId === "string" && params.clientMessageId.trim()
          ? params.clientMessageId.trim()
          : undefined;
      const expectedTurnId = typeof params.turnId === "string" && params.turnId.trim()
        ? params.turnId.trim()
        : context.threads.getLive(threadId)?.session?.activeTurnId ?? "";
      const session = context.threads.getLive(threadId)?.session;
      if (!session || !text || !expectedTurnId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "turn/steer requires threadId, active turnId, and non-empty text input",
        });
        return;
      }
      const binding = context.threads.getLive(threadId);
      if (!binding) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const outcome = await context.events.capture(
        binding,
        () => session.sendSteerMessage(text, expectedTurnId, clientMessageId),
        (event): event is JsonRpcTurnSteerOutcome => (
          (event.type === "steer_accepted"
            && event.sessionId === session.id
            && event.turnId === expectedTurnId)
          || context.utils.isSessionError(event)
        ),
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        turnId: outcome.turnId,
      });
    },

    "turn/interrupt": (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const session = context.threads.getLive(threadId)?.session;
      if (!session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      session.cancel();
      context.jsonrpc.sendResult(ws, message.id, {});
    },
  };
}

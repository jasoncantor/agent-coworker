import type { ServerEvent } from "../protocol";
import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamReplayRuntime,
} from "../../client/modelStreamReplay";
import {
  mapModelStreamChunk,
  type ModelStreamChunkEvent,
  type ModelStreamRawEvent,
  type ModelStreamUpdate,
} from "../../client/modelStream";
import { parseStructuredToolInput } from "../../shared/structuredInput";

type JsonRpcOutboundMessage =
  | { id: string | number; method: string; params?: unknown }
  | { method: string; params?: unknown };

type CreateJsonRpcLegacyEventProjectorOptions = {
  threadId: string;
  send: (message: JsonRpcOutboundMessage) => void;
  shouldSendNotification?: (method: string) => boolean;
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  onServerRequest?: (request: {
    id: string;
    threadId: string;
    type: "ask" | "approval";
    method: string;
    params: Record<string, unknown>;
  }) => void;
};

type ProjectedReasoningMode = "reasoning" | "summary";
type BufferedReasoningState = {
  itemId: string;
  mode: ProjectedReasoningMode;
  text: string;
  started: boolean;
};

type BufferedToolState = {
  itemId: string;
  name: string;
  args?: unknown;
  inputText: string;
  started: boolean;
};

function makeItemId(prefix: string, seed: string): string {
  return `${prefix}:${seed}`;
}

function readPartString(part: Record<string, unknown> | undefined, key: string): string | null {
  const value = part?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function reasoningModeFromPart(part: Record<string, unknown> | undefined): ProjectedReasoningMode {
  return readPartString(part, "mode") === "summary" ? "summary" : "reasoning";
}

function normalizeTranscriptReplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeReasoningText(text: string): string | null {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolArgsFromInput(inputText: string, existingArgs?: unknown): unknown {
  const parsed = parseStructuredToolInput(inputText);
  const base = isRecord(existingArgs) ? existingArgs : {};
  const { input: _discardInput, ...rest } = base;

  if (isRecord(parsed)) {
    return { ...rest, ...parsed };
  }

  if (Object.keys(rest).length > 0) {
    return { ...rest, input: inputText };
  }

  return { input: inputText };
}

export function createJsonRpcLegacyEventProjector(opts: CreateJsonRpcLegacyEventProjectorOptions) {
  let activeTurnId: string | null = opts.initialActiveTurnId ?? null;
  let lastUserMessageText: string | null = null;
  let lastUserMessageClientMessageId: string | null = null;
  const userItemIdByTurn = new Map<string, string>();
  const agentItemIdByTurn = new Map<string, string>();
  const agentTextByTurn = new Map<string, string>();
  const reasoningByKey = new Map<string, BufferedReasoningState>();
  const reasoningTextsSeenInTurn = new Set<string>();
  const reasoningTextHistoryInTurn: string[] = [];
  const toolByKey = new Map<string, BufferedToolState>();
  const replayRuntime: ModelStreamReplayRuntime = createModelStreamReplayRuntime();
  if (activeTurnId) {
    agentItemIdByTurn.set(activeTurnId, makeItemId("agentMessage", activeTurnId));
    agentTextByTurn.set(activeTurnId, opts.initialAgentText ?? "");
  }

  const shouldSendNotification = (method: string) => opts.shouldSendNotification?.(method) ?? true;
  const sendNotification = (method: string, params?: unknown) => {
    if (!shouldSendNotification(method)) return;
    opts.send({ method, params });
  };

  const handleAsk = (evt: Extract<ServerEvent, { type: "ask" }>) => {
    opts.onServerRequest?.({
      id: evt.requestId,
      threadId: opts.threadId,
      type: "ask",
      method: "item/tool/requestUserInput",
      params: {
        threadId: opts.threadId,
        turnId: activeTurnId,
        requestId: evt.requestId,
        itemId: makeItemId("requestUserInput", evt.requestId),
        question: evt.question,
        options: evt.options,
      },
    });
  };

  const handleApproval = (evt: Extract<ServerEvent, { type: "approval" }>) => {
    opts.onServerRequest?.({
      id: evt.requestId,
      threadId: opts.threadId,
      type: "approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: opts.threadId,
        turnId: activeTurnId,
        requestId: evt.requestId,
        itemId: makeItemId("commandExecution", evt.requestId),
        command: evt.command,
        dangerous: evt.dangerous,
        reason: evt.reasonCode,
      },
    });
  };

  const ensureAgentItemStarted = (turnId: string) => {
    let itemId = agentItemIdByTurn.get(turnId);
    if (itemId) return itemId;
    itemId = makeItemId("agentMessage", turnId);
    agentItemIdByTurn.set(turnId, itemId);
    sendNotification("item/started", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: itemId,
        type: "agentMessage",
        text: agentTextByTurn.get(turnId) ?? "",
      },
    });
    return itemId;
  };

  const reasoningStreamKey = (turnId: string, part: Record<string, unknown> | undefined) =>
    `${turnId}:${readPartString(part, "id") ?? "default"}`;

  const ensureBufferedReasoning = (turnId: string, part: Record<string, unknown> | undefined) => {
    const key = reasoningStreamKey(turnId, part);
    const existing = reasoningByKey.get(key);
    if (existing) {
      existing.mode = reasoningModeFromPart(part);
      return { key, state: existing };
    }
    const next: BufferedReasoningState = {
      itemId: makeItemId("reasoning", `${turnId}:${readPartString(part, "id") ?? crypto.randomUUID()}`),
      mode: reasoningModeFromPart(part),
      text: "",
      started: false,
    };
    reasoningByKey.set(key, next);
    return { key, state: next };
  };

  const startBufferedReasoning = (turnId: string, state: BufferedReasoningState) => {
    if (state.started) return;
    state.started = true;
    sendNotification("item/started", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: state.itemId,
        type: "reasoning",
        mode: state.mode,
        text: "",
      },
    });
  };

  const emitReasoningItem = (
    turnId: string,
    mode: ProjectedReasoningMode,
    text: string,
    itemId = makeItemId("reasoning", `${turnId}:${crypto.randomUUID()}`),
  ) => {
    if (!text.trim()) return false;
    if (hasMatchingStreamedReasoningText(text)) {
      return false;
    }
    if (!agentItemIdByTurn.has(turnId)) {
      sendNotification("item/started", {
        threadId: opts.threadId,
        turnId,
        item: {
          id: itemId,
          type: "reasoning",
          mode,
          text,
        },
      });
    }
    sendNotification("item/completed", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: itemId,
        type: "reasoning",
        mode,
        text,
      },
    });
    return true;
  };

  const flushBufferedReasoning = (turnId: string, key: string) => {
    const state = reasoningByKey.get(key);
    if (!state) return;
    reasoningByKey.delete(key);
    startBufferedReasoning(turnId, state);
    sendNotification("item/completed", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: state.itemId,
        type: "reasoning",
        mode: state.mode,
        text: state.text,
      },
    });
    rememberStreamedReasoningText(state.text);
  };

  const clearReasoningStateForTurn = (turnId: string) => {
    for (const key of reasoningByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        reasoningByKey.delete(key);
      }
    }
  };

  const clearToolStateForTurn = (turnId: string) => {
    for (const key of toolByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        toolByKey.delete(key);
      }
    }
  };

  const clearTurnProjectionState = (turnId: string | null) => {
    if (turnId) {
      clearReasoningStateForTurn(turnId);
      clearToolStateForTurn(turnId);
    } else {
      reasoningByKey.clear();
      toolByKey.clear();
    }
    reasoningTextsSeenInTurn.clear();
    reasoningTextHistoryInTurn.length = 0;
    clearModelStreamReplayRuntime(replayRuntime);
  };

  const rememberStreamedReasoningText = (text: string) => {
    const normalized = normalizeReasoningText(text);
    if (!normalized) return;
    reasoningTextsSeenInTurn.add(normalized);
    reasoningTextHistoryInTurn.push(normalized);
  };

  const hasMatchingStreamedReasoningText = (text: string): boolean => {
    const normalized = normalizeReasoningText(text);
    if (!normalized) return false;
    if (reasoningTextsSeenInTurn.has(normalized)) return true;

    for (const state of reasoningByKey.values()) {
      if (normalizeReasoningText(state.text) === normalized) {
        return true;
      }
    }

    const aggregate = normalizeTranscriptReplayText([
      ...reasoningTextHistoryInTurn,
      ...[...reasoningByKey.values()]
        .map((state) => normalizeReasoningText(state.text))
        .filter((current): current is string => current !== null),
    ].join("\n\n"));
    return Boolean(aggregate && aggregate === normalizeTranscriptReplayText(normalized));
  };

  const toolStreamKey = (turnId: string, key: string) => `${turnId}:${key}`;

  const ensureToolState = (turnId: string, key: string, name: string) => {
    const fullKey = toolStreamKey(turnId, key);
    const existing = toolByKey.get(fullKey);
    if (existing) {
      existing.name = name;
      return { fullKey, state: existing };
    }
    const next: BufferedToolState = {
      itemId: makeItemId("toolCall", `${turnId}:${key}`),
      name,
      inputText: "",
      started: false,
    };
    toolByKey.set(fullKey, next);
    return { fullKey, state: next };
  };

  const emitToolStarted = (turnId: string, state: BufferedToolState) => {
    if (state.started) return;
    state.started = true;
    sendNotification("item/started", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: state.itemId,
        type: "toolCall",
        toolName: state.name,
        state: "input-streaming",
        ...(state.args !== undefined ? { args: state.args } : {}),
      },
    });
  };

  const emitToolCompleted = (
    turnId: string,
    key: string,
    state: BufferedToolState,
    itemState: "output-available" | "output-error" | "output-denied",
    result: unknown,
  ) => {
    sendNotification("item/completed", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: state.itemId,
        type: "toolCall",
        toolName: state.name,
        state: itemState,
        ...(state.args !== undefined ? { args: state.args } : {}),
        result,
      },
    });
    toolByKey.delete(toolStreamKey(turnId, key));
  };

  const handleModelStreamUpdate = (update: ModelStreamUpdate) => {
    if (update.kind === "assistant_delta") {
      if (update.phase === "commentary") return;
      const currentText = update.text;
      const previous = agentTextByTurn.get(update.turnId) ?? "";
      const next = `${previous}${currentText}`;
      agentTextByTurn.set(update.turnId, next);
      const itemId = ensureAgentItemStarted(update.turnId);
      if (currentText) {
        sendNotification("item/agentMessage/delta", {
          threadId: opts.threadId,
          turnId: update.turnId,
          itemId,
          delta: currentText,
        });
      }
      return;
    }

    if (update.kind === "reasoning_start") {
      const { state } = ensureBufferedReasoning(update.turnId, { id: update.streamId, mode: update.mode });
      startBufferedReasoning(update.turnId, state);
      return;
    }

    if (update.kind === "reasoning_delta") {
      const { state } = ensureBufferedReasoning(update.turnId, { id: update.streamId, mode: update.mode });
      startBufferedReasoning(update.turnId, state);
      state.text = `${state.text}${update.text}`;
      if (update.text) {
        sendNotification("item/reasoning/delta", {
          threadId: opts.threadId,
          turnId: update.turnId,
          itemId: state.itemId,
          mode: state.mode,
          delta: update.text,
        });
      }
      return;
    }

    if (update.kind === "reasoning_end") {
      flushBufferedReasoning(update.turnId, `${update.turnId}:${update.streamId}`);
      return;
    }

    if (update.kind === "tool_input_start") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      if (update.args !== undefined) {
        state.args = update.args;
      }
      emitToolStarted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_input_delta") {
      const { state } = ensureToolState(update.turnId, update.key, "tool");
      state.inputText = `${state.inputText}${update.delta}`;
      state.args = normalizeToolArgsFromInput(state.inputText, state.args);
      return;
    }

    if (update.kind === "tool_call") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      if (update.args !== undefined) {
        state.args = update.args;
      }
      emitToolStarted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_result") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      emitToolCompleted(update.turnId, update.key, state, "output-available", update.result);
      return;
    }

    if (update.kind === "tool_error") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      emitToolCompleted(update.turnId, update.key, state, "output-error", { error: update.error });
      return;
    }

    if (update.kind === "tool_output_denied") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      emitToolCompleted(update.turnId, update.key, state, "output-denied", { denied: true, reason: update.reason });
    }
  };

  return {
    handle(event: ServerEvent) {
      if (event.sessionId !== opts.threadId) return;

      switch (event.type) {
        case "user_message":
          lastUserMessageText = event.text;
          lastUserMessageClientMessageId = typeof event.clientMessageId === "string" ? event.clientMessageId : null;
          return;
        case "session_busy":
          if (event.busy) {
            if (activeTurnId && event.turnId && activeTurnId !== event.turnId) {
              clearTurnProjectionState(activeTurnId);
            }
            activeTurnId = event.turnId ?? null;
            if (!activeTurnId) return;
            sendNotification("turn/started", {
              threadId: opts.threadId,
              turn: {
                id: activeTurnId,
                status: "inProgress",
                items: [],
              },
            });
            if (lastUserMessageText) {
              const itemId = makeItemId("userMessage", activeTurnId);
              userItemIdByTurn.set(activeTurnId, itemId);
              sendNotification("item/started", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item: {
                  id: itemId,
                  type: "userMessage",
                  content: [{ type: "text", text: lastUserMessageText }],
                  ...(lastUserMessageClientMessageId ? { clientMessageId: lastUserMessageClientMessageId } : {}),
                },
              });
              sendNotification("item/completed", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item: {
                  id: itemId,
                  type: "userMessage",
                  content: [{ type: "text", text: lastUserMessageText }],
                  ...(lastUserMessageClientMessageId ? { clientMessageId: lastUserMessageClientMessageId } : {}),
                },
              });
              lastUserMessageText = null;
              lastUserMessageClientMessageId = null;
            }
            return;
          }

          if (event.turnId) {
            clearTurnProjectionState(event.turnId);
            sendNotification("turn/completed", {
              threadId: opts.threadId,
              turn: {
                id: event.turnId,
                status:
                  event.outcome === "cancelled"
                    ? "interrupted"
                    : event.outcome === "error"
                      ? "failed"
                      : "completed",
              },
            });
          }
          activeTurnId = null;
          return;
        case "model_stream_raw": {
          const updates = replayModelStreamRawEvent(replayRuntime, event as ModelStreamRawEvent);
          for (const update of updates) {
            handleModelStreamUpdate(update);
          }
          return;
        }
        case "model_stream_chunk":
          if (shouldIgnoreNormalizedChunkForRawBackedTurn(replayRuntime, event as ModelStreamChunkEvent)) {
            return;
          }
          {
            const update = mapModelStreamChunk(event as ModelStreamChunkEvent);
            if (update) {
              handleModelStreamUpdate(update);
            }
          }
          return;
        case "assistant_message":
          if (!activeTurnId) return;
          {
            const itemId = ensureAgentItemStarted(activeTurnId);
            const previousText = agentTextByTurn.get(activeTurnId) ?? "";
            agentTextByTurn.set(activeTurnId, event.text);
            if (!previousText && event.text) {
              sendNotification("item/agentMessage/delta", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                itemId,
                delta: event.text,
              });
            }
            sendNotification("item/completed", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item: {
                id: itemId,
                type: "agentMessage",
                text: event.text,
              },
            });
          }
          return;
        case "reasoning":
          if (!activeTurnId) return;
          emitReasoningItem(activeTurnId, event.kind, event.text, makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`));
          return;
        case "session_settings":
          sendNotification("cowork/session/settings", event);
          return;
        case "session_info":
          sendNotification("cowork/session/info", event);
          return;
        case "config_updated":
          sendNotification("cowork/session/configUpdated", event);
          return;
        case "session_config":
          sendNotification("cowork/session/config", event);
          return;
        case "session_usage":
          sendNotification("cowork/session/usage", event);
          return;
        case "steer_accepted":
          sendNotification("cowork/session/steerAccepted", event);
          return;
        case "turn_usage":
          sendNotification("cowork/session/turnUsage", event);
          return;
        case "budget_warning":
          sendNotification("cowork/session/budgetWarning", event);
          return;
        case "budget_exceeded":
          sendNotification("cowork/session/budgetExceeded", event);
          return;
        case "session_backup_state":
          sendNotification("cowork/session/backupState", event);
          return;
        case "harness_context":
          sendNotification("cowork/session/harnessContext", event);
          return;
        case "agent_list":
          sendNotification("cowork/session/agentList", event);
          return;
        case "agent_spawned":
          sendNotification("cowork/session/agentSpawned", event);
          return;
        case "agent_status":
          sendNotification("cowork/session/agentStatus", event);
          return;
        case "agent_wait_result":
          sendNotification("cowork/session/agentWaitResult", event);
          return;
        case "ask":
          handleAsk(event);
          return;
        case "approval":
          handleApproval(event);
          return;
        case "log":
          sendNotification("cowork/log", event);
          return;
        case "todos":
          sendNotification("cowork/todos", event);
          return;
        case "error":
          sendNotification("error", event);
          return;
        default:
          return;
      }
    },
  };
}

import { describe, expect, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createJsonRpcRequestRouter, type JsonRpcRouteContext } from "../src/server/jsonrpc/routes";

function createRouterHarness() {
  const sent: unknown[] = [];
  const enqueued: unknown[] = [];
  const subscribed: string[] = [];
  const created: Array<{ cwd: string; provider?: string; model?: string }> = [];
  const thread = {
    id: "thread-1",
    title: "Thread 1",
    preview: "",
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd: "C:/project",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    status: {
      type: "loaded" as const,
    },
  };
  const session = { id: thread.id } as any;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "C:/default" } as any),
    threads: {
      create: ({ cwd, provider, model }) => {
        created.push({ cwd, provider, model });
        return session;
      },
      load: () => null,
      getLive: () => undefined,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: (_ws, threadId) => {
        subscribed.push(threadId);
        return null;
      },
      unsubscribe: () => "notSubscribed",
      readSnapshot: () => null,
    },
    workspaceControl: {
      getOrCreateBinding: (() => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
    },
    journal: {
      enqueue: async (event) => {
        enqueued.push(event);
      },
      waitForIdle: async () => {},
      list: () => [],
      replay: () => {},
    },
    events: {
      capture: (async () => {
        throw new Error("not used");
      }) as any,
      captureMutationOutcome: (async () => {
        throw new Error("not used");
      }) as any,
    },
    jsonrpc: {
      send: (_ws, payload) => {
        sent.push(payload);
      },
      sendResult: (_ws, id, result) => {
        sent.push({ id, result });
      },
      sendError: (_ws, id, error) => {
        sent.push({ id, error });
      },
    },
    utils: {
      requireWorkspacePath: () => {
        throw new Error("not used");
      },
      extractTextInput: () => "",
      buildThreadFromSession: () => thread,
      buildThreadFromRecord: () => thread,
      shouldIncludeThreadSummary: () => true,
      buildControlSessionStateEvents: () => [],
      isSessionError: (event): event is Extract<any, { type: "error" }> => event.type === "error",
    },
  };

  return {
    sent,
    enqueued,
    subscribed,
    created,
    thread,
    router: createJsonRpcRequestRouter(context),
  };
}

describe("JSON-RPC request router", () => {
  test("thread/start sends the existing result and started notification envelopes", async () => {
    const harness = createRouterHarness();

    await harness.router({} as any, {
      id: 1,
      method: "thread/start",
      params: {
        cwd: "C:/project",
      },
    });

    expect(harness.created).toEqual([
      {
        cwd: "C:/project",
        provider: undefined,
        model: undefined,
      },
    ]);
    expect(harness.subscribed).toEqual(["thread-1"]);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({
      threadId: "thread-1",
      eventType: "thread/started",
      payload: {
        thread: harness.thread,
      },
    });
    expect(harness.sent).toEqual([
      {
        id: 1,
        result: {
          thread: harness.thread,
        },
      },
      {
        method: "thread/started",
        params: {
          thread: harness.thread,
        },
      },
    ]);
  });

  test("unknown methods return methodNotFound from the router", async () => {
    const harness = createRouterHarness();

    await harness.router({} as any, {
      id: 7,
      method: "cowork/unknown",
    });

    expect(harness.sent).toEqual([
      {
        id: 7,
        error: {
          code: JSONRPC_ERROR_CODES.methodNotFound,
          message: "Unknown method: cowork/unknown",
        },
      },
    ]);
  });
});

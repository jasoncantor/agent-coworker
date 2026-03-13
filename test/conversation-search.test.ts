import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConversationSearchService } from "../src/server/conversationSearch";
import { SessionDb } from "../src/server/sessionDb";
import {
  coworkPaths,
  FakeEmbeddingModelManager,
  waitFor,
} from "./helpers/conversationSearch";

async function makeSearchHarness(opts: { downloadDelayMs?: number } = {}) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-search-test-"));
  const workspaceA = path.join(homeDir, "workspace-a");
  const workspaceB = path.join(homeDir, "workspace-b");
  await fs.mkdir(path.join(workspaceA, ".agent"), { recursive: true });
  await fs.mkdir(path.join(workspaceB, ".agent"), { recursive: true });

  const paths = coworkPaths(homeDir);
  const db = await SessionDb.create({ paths });
  const modelManager = new FakeEmbeddingModelManager({ downloadDelayMs: opts.downloadDelayMs });
  const service = await ConversationSearchService.create({
    paths,
    sessionDb: db,
    pollIntervalMs: 25,
    modelManager: modelManager as any,
  });

  return {
    homeDir,
    workspaceA,
    workspaceB,
    db,
    service,
    modelManager,
    dispose: async () => {
      await service.dispose();
      db.close();
    },
  };
}

function persistRootSession(
  db: SessionDb,
  opts: {
    sessionId: string;
    title: string;
    workingDirectory: string;
    messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
    createdAt?: string;
    updatedAt?: string;
  },
) {
  const createdAt = opts.createdAt ?? opts.updatedAt ?? new Date().toISOString();
  const updatedAt = opts.updatedAt ?? createdAt;
  db.persistSessionMutation({
    sessionId: opts.sessionId,
    eventType: "session.created",
    snapshot: {
      sessionKind: "root",
      parentSessionId: null,
      agentType: null,
      title: opts.title,
      titleSource: "default",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: opts.workingDirectory,
      enableMcp: true,
      backupsEnabledOverride: null,
      createdAt,
      updatedAt,
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: opts.messages,
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  });
}

describe("conversation search service", () => {
  test("registerWorkspace transitions from pending_models to downloading_models to ready", async () => {
    const harness = await makeSearchHarness({ downloadDelayMs: 40 });
    try {
      persistRootSession(harness.db, {
        sessionId: "root-a",
        title: "Workspace A Session",
        workingDirectory: harness.workspaceA,
        messages: [{ role: "assistant", content: "alpha tool search result" }],
      });

      expect((await harness.service.getStatus(harness.workspaceA, true)).availability).toBe("pending_models");

      await harness.service.registerWorkspace(harness.workspaceA, true);

      const downloading = await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "downloading_models",
      );
      expect(downloading.download.status).toBe("running");

      const ready = await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "ready",
        { timeoutMs: 10_000 },
      );
      expect(ready.models.query.status).toBe("ready");
      expect(ready.models.context.status).toBe("ready");
      expect(ready.index.sessionCount).toBe(1);
      expect(ready.index.chunkCount).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  });

  test("cancelModelDownload leaves the workspace pending until models are available", async () => {
    const harness = await makeSearchHarness({ downloadDelayMs: 150 });
    try {
      persistRootSession(harness.db, {
        sessionId: "root-a",
        title: "Workspace A Session",
        workingDirectory: harness.workspaceA,
        messages: [{ role: "assistant", content: "alpha tool search result" }],
      });

      await harness.service.registerWorkspace(harness.workspaceA, true);
      await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "downloading_models",
      );

      await harness.service.cancelModelDownload();

      const cancelled = await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.download.status === "cancelled",
        { timeoutMs: 10_000 },
      );
      expect(cancelled.availability).toBe("pending_models");
    } finally {
      await harness.dispose();
    }
  });

  test("deleteModels clears readiness and rebuildWorkspaceIndex reindexes after models return", async () => {
    const harness = await makeSearchHarness();
    try {
      persistRootSession(harness.db, {
        sessionId: "root-a",
        title: "Workspace A Session",
        workingDirectory: harness.workspaceA,
        messages: [{ role: "assistant", content: "alpha tool search result" }],
      });

      await harness.service.registerWorkspace(harness.workspaceA, true);
      await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "ready",
        { timeoutMs: 10_000 },
      );

      await harness.service.deleteModels();
      const deleted = await harness.service.getStatus(harness.workspaceA, true);
      expect(deleted.models.query.status).toBe("missing");
      expect(deleted.index.sessionCount).toBe(0);
      expect(deleted.index.chunkCount).toBe(0);

      await harness.service.registerWorkspace(harness.workspaceA, true);
      const reenabled = await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "ready",
        { timeoutMs: 10_000 },
      );

      await harness.service.rebuildWorkspaceIndex(harness.workspaceA);
      const rebuilt = await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) =>
          status.index.status === "ready"
          && status.index.lastIndexedAt !== reenabled.index.lastIndexedAt,
        { timeoutMs: 10_000 },
      );
      expect(rebuilt.index.chunkCount).toBeGreaterThan(0);
    } finally {
      await harness.dispose();
    }
  });

  test("notifySessionPersisted incrementally refreshes stale indexed content", async () => {
    const harness = await makeSearchHarness();
    try {
      persistRootSession(harness.db, {
        sessionId: "root-a",
        title: "Workspace A Session",
        workingDirectory: harness.workspaceA,
        messages: [{ role: "assistant", content: "alpha first draft" }],
        updatedAt: "2026-03-13T00:00:00.000Z",
      });

      await harness.service.registerWorkspace(harness.workspaceA, true);
      await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "ready",
        { timeoutMs: 10_000 },
      );

      const before = await harness.service.search({
        workspacePath: harness.workspaceA,
        enabled: true,
        query: "first",
        mode: "keyword",
        offset: 0,
        limit: 10,
      });
      expect(before.total).toBe(1);

      persistRootSession(harness.db, {
        sessionId: "root-a",
        title: "Workspace A Session",
        workingDirectory: harness.workspaceA,
        messages: [{ role: "assistant", content: "alpha second revision" }],
        createdAt: "2026-03-13T00:00:00.000Z",
        updatedAt: "2026-03-13T00:05:00.000Z",
      });

      await harness.service.notifySessionPersisted({
        workspacePath: harness.workspaceA,
        sessionId: "root-a",
      });

      const after = await waitFor(
        async () => {
          try {
            return await harness.service.search({
              workspacePath: harness.workspaceA,
              enabled: true,
              query: "second",
              mode: "keyword",
              offset: 0,
              limit: 10,
            });
          } catch {
            return null;
          }
        },
        (result) => result !== null && result.total === 1,
        { timeoutMs: 10_000 },
      );
      expect(after?.results[0]?.sessionId).toBe("root-a");

      const oldQuery = await harness.service.search({
        workspacePath: harness.workspaceA,
        enabled: true,
        query: "first",
        mode: "keyword",
        offset: 0,
        limit: 10,
      });
      expect(oldQuery.total).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  test("search only returns sessions indexed from the active workspace", async () => {
    const harness = await makeSearchHarness();
    try {
      persistRootSession(harness.db, {
        sessionId: "root-a",
        title: "Workspace A Session",
        workingDirectory: harness.workspaceA,
        messages: [{ role: "assistant", content: "shared alpha query" }],
      });
      persistRootSession(harness.db, {
        sessionId: "root-b",
        title: "Workspace B Session",
        workingDirectory: harness.workspaceB,
        messages: [{ role: "assistant", content: "shared alpha query" }],
      });

      await harness.service.registerWorkspace(harness.workspaceA, true);
      await waitFor(
        () => harness.service.getStatus(harness.workspaceA, true),
        (status) => status.availability === "ready",
        { timeoutMs: 10_000 },
      );

      const results = await harness.service.search({
        workspacePath: harness.workspaceA,
        enabled: true,
        query: "shared alpha",
        mode: "keyword",
        offset: 0,
        limit: 10,
      });

      expect(results.results.some((result) => result.sessionId === "root-a")).toBe(true);
      expect(results.results.some((result) => result.sessionId === "root-b")).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});

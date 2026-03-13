import { Database } from "bun:sqlite";

import type {
  ConversationSearchHit,
  ConversationSearchIndexState,
} from "./types";

type IndexedChunk = {
  chunkId: string;
  sessionId: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  messageIndex: number;
  role: string;
  contentText: string;
  snippetText: string;
  embedding: Float32Array | null;
  embeddingModelId: string | null;
};

type IndexedSession = {
  workspacePath: string;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  chunks: IndexedChunk[];
};

type KeywordChunkMatch = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  hit: ConversationSearchHit;
};

type SemanticChunkCandidate = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  messageIndex: number;
  role: string;
  snippet: string;
  vector: Float32Array;
};

function toNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function blobFromVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function vectorFromBlob(blob: unknown, dims: number): Float32Array {
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : blob instanceof ArrayBuffer
        ? new Uint8Array(blob)
        : new Uint8Array(Buffer.from(String(blob), "binary"));
  const copied = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
  const vector = new Float32Array(copied.buffer);
  if (vector.length !== dims) {
    return new Float32Array(vector.slice(0, dims));
  }
  return vector;
}

export class ConversationSearchIndexStore {
  readonly dbPath: string;

  private readonly db: Database;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath, { create: true, strict: false });
    this.bootstrap();
  }

  close(): void {
    this.db.close();
  }

  clearAll(): void {
    this.db.exec("DELETE FROM embeddings");
    this.db.exec("DELETE FROM chunks_fts");
    this.db.exec("DELETE FROM chunks");
    this.db.exec("DELETE FROM workspace_state");
  }

  replaceWorkspaceSessions(workspacePath: string, sessions: IndexedSession[]): void {
    const run = this.db.transaction((workspacePathInput: string, sessionInputs: IndexedSession[]) => {
      this.deleteWorkspaceRows(workspacePathInput);
      for (const session of sessionInputs) {
        this.insertSession(session);
      }
    });
    run(workspacePath, sessions);
  }

  replaceSession(session: IndexedSession): void {
    const run = this.db.transaction((sessionInput: IndexedSession) => {
      this.deleteSessionRows(sessionInput.sessionId);
      this.insertSession(sessionInput);
    });
    run(session);
  }

  deleteSession(sessionId: string): void {
    const run = this.db.transaction((sessionIdInput: string) => {
      this.deleteSessionRows(sessionIdInput);
    });
    run(sessionId);
  }

  getWorkspaceCounts(workspacePath: string): { sessionCount: number; chunkCount: number } {
    const counts = this.db
      .query(
        `SELECT
           COUNT(DISTINCT session_id) AS session_count,
           COUNT(*) AS chunk_count
         FROM chunks
         WHERE workspace_path = ?`,
      )
      .get(workspacePath) as Record<string, unknown> | null;

    return {
      sessionCount: counts ? toNonNegativeInteger(counts.session_count) : 0,
      chunkCount: counts ? toNonNegativeInteger(counts.chunk_count) : 0,
    };
  }

  getWorkspaceState(workspacePath: string): ConversationSearchIndexState {
    const row = this.db
      .query(
        `SELECT status, session_count, chunk_count, last_indexed_at, last_error, updated_at
         FROM workspace_state
         WHERE workspace_path = ?
         LIMIT 1`,
      )
      .get(workspacePath) as Record<string, unknown> | null;

    if (!row) {
      const counts = this.getWorkspaceCounts(workspacePath);
      return {
        status: counts.chunkCount > 0 ? "ready" : "idle",
        sessionCount: counts.sessionCount,
        chunkCount: counts.chunkCount,
        lastIndexedAt: null,
        lastError: null,
        updatedAt: null,
      };
    }

    return {
      status:
        row.status === "indexing" || row.status === "ready" || row.status === "error"
          ? row.status
          : "idle",
      sessionCount: toNonNegativeInteger(row.session_count),
      chunkCount: toNonNegativeInteger(row.chunk_count),
      lastIndexedAt: typeof row.last_indexed_at === "string" ? row.last_indexed_at : null,
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    };
  }

  setWorkspaceState(workspacePath: string, state: ConversationSearchIndexState): void {
    this.db
      .query(
        `INSERT INTO workspace_state (
           workspace_path,
           status,
           session_count,
           chunk_count,
           last_indexed_at,
           last_error,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_path) DO UPDATE SET
           status = excluded.status,
           session_count = excluded.session_count,
           chunk_count = excluded.chunk_count,
           last_indexed_at = excluded.last_indexed_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        workspacePath,
        state.status,
        state.sessionCount,
        state.chunkCount,
        state.lastIndexedAt,
        state.lastError,
        state.updatedAt,
      );
  }

  searchKeyword(workspacePath: string, matchQuery: string): KeywordChunkMatch[] {
    const rows = this.db
      .query(
        `SELECT
           c.session_id,
           c.title,
           c.created_at,
           c.updated_at,
           c.message_count,
           c.message_index,
           c.role,
           c.snippet_text,
           (-bm25(chunks_fts, 8.0, 1.0)) AS score
         FROM chunks_fts
         JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
         WHERE chunks_fts MATCH ? AND chunks_fts.workspace_path = ?
         ORDER BY score DESC, c.updated_at DESC`,
      )
      .all(matchQuery, workspacePath) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      sessionId: String(row.session_id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: toNonNegativeInteger(row.message_count),
      hit: {
        messageIndex: toNonNegativeInteger(row.message_index),
        role: String(row.role),
        snippet: String(row.snippet_text),
        score: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0,
      },
    }));
  }

  listSemanticCandidates(workspacePath: string): SemanticChunkCandidate[] {
    const rows = this.db
      .query(
        `SELECT
           c.session_id,
           c.title,
           c.created_at,
           c.updated_at,
           c.message_count,
           c.message_index,
           c.role,
           c.snippet_text,
           e.dims,
           e.vector_blob
         FROM chunks c
         JOIN embeddings e ON e.chunk_id = c.chunk_id
         WHERE c.workspace_path = ?
         ORDER BY c.updated_at DESC`,
      )
      .all(workspacePath) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      sessionId: String(row.session_id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      messageCount: toNonNegativeInteger(row.message_count),
      messageIndex: toNonNegativeInteger(row.message_index),
      role: String(row.role),
      snippet: String(row.snippet_text),
      vector: vectorFromBlob(row.vector_blob, toNonNegativeInteger(row.dims)),
    }));
  }

  private bootstrap(): void {
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec("PRAGMA busy_timeout=5000;");

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS chunks (
         chunk_id TEXT PRIMARY KEY,
         workspace_path TEXT NOT NULL,
         session_id TEXT NOT NULL,
         title TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         message_count INTEGER NOT NULL,
         message_index INTEGER NOT NULL,
         role TEXT NOT NULL,
         content_text TEXT NOT NULL,
         snippet_text TEXT NOT NULL
       )`,
    );

    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
         chunk_id UNINDEXED,
         workspace_path UNINDEXED,
         session_id UNINDEXED,
         title,
         content_text
       )`,
    );

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS embeddings (
         chunk_id TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
         model_id TEXT NOT NULL,
         dims INTEGER NOT NULL,
         vector_blob BLOB NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS workspace_state (
         workspace_path TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         session_count INTEGER NOT NULL,
         chunk_count INTEGER NOT NULL,
         last_indexed_at TEXT NULL,
         last_error TEXT NULL,
         updated_at TEXT NULL
       )`,
    );

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_search_chunks_workspace ON chunks(workspace_path, updated_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_search_chunks_session ON chunks(session_id)");
  }

  private insertSession(session: IndexedSession): void {
    for (const chunk of session.chunks) {
      this.db
        .query(
          `INSERT INTO chunks (
             chunk_id,
             workspace_path,
             session_id,
             title,
             created_at,
             updated_at,
             message_count,
             message_index,
             role,
             content_text,
             snippet_text
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.chunkId,
          session.workspacePath,
          session.sessionId,
          session.title,
          session.createdAt,
          session.updatedAt,
          session.messageCount,
          chunk.messageIndex,
          chunk.role,
          chunk.contentText,
          chunk.snippetText,
        );

      this.db
        .query(
          `INSERT INTO chunks_fts (
             chunk_id,
             workspace_path,
             session_id,
             title,
             content_text
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.chunkId,
          session.workspacePath,
          session.sessionId,
          session.title,
          chunk.contentText,
        );

      if (chunk.embedding && chunk.embeddingModelId) {
        this.db
          .query(
            `INSERT INTO embeddings (
               chunk_id,
               model_id,
               dims,
               vector_blob,
               updated_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.chunkId,
            chunk.embeddingModelId,
            chunk.embedding.length,
            blobFromVector(chunk.embedding),
            session.updatedAt,
          );
      }
    }
  }

  private deleteWorkspaceRows(workspacePath: string): void {
    this.db.query("DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE workspace_path = ?)").run(workspacePath);
    this.db.query("DELETE FROM chunks_fts WHERE workspace_path = ?").run(workspacePath);
    this.db.query("DELETE FROM chunks WHERE workspace_path = ?").run(workspacePath);
  }

  private deleteSessionRows(sessionId: string): void {
    this.db.query("DELETE FROM embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE session_id = ?)").run(sessionId);
    this.db.query("DELETE FROM chunks_fts WHERE session_id = ?").run(sessionId);
    this.db.query("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
  }
}

export type {
  IndexedChunk,
  IndexedSession,
  KeywordChunkMatch,
  SemanticChunkCandidate,
};

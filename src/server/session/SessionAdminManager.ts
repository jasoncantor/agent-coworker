import fs from "node:fs/promises";
import path from "node:path";

import type { SubagentAgentType } from "../../shared/persistentSubagents";
import { deletePersistedSessionSnapshot, listPersistedSessionSnapshots } from "../sessionStore";
import type { ConversationSearchMode, ConversationSearchStatusPayload } from "../conversationSearch";
import type { SessionContext } from "./SessionContext";

export class SessionAdminManager {
  constructor(private readonly context: SessionContext) {}

  reset() {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }
    this.context.state.messages = [];
    this.context.state.allMessages = [];
    this.context.state.providerState = null;
    this.context.state.todos = [];
    this.context.emit({ type: "todos", sessionId: this.context.id, todos: [] });
    this.context.emit({ type: "reset_done", sessionId: this.context.id });
    this.context.queuePersistSessionSnapshot("session.reset");
  }

  getMessages(offset = 0, limit = 100) {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    let total = this.context.state.allMessages.length;
    let slice = this.context.state.allMessages.slice(safeOffset, safeOffset + safeLimit);
    if (this.context.deps.sessionDb) {
      const persisted = this.context.deps.sessionDb.getMessages(this.context.id, safeOffset, safeLimit);
      total = persisted.total;
      slice = persisted.messages;
    }
    this.context.emit({
      type: "messages",
      sessionId: this.context.id,
      messages: slice,
      total,
      offset: safeOffset,
      limit: safeLimit,
    });
  }

  async listSessions() {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can list sessions");
      return;
    }
    try {
      const sessions = this.context.deps.sessionDb
        ? this.context.deps.sessionDb.listSessionsByWorkspace(this.context.state.config.workingDirectory)
        : await listPersistedSessionSnapshots(this.context.getCoworkPaths(), {
            workingDirectory: this.context.state.config.workingDirectory,
          });
      this.context.emit({ type: "sessions", sessionId: this.context.id, sessions });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list sessions: ${String(err)}`);
    }
  }

  async getConversationSearchStatus(): Promise<ConversationSearchStatusPayload | null> {
    if (!this.requireRootConversationSearchAccess("inspect conversation search status")) {
      return null;
    }
    const service = this.context.deps.conversationSearchService;
    if (!service) {
      this.context.emitError("internal_error", "session", "Conversation search service is unavailable");
      return null;
    }
    return await service.getStatus(
      this.context.state.config.workingDirectory,
      this.context.state.config.conversationSearchEnabled ?? false,
    );
  }

  async emitConversationSearchStatus() {
    const status = await this.getConversationSearchStatus();
    if (!status) return;
    this.context.emit({
      type: "conversation_search_status",
      sessionId: this.context.id,
      ...status,
    });
  }

  async downloadConversationSearchModels() {
    if (!this.requireRootConversationSearchAccess("download conversation search models")) {
      return;
    }
    const service = this.context.deps.conversationSearchService;
    if (!service) {
      this.context.emitError("internal_error", "session", "Conversation search service is unavailable");
      return;
    }
    try {
      await service.queueModelDownload();
      await this.emitConversationSearchStatus();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to queue conversation search model download: ${String(err)}`);
    }
  }

  async cancelConversationSearchModels() {
    if (!this.requireRootConversationSearchAccess("cancel conversation search model download")) {
      return;
    }
    const service = this.context.deps.conversationSearchService;
    if (!service) {
      this.context.emitError("internal_error", "session", "Conversation search service is unavailable");
      return;
    }
    try {
      await service.cancelModelDownload();
      await this.emitConversationSearchStatus();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to cancel conversation search model download: ${String(err)}`);
    }
  }

  async deleteConversationSearchModels() {
    if (!this.requireRootConversationSearchAccess("delete conversation search models")) {
      return;
    }
    const service = this.context.deps.conversationSearchService;
    if (!service) {
      this.context.emitError("internal_error", "session", "Conversation search service is unavailable");
      return;
    }
    try {
      await service.deleteModels();
      await this.emitConversationSearchStatus();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to delete conversation search models: ${String(err)}`);
    }
  }

  async rebuildConversationSearchIndex(workspacePath?: string) {
    if (!this.requireRootConversationSearchAccess("rebuild conversation search index")) {
      return;
    }
    const resolvedWorkspacePath = this.assertWorkspacePath(workspacePath);
    if (!resolvedWorkspacePath) return;

    const service = this.context.deps.conversationSearchService;
    if (!service) {
      this.context.emitError("internal_error", "session", "Conversation search service is unavailable");
      return;
    }

    try {
      await service.rebuildWorkspaceIndex(resolvedWorkspacePath);
      await this.emitConversationSearchStatus();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to rebuild conversation search index: ${String(err)}`);
    }
  }

  async searchConversations(
    query: string,
    opts: {
      workspacePath?: string;
      mode?: ConversationSearchMode;
      offset?: number;
      limit?: number;
    },
  ) {
    if (!this.requireRootConversationSearchAccess("search conversations")) {
      return;
    }
    const resolvedWorkspacePath = this.assertWorkspacePath(opts.workspacePath);
    if (!resolvedWorkspacePath) return;

    const service = this.context.deps.conversationSearchService;
    if (!service) {
      this.context.emitError("internal_error", "session", "Conversation search service is unavailable");
      return;
    }

    try {
      const result = await service.search({
        workspacePath: resolvedWorkspacePath,
        enabled: this.context.state.config.conversationSearchEnabled ?? false,
        query,
        mode: opts.mode ?? "semantic",
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 10,
      });
      this.context.emit({
        type: "conversation_search_results",
        sessionId: this.context.id,
        ...result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not ready") || message.includes("enabled")) {
        this.context.emitError("validation_failed", "session", message);
        return;
      }
      this.context.emitError("internal_error", "session", `Failed to search conversations: ${message}`);
    }
  }

  async listSubagentSessions() {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can list subagents");
      return;
    }
    if (!this.context.deps.listSubagentSessionsImpl) {
      this.context.emitError("internal_error", "session", "Subagent listing is unavailable");
      return;
    }
    try {
      const subagents = await this.context.deps.listSubagentSessionsImpl(this.context.id);
      this.context.emit({ type: "subagent_sessions", sessionId: this.context.id, subagents });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list subagents: ${String(err)}`);
    }
  }

  async createSubagentSession(agentType: SubagentAgentType, task: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can create subagents");
      return;
    }
    if (!this.context.deps.createSubagentSessionImpl) {
      this.context.emitError("internal_error", "session", "Subagent creation is unavailable");
      return;
    }
    try {
      const subagent = await this.context.deps.createSubagentSessionImpl({
        parentSessionId: this.context.id,
        parentConfig: this.context.state.config,
        agentType,
        task,
      });
      this.context.emit({ type: "subagent_created", sessionId: this.context.id, subagent });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to create subagent: ${String(err)}`);
    }
  }

  async deleteSession(targetSessionId: string) {
    if (targetSessionId === this.context.id) {
      this.context.emitError("validation_failed", "session", "Cannot delete the active session");
      return;
    }
    try {
      if (this.context.deps.deleteSessionImpl) {
        await this.context.deps.deleteSessionImpl({
          requesterSessionId: this.context.id,
          targetSessionId,
        });
      } else if (this.context.deps.sessionDb) {
        this.context.deps.sessionDb.deleteSession(targetSessionId);
      } else {
        const paths = this.context.getCoworkPaths();
        await deletePersistedSessionSnapshot(paths, targetSessionId);
      }
      this.context.emit({ type: "session_deleted", sessionId: this.context.id, targetSessionId });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to delete session: ${String(err)}`);
    }
  }

  async listWorkspaceBackups() {
    await this.runWorkspaceBackupOp(
      "listWorkspaceBackupsImpl",
      "list workspace backups",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async createWorkspaceBackupCheckpoint(targetSessionId: string) {
    await this.runWorkspaceBackupOp(
      "createWorkspaceBackupCheckpointImpl",
      "create workspace checkpoint",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string) {
    await this.runWorkspaceBackupOp(
      "restoreWorkspaceBackupImpl",
      "restore workspace backup",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId, checkpointId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async deleteWorkspaceBackupCheckpoint(targetSessionId: string, checkpointId: string) {
    await this.runWorkspaceBackupOp(
      "deleteWorkspaceBackupCheckpointImpl",
      "delete workspace checkpoint",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId, checkpointId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async deleteWorkspaceBackupEntry(targetSessionId: string) {
    await this.runWorkspaceBackupOp(
      "deleteWorkspaceBackupEntryImpl",
      "delete workspace backup",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async getWorkspaceBackupDelta(targetSessionId: string, checkpointId: string) {
    await this.runWorkspaceBackupOp(
      "getWorkspaceBackupDeltaImpl",
      "inspect workspace backup delta",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId, checkpointId }),
      (delta) => ({ type: "workspace_backup_delta" as const, sessionId: this.context.id, ...delta }),
    );
  }

  private async runWorkspaceBackupOp<K extends keyof import("./SessionContext").SessionDependencies, T>(
    implKey: K,
    label: string,
    execute: (impl: NonNullable<import("./SessionContext").SessionDependencies[K]>) => Promise<T>,
    buildEvent: (result: T) => import("../protocol").ServerEvent,
  ): Promise<void> {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", `Only root sessions can ${label}`);
      return;
    }
    const impl = this.context.deps[implKey];
    if (!impl) {
      this.context.emitError("internal_error", "backup", `Workspace backup operation is unavailable: ${label}`);
      return;
    }
    try {
      const result = await execute(impl);
      this.context.emit(buildEvent(result));
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to ${label}: ${String(err)}`);
    }
  }

  async uploadFile(filename: string, contentBase64: string) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const safeName = path.basename(filename);
    if (!safeName || safeName === "." || safeName === "..") {
      this.context.emitError("validation_failed", "session", "Invalid filename");
      return;
    }

    const MAX_BASE64_SIZE = 10 * 1024 * 1024;
    if (contentBase64.length > MAX_BASE64_SIZE) {
      this.context.emitError("validation_failed", "session", "File too large (max ~7.5MB)");
      return;
    }

    const uploadsDir = this.context.state.config.uploadsDirectory ?? this.context.state.config.workingDirectory;
    const filePath = path.resolve(uploadsDir, safeName);
    if (!filePath.startsWith(path.resolve(uploadsDir))) {
      this.context.emitError("validation_failed", "session", "Invalid filename (path traversal)");
      return;
    }

    try {
      const decoded = Buffer.from(contentBase64, "base64");
      if (this.context.state.config.uploadsDirectory) {
        await fs.mkdir(uploadsDir, { recursive: true });
      }
      await fs.writeFile(filePath, decoded);
      this.context.emit({ type: "file_uploaded", sessionId: this.context.id, filename: safeName, path: filePath });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to upload file: ${String(err)}`);
    }
  }

  private requireRootConversationSearchAccess(action: string): boolean {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", `Only root sessions can ${action}`);
      return false;
    }
    return true;
  }

  private assertWorkspacePath(workspacePath?: string): string | null {
    const activeWorkspacePath = this.context.state.config.workingDirectory;
    if (workspacePath && workspacePath !== activeWorkspacePath) {
      this.context.emitError(
        "validation_failed",
        "session",
        "workspacePath must match the current workspace",
      );
      return null;
    }
    return activeWorkspacePath;
  }
}

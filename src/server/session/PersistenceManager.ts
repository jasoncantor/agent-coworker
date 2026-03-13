import type { AiCoworkerPaths } from "../../connect";
import type { PersistedSessionMutation, SessionDb } from "../sessionDb";
import type { PersistedSessionSnapshot } from "../sessionStore";

export class PersistenceManager {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      sessionId: string;
      sessionDb: SessionDb | null;
      getCoworkPaths: () => AiCoworkerPaths;
      writePersistedSessionSnapshot: (opts: {
        paths: Pick<AiCoworkerPaths, "sessionsDir">;
        snapshot: PersistedSessionSnapshot;
      }) => Promise<string | void>;
      buildCanonicalSnapshot: (updatedAt: string) => PersistedSessionMutation["snapshot"];
      buildPersistedSnapshotAt: (updatedAt: string) => PersistedSessionSnapshot;
      emitTelemetry: (
        name: string,
        status: "ok" | "error",
        attributes?: Record<string, string | number | boolean>,
        durationMs?: number
      ) => void;
      onPersisted?: (snapshot: PersistedSessionMutation["snapshot"]) => Promise<void> | void;
      emitError: (message: string) => void;
      formatError: (err: unknown) => string;
    }
  ) {}

  queuePersistSessionSnapshot(reason: string) {
    const run = async () => {
      const startedAt = Date.now();
      const updatedAt = new Date().toISOString();
      if (this.opts.sessionDb) {
        const snapshot = this.opts.buildCanonicalSnapshot(updatedAt);
        this.opts.sessionDb.persistSessionMutation({
          sessionId: this.opts.sessionId,
          eventType: reason,
          eventTs: updatedAt,
          direction: "system",
          payload: { reason },
          snapshot,
        });
        await this.opts.onPersisted?.(snapshot);
      } else {
        const snapshot = this.opts.buildPersistedSnapshotAt(updatedAt);
        await this.opts.writePersistedSessionSnapshot({
          paths: this.opts.getCoworkPaths(),
          snapshot,
        });
        await this.opts.onPersisted?.({
          sessionKind:
            "sessionKind" in snapshot.session
              ? snapshot.session.sessionKind
              : "root",
          parentSessionId:
            "parentSessionId" in snapshot.session
              ? snapshot.session.parentSessionId
              : null,
          agentType:
            "agentType" in snapshot.session
              ? snapshot.session.agentType
              : null,
          title: snapshot.session.title,
          titleSource: snapshot.session.titleSource,
          titleModel: snapshot.session.titleModel,
          provider: snapshot.session.provider,
          model: snapshot.session.model,
          workingDirectory: snapshot.config.workingDirectory,
          outputDirectory: snapshot.config.outputDirectory,
          uploadsDirectory: snapshot.config.uploadsDirectory,
          enableMcp: snapshot.config.enableMcp,
          backupsEnabledOverride:
            "backupsEnabledOverride" in snapshot.config
              ? snapshot.config.backupsEnabledOverride
              : null,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: snapshot.context.system,
          messages: snapshot.context.messages,
          providerState:
            "providerState" in snapshot.context
              ? snapshot.context.providerState
              : null,
          todos: snapshot.context.todos,
          harnessContext: snapshot.context.harnessContext,
          costTracker:
            "costTracker" in snapshot.context
              ? snapshot.context.costTracker
              : null,
        });
      }
      this.opts.emitTelemetry(
        "session.snapshot.persist",
        "ok",
        { sessionId: this.opts.sessionId, reason },
        Date.now() - startedAt
      );
    };

    this.queue = this.queue
      .catch(() => {
        // keep queue alive after prior failures
      })
      .then(run)
      .catch((err) => {
        this.opts.emitTelemetry(
          "session.snapshot.persist",
          "error",
          { sessionId: this.opts.sessionId, reason, error: this.opts.formatError(err) }
        );
        this.opts.emitError(`Failed to persist session state: ${this.opts.formatError(err)}`);
      });
  }

  async waitForIdle() {
    await this.queue.catch(() => {});
  }
}

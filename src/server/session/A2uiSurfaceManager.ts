import type { ServerEvent } from "../protocol";
import {
  A2UI_PROTOCOL_VERSION,
  applyEnvelope,
  createEmptySurfaces,
  envelopeSurfaceId,
  parseA2uiEnvelope,
  type A2uiEnvelope,
  type A2uiSurfaceState,
  type A2uiSurfacesById,
  type ApplyEnvelopeResult,
} from "../../shared/a2ui";

/**
 * Upper bound on distinct surfaces held per session. When exceeded, the
 * oldest-updated (non-deleted) surface is forcibly deleted with a log line.
 * Keeps memory bounded against misbehaving agents.
 */
const MAX_SURFACES_PER_SESSION = 16;

/**
 * Maximum size (bytes) of the serialized resolved surface we will persist.
 * Larger surfaces are rejected with a structured error.
 */
const MAX_RESOLVED_SURFACE_BYTES = 256 * 1024;

export type A2uiApplyResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  surfaceId?: string;
  change?: ApplyEnvelopeResult["change"];
};

export type A2uiSurfaceManagerDeps = {
  sessionId: string;
  emit: (evt: ServerEvent) => void;
  log?: (line: string) => void;
};

/**
 * Per-session state machine that folds incoming A2UI envelopes into
 * resolved surfaces and broadcasts a matching `a2ui_surface` ServerEvent.
 *
 * The manager is intentionally synchronous — it lives inside the active turn
 * and is invoked from the `a2ui` tool. All state is held in memory; surfaces
 * persist for the lifetime of the session and are cleared on `reset`.
 */
export class A2uiSurfaceManager {
  private surfaces: A2uiSurfacesById = createEmptySurfaces();

  constructor(private readonly deps: A2uiSurfaceManagerDeps) {}

  getSurfaces(): A2uiSurfacesById {
    return this.surfaces;
  }

  /** Replace the entire surfaces map (used when hydrating from persistence). */
  hydrate(surfaces: A2uiSurfacesById | undefined): void {
    this.surfaces = surfaces ? { ...surfaces } : createEmptySurfaces();
  }

  reset(): void {
    // Emit deletion events for any still-active surfaces so clients can
    // flush their local renderers.
    const now = new Date().toISOString();
    for (const [surfaceId, state] of Object.entries(this.surfaces)) {
      if (state.deleted) continue;
      this.deps.emit(this.resolvedEvent({ ...state, deleted: true, updatedAt: now }));
    }
    this.surfaces = createEmptySurfaces();
  }

  /**
   * Apply a single envelope. Returns a structured result that the tool
   * layer can fold into the tool's return value.
   */
  applyEnvelope(envelope: A2uiEnvelope, now = new Date().toISOString()): A2uiApplyResult {
    this.evictIfOverflowing(now);

    const result = applyEnvelope(this.surfaces, envelope, now);
    this.surfaces = { ...result.surfaces };

    const surfaceId = result.surfaceId;
    const state = this.surfaces[surfaceId];

    if (result.change === "noop" || !state) {
      return {
        ok: false,
        error: result.warning ?? "envelope had no effect",
        surfaceId,
        ...(result.change ? { change: result.change } : {}),
      };
    }

    const serialized = safeSerializedLength(state);
    if (serialized > MAX_RESOLVED_SURFACE_BYTES) {
      // Revert by removing the surface so state stays bounded, then report.
      const { [surfaceId]: _removed, ...rest } = this.surfaces;
      this.surfaces = rest;
      this.deps.log?.(
        `[a2ui] rejected surface ${surfaceId}: resolved state ${serialized}B exceeds ${MAX_RESOLVED_SURFACE_BYTES}B cap`,
      );
      return {
        ok: false,
        error: `resolved surface exceeds ${MAX_RESOLVED_SURFACE_BYTES} bytes`,
        surfaceId,
      };
    }

    this.deps.emit(this.resolvedEvent(state));

    return {
      ok: true,
      surfaceId,
      change: result.change,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  /** Apply multiple envelopes and aggregate per-envelope results. */
  applyEnvelopes(envelopes: readonly A2uiEnvelope[]): A2uiApplyResult[] {
    const now = new Date().toISOString();
    return envelopes.map((envelope) => this.applyEnvelope(envelope, now));
  }

  /** Apply a loosely-typed value (JSON string or object) after parsing. */
  applyUnknown(value: unknown): A2uiApplyResult {
    const parsed = parseA2uiEnvelope(value);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    return this.applyEnvelope(parsed.envelope);
  }

  private resolvedEvent(state: A2uiSurfaceState): ServerEvent {
    return {
      type: "a2ui_surface",
      sessionId: this.deps.sessionId,
      surfaceId: state.surfaceId,
      catalogId: state.catalogId,
      version: A2UI_PROTOCOL_VERSION,
      revision: state.revision,
      deleted: state.deleted,
      ...(state.theme ? { theme: { ...state.theme } } : {}),
      ...(state.root ? { root: state.root as unknown as Record<string, unknown> } : {}),
      ...(state.dataModel !== undefined ? { dataModel: state.dataModel } : {}),
      updatedAt: state.updatedAt,
    };
  }

  private evictIfOverflowing(now: string) {
    const ids = Object.keys(this.surfaces);
    if (ids.length < MAX_SURFACES_PER_SESSION) return;

    // Evict oldest non-deleted surface.
    const sorted = ids
      .map((id) => this.surfaces[id]!)
      .filter((state) => !state.deleted)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const victim = sorted[0];
    if (!victim) return;

    this.deps.log?.(`[a2ui] evicting oldest surface ${victim.surfaceId} to stay under cap (${MAX_SURFACES_PER_SESSION})`);
    const next: A2uiSurfaceState = {
      ...victim,
      deleted: true,
      revision: victim.revision + 1,
      updatedAt: now,
    };
    this.surfaces = { ...this.surfaces, [victim.surfaceId]: next };
    this.deps.emit(this.resolvedEvent(next));
  }
}

function safeSerializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export { envelopeSurfaceId };

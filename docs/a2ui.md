# A2UI (Agent-to-UI) Generative UI Support

`agent-coworker` implements the
[A2UI v0.9 protocol](https://a2ui.org/specification/v0.9-a2ui/) for agents to
render rich UI surfaces back to the user, rather than settling for plain
Markdown. This document covers the experimental module. A2UI is intentionally
outside the default harness path and is only active when
`COWORK_EXPERIMENTAL_A2UI=1`.

## Status

- **Phase 1 (experimental):** read-only rendering of A2UI v0.9 surfaces inside
  the desktop main chat view. Agents emit envelopes via a new `a2ui` tool;
  the harness folds them into a resolved surface and broadcasts events over
  the WebSocket protocol. The desktop app renders the v0.9 basic catalog.
- **Phase 2 (experimental):** round-trip interactions. Button clicks, TextField
  submits (on Enter) / blur changes, and Checkbox toggles are dispatched
  over the new `cowork/session/a2ui/action` JSON-RPC method. The harness
  validates the action against the current surface, synthesizes a
  structured user/steer message, and hands it to the running turn (or
  starts a new one).
- **Phase 3 (experimental):**
  - Extended basic-catalog components: `TextArea`, `Select`, `Link`,
    `ProgressBar`, `Badge`, `Table`.
  - Client-side v0.9 **Functions** subset: `if`, `not`, `eq`, `neq`, `and`,
    `or`, `concat`, `length`, `join`, `map`, `coalesce`. The renderer
    resolves prop values through these before stringifying.
  - Desktop surfaces gain an "expand" button that opens the surface in a
    larger Dialog for richer layouts without leaving the chat feed.
  - **Mobile parity:** the Expo app's `SessionFeedItem`/`ProjectedItem`
    schemas learned the new variant, the mobile `snapshotReducer` folds
    `uiSurface` items into its feed, and the new React Native
    `A2uiSurfaceCard` renders the basic catalog. Mobile is read-only for
    this pass — interactive dispatch will follow when the mobile client
    adopts `cowork/session/a2ui/action`.

The feature is not part of the default JSON-RPC schema, default route table, or
default public session config.

## Configuring the feature

The experiment requires the environment gate first:

```sh
COWORK_EXPERIMENTAL_A2UI=1 bun run serve
```

Then enable A2UI for the workspace/session through config:

```json
{ "enableA2ui": true }
```

When both are true, the `a2ui` tool is registered, the experimental action
route is loaded, and supported clients render emitted surfaces inline.

## Architecture

```
agent model
   │  calls tool  a2ui({ envelopes: [...] })
   ▼
TurnExecutionManager (src/server/session/TurnExecutionManager.ts)
   │  ctx.applyA2uiEnvelope(envelope)
   ▼
src/experimental/a2ui/SurfaceManager.ts
   │  applyEnvelope() — pure reducer from src/experimental/a2ui
   │  emit "a2ui_surface" SessionEvent
   ▼
Event fan-out:
   • JSON-RPC projector → item/started + item/completed (uiSurface)
   • Session snapshot   → feed item kind "ui_surface"
   • Persistence        → part of the session's feed, survives reload
   ▼
Desktop A2uiSurfaceCard (apps/desktop/src/ui/chat/a2ui/)
```

The reducer (`src/experimental/a2ui/surface.ts`) is pure TypeScript with no React,
zod side-effects, or server-only dependencies, so the same module can be
reused by any alternative UI (mobile, web, CLI) in the future.

## Source-of-truth files

| Concern | File |
|---|---|
| Envelope zod schema + parser | `src/experimental/a2ui/protocol.ts` |
| Pure reducer (`applyEnvelope`) | `src/experimental/a2ui/surface.ts` |
| Sandboxed binding / `formatString` | `src/experimental/a2ui/expressions.ts` |
| Supported basic-catalog types | `src/experimental/a2ui/component.ts` |
| Session-scoped manager | `src/experimental/a2ui/SurfaceManager.ts` |
| `a2ui` tool | `src/experimental/a2ui/tool.ts` |
| Experimental JSON-RPC action route | `src/experimental/a2ui/routes.ts` |
| Projection into session feed | `src/server/projection/conversationProjection.ts` |
| JSON-RPC notification routing | `src/server/jsonrpc/notificationProjector.ts` |
| Feed item variant | `src/shared/sessionSnapshot.ts` |
| Desktop renderer | `apps/desktop/src/ui/chat/a2ui/` |
| Agent-facing guide | `skills/a2ui/SKILL.md` |

## Server → client event shape

See [`docs/websocket-protocol.md#a2ui_surface-experimental`](./websocket-protocol.md#a2ui_surface-experimental) for the event shape. On the JSON-RPC transport the experimental module projects the event as a `uiSurface` ProjectedItem in the `item/started` / `item/completed` stream.

## Client → server action shape (Phase 2)

When `COWORK_EXPERIMENTAL_A2UI=1` is set, clients may dispatch a JSON-RPC request to `cowork/session/a2ui/action`:

```json
{
  "method": "cowork/session/a2ui/action",
  "params": {
    "threadId": "...",
    "surfaceId": "greeter",
    "componentId": "buy",
    "eventType": "click",
    "payload": { "count": 1 }
  }
}
```

The harness validates the action against the live surface state, then either delivers it as a steer to the running turn or starts a new turn carrying the action as the user message.

The desktop app wires this up automatically for Button, TextField, and Checkbox. The agent sees a structured user/steer message beginning with `[a2ui.action]` and can reply with another `a2ui` tool call to update the surface.

## Security contract

1. **No HTML execution.** The renderer treats every string value as plain
   text. `<script>` tags, `javascript:` URLs, and `onerror` handlers are
   rendered as literal characters.
2. **Restricted image schemes.** `Image.src` values are only honored when
   they are `http:`, `https:`, or `data:` URLs. Anything else falls back to
   a muted placeholder.
3. **Sandboxed bindings.** The expression evaluator (`src/experimental/a2ui/expressions.ts`)
   only supports JSON-pointer lookups and `${...}` template interpolation.
   Arbitrary JS (`new Function`, arithmetic, property access) is not
   supported. Unknown tokens render as empty string.
4. **Bounded state.** Each surface is capped at ~256 KB of resolved JSON,
   and each session may hold at most 16 active surfaces (the oldest
   non-deleted surface is evicted when that cap is exceeded). Envelopes
   over 128 KB are rejected at parse time.
5. **Experiment gate.** If `COWORK_EXPERIMENTAL_A2UI=1` is not set, the tool,
   route, session config fields, and A2UI event path stay out of the default
   harness surface.

## Testing

- `test/a2ui/protocol.test.ts` — envelope parse / version enforcement.
- `test/a2ui/surface.test.ts` — reducer idempotency, data-model patches, delete.
- `test/a2ui/expressions.test.ts` — binding / formatString evaluator.
- `test/a2ui/feedItem.test.ts` — snapshot schema round trip.
- `test/a2ui/surfaceManager.test.ts` — session-scoped manager + event emission.
- `test/a2ui/conversationProjection.test.ts` — projection into the feed.
- `test/tools/a2ui.test.ts` — tool execute path.
- `apps/desktop/test/a2ui-surface-card.test.tsx` — React renderer (RTL-style static markup).

All tests are deterministic and part of the standard `bun test` run.

## Roadmap

Future work (post-Phase 3):

- Mobile client-to-server action dispatch (parity with desktop Phase 2).
- Extended catalog: chart / plot primitives, date pickers, tabs.
- Persist per-workspace theme overrides so surfaces can pick up the user's
  preferred colors without the agent restating them.
- Provider-driven `Function` support: let the server annotate envelopes
  with pre-validated bindings for richer rendering.

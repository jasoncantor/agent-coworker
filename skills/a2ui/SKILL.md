---
name: "a2ui"
description: "Use when you need to render generative UI surfaces — forms, cards, layouts, richer controls — back to the user inside the chat. Available only when the harness enables A2UI (config `enableA2ui: true`). Emit A2UI v0.9 envelopes through the `a2ui` tool."
---

# A2UI Generative UI Skill

Render agent-authored UI surfaces inside the chat using the
[A2UI v0.9 streaming protocol](https://a2ui.org/specification/v0.9-a2ui/).

## When to use

- The user asks for a richer response than plain text (a form, a card, a list
  of options, a layout with headings).
- You want to summarize structured data (tables, KPIs) in a way that scans
  better than markdown.
- The requested information is inherently visual (cards with images, etc.).

Avoid A2UI for pure prose answers. Use it when the shape of the output
warrants a dedicated UI.

## Protocol cheat sheet

Every envelope MUST carry `"version": "v0.9"` and exactly **one** of:

- `createSurface` — create a named surface with a component tree + data model.
- `updateComponents` — upsert components (by id), replace a subtree, or delete components.
- `updateDataModel` — patch the surface's JSON data model at a JSON-pointer path.
- `deleteSurface` — remove a surface.

Send envelopes via the `a2ui` tool:

```json
{
  "envelopes": [
    {
      "version": "v0.9",
      "createSurface": {
        "surfaceId": "order-confirmation",
        "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json",
        "theme": { "primaryColor": "#0f766e" },
        "root": {
          "id": "root",
          "type": "Column",
          "children": [
            { "id": "title",  "type": "Heading", "props": { "text": "Order placed", "level": 2 } },
            { "id": "total",  "type": "Text",    "props": { "text": { "formatString": "Total: $${/amountUsd}" } } },
            { "id": "thanks", "type": "Paragraph", "props": { "text": "We'll email a receipt shortly." } }
          ]
        },
        "dataModel": { "amountUsd": 42.37 }
      }
    }
  ]
}
```

## Supported components (basic catalog v0.9)

The desktop renderer supports these component types out of the box:

| Type | Props we read |
|---|---|
| `Text` / `Paragraph` | `text` (or `value`) |
| `Heading` | `text`, `level` (1–6) |
| `Column` / `Row` / `Stack` | `justify`, `align`, nested `children` |
| `Divider` / `Spacer` | — |
| `Card` | nested `children` |
| `List` | `ordered: boolean`, nested `children` |
| `Button` | `text` / `label` — click dispatches `eventType: "click"` |
| `TextField` | `label`, `placeholder`, `value` — Enter submits, blur changes |
| `TextArea` | `label`, `placeholder`, `value`, `rows` — blur changes |
| `Checkbox` | `label`, `value` — toggle dispatches `change` with `{ value }` |
| `Select` | `label`, `placeholder`, `options: [{ value, label }]`, `value` — change dispatches `change` with `{ value }` |
| `Link` | `text`, `href` (http/https/data) — opens in a new tab |
| `ProgressBar` | `value`, `max`, `label` |
| `Badge` | `text`, `tone` (`default` / `success` / `warning` / `danger`) |
| `Table` | `columns: [{ key, label }]`, `rows: [{ key: value }]` |
| `Image` | `src` (http/https/data), `alt` |

Unknown component types are shown as a diagnostic fallback. If you're
streaming updates for a new component type, include a short `Paragraph`
fallback nearby so the user still sees meaningful content.

The mobile renderer supports the same catalog as a read-only preview for now.

## Dynamic bindings

Props may reference the data model:

- `{ "path": "/user/name" }` — read a value by JSON-pointer.
- `{ "$ref": "/items/0/title" }` — alias for `path`.
- `{ "literal": 42 }` — force the value through literally.
- `{ "formatString": "Hi ${/name}, you have ${/count} items." }` — interpolate
  pointer expressions. Unknown tokens render as empty string.

The renderer does **not** evaluate arbitrary expressions. Stick to plain
JSON-pointer paths inside `${...}`.

### Functions (v0.9)

In addition to plain bindings, prop values may carry a single-key "function
call" object. Supported helpers:

| Helper | Shape | Purpose |
|---|---|---|
| `if` | `{ if: { cond, then, else } }` | branch based on truthiness |
| `not` | `{ not: <value> }` | logical not |
| `eq` / `neq` | `{ eq: [a, b] }` | deep equality |
| `and` / `or` | `{ and: [a, b, …] }` | short-circuit combiners |
| `concat` | `{ concat: [a, b, …] }` | join stringified values |
| `length` | `{ length: <value> }` | length of array / string / object |
| `join` | `{ join: { items, separator } }` | array → string |
| `map` | `{ map: { from, as, template } }` | iterate; `${/${as}/field}` reads the current item |
| `coalesce` | `{ coalesce: [a, b, …] }` | first non-null/empty |

Example using `if` inside a `Text.text`:

```json
{
  "id": "status",
  "type": "Text",
  "props": {
    "text": {
      "if": {
        "cond": { "path": "/online" },
        "then": { "concat": ["Online since ", { "path": "/since" }] },
        "else": "Offline"
      }
    }
  }
}
```

## Security rules

- All text renders as plain text — HTML tags are NOT parsed. Don't try to
  inject `<script>` or `<img onerror=...>`; they render as literal strings.
- `Image` URLs are restricted to `http:`, `https:`, and `data:` schemes.
- The desktop renderer caps component depth and string length to avoid
  runaway surfaces.

## Interaction model

Interactive controls (`Button`, `TextField`, `Checkbox`) now round-trip back
to you when the user interacts with them:

- **Button** — a click fires `eventType: "click"`.
- **TextField** — pressing Enter fires `eventType: "submit"` with
  `payload: { value }`; losing focus after editing fires
  `eventType: "change"` with the current value.
- **Checkbox** — toggling fires `eventType: "change"` with
  `payload: { value: boolean }`.

The harness delivers each action as a structured user/steer message starting
with `[a2ui.action]`. When a turn is already running, the action is folded
in as a steer; otherwise it starts a new turn.

Typical response: emit another `a2ui` tool call to update the surface (e.g.
`updateDataModel` to reflect new state), or reply in plain text.

Use the `ask` tool when you need a modal, blocking question. Use a2ui
surfaces when you want a richer or stateful UI.

## Typical workflow

1. Emit a single `createSurface` envelope with the full tree.
2. When data changes, emit `updateDataModel` to patch a specific path.
3. When structure changes, emit `updateComponents` with the affected
   components (keyed by id).
4. When the surface is no longer needed, emit `deleteSurface`.

Always reuse a stable `surfaceId` across updates so the client replaces the
surface in place rather than creating duplicates.

## Failure handling

The `a2ui` tool returns `{ applied, failed, results: [...] }`. On `failed`
entries, the `error` field explains what was rejected (version mismatch,
unknown surface, resolved-state too large, etc). Read the error and send a
corrective envelope.

## Example: incremental update

```json
// 1) Initial surface
{ "version": "v0.9", "createSurface": { "surfaceId": "counter", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json",
  "root": { "id": "root", "type": "Column", "children": [
    { "id": "label", "type": "Heading", "props": { "text": { "formatString": "Count: ${/count}" }, "level": 2 } }
  ]},
  "dataModel": { "count": 0 }
}}

// 2) After doing some work, bump the counter
{ "version": "v0.9", "updateDataModel": { "surfaceId": "counter", "path": "/count", "value": 3 } }

// 3) Done — tear down.
{ "version": "v0.9", "deleteSurface": { "surfaceId": "counter" } }
```

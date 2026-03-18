# Contributing to agent-coworker

This guide covers everything you need to start contributing to the project.

## Prerequisites

- **[Bun](https://bun.sh/)** v1.x or later (runtime, package manager, and test runner)
- **Node.js** v18+ (some dependencies use Node APIs)
- **Git**
- At least one AI provider credential:
  - **Google** (`GOOGLE_GENERATIVE_AI_API_KEY`) -- default provider
  - **OpenAI** (`OPENAI_API_KEY`)
  - **OpenAI-API Proxy** (`OPENAI_PROXY_BASE_URL` + optional `OPENAI_PROXY_API_KEY`)
  - **Anthropic** (`ANTHROPIC_API_KEY`)
  - Optional: Codex CLI OAuth if you want an OpenAI-backed CLI login flow

## Getting Started

```bash
git clone <repo-url> && cd agent-coworker
bun install                     # installs root + apps/desktop deps

# Run in different modes:
bun run start                   # TUI (default) -- starts server automatically
bun run cli                     # CLI REPL -- connects to server via WebSocket
bun run serve                   # Standalone WebSocket server
bun run tui                     # TUI standalone -- connect to existing server
bun run dev                     # Watch mode (rebuilds on src/ changes)
```

## Architecture Overview

The project follows a **WebSocket-first** pattern. The server manages sessions and agent turns; clients (TUI, CLI REPL, desktop app, or custom clients) are thin consumers of WebSocket events.

```
Client (TUI / CLI / Desktop / Portal)
  |  WebSocket
  v
Server (src/server/)  -->  AgentSession  -->  runTurn()  -->  AI SDK + Tools
```

Key modules:

| Module | Purpose |
|---|---|
| `src/agent.ts` | Core agent loop. `createRunTurn()` factory returns `runTurn()` which calls the Vercel AI SDK `generateText()`. |
| `src/server/` | WebSocket server, session management, protocol types, model streaming. |
| `src/tools/` | Tool factories. Each tool is a file exporting a `create*Tool(ctx)` function. |
| `src/providers/` | Provider registry (`google`, `openai`, `openai-proxy`, `anthropic`, `baseten`, `together`, `nvidia`, `opencode-go`, `opencode-zen`, `codex-cli`). Each exports `defaultModel`, `keyCandidates`, `createModel()`. |
| `src/config.ts` | Config loading with three-tier merge and env var overrides. |
| `src/mcp/` | MCP server config registry, OAuth provider, auth store. |
| `src/skills/` | Skill discovery and trigger extraction. |
| `apps/TUI/` | Default TUI built with OpenTUI + Solid.js (not React). |
| `apps/desktop/` | Tauri desktop app wrapper. |
| `src/cli/` | CLI REPL client. |

## Directory Structure

```
src/
  agent.ts              # Agent turn logic (createRunTurn factory)
  config.ts             # Config loading + deep merge
  connect.ts            # Path resolution for .agent / .cowork directories
  index.ts              # Main entry point (routes to TUI or CLI)
  prompt.ts             # System prompt construction
  types.ts              # Shared TypeScript types
  server/               # WebSocket server, sessions, protocol
  tools/                # Built-in tool factories (bash, read, write, edit, glob, grep, etc.)
  providers/            # AI provider definitions + auth registry
  mcp/                  # MCP server config, OAuth, auth store
  skills/               # Skill loading and trigger extraction
  cli/                  # CLI REPL + arg parsing
  client/               # WebSocket client (AgentSocket)
  harness/              # Evaluation harness
  observability/        # OpenTelemetry + Langfuse integration
  utils/                # Shared utilities
apps/
  TUI/                  # OpenTUI + Solid.js terminal UI
  desktop/              # Tauri desktop app
config/
  defaults.json         # Built-in default configuration
  mcp-servers.json      # System-level MCP server definitions
skills/                 # Built-in skills (doc, pdf, slides, spreadsheet)
prompts/                # System prompts, sub-agent prompts, command templates
scripts/                # Build helpers, doc checker, harness runner
docs/                   # Architecture docs, protocol spec, harness docs
test/                   # All test files (*.test.ts)
```

## Configuration

Configuration uses a **three-tier hierarchy** (each layer overrides the previous):

1. **Built-in**: `config/defaults.json`
2. **User**: `~/.agent/config.json`
3. **Project**: `.agent/config.json` (in working directory)

**Environment variables** override all tiers:

| Variable | Purpose |
|---|---|
| `AGENT_PROVIDER` | Provider name (`google`, `openai`, `openai-proxy`, `anthropic`, `codex-cli`) |
| `AGENT_MODEL` | Model ID override |
| `OPENAI_PROXY_BASE_URL` | OpenAI-compatible proxy base URL (required for `openai-proxy`) |
| `OPENAI_PROXY_API_KEY` | Optional proxy API key fallback when a saved key is not present |
| `AGENT_WORKING_DIR` | Working directory for the agent |
| `AGENT_OUTPUT_DIR` | Output directory for generated files |
| `AGENT_UPLOADS_DIR` | Directory for uploaded files |
| `AGENT_USER_NAME` | User display name |
| `AGENT_ENABLE_MCP` | Enable/disable MCP tool loading |
| `AGENT_OBSERVABILITY_ENABLED` | Enable/disable observability |
| `AGENT_MODEL_MAX_RETRIES` | Max retries for model calls |

The `.cowork/` directory is used for MCP server configs and auth credentials (see MCP section below).

### OpenAI-API Proxy Provider (`openai-proxy`)

- `openai-proxy` is a first-class provider ID in core/server protocol flows (not UI-only).
- It targets an OpenAI-compatible proxy endpoint (for example LiteLLM in front of Bedrock Claude).
- Required config/env:
  - `OPENAI_PROXY_BASE_URL`: proxy base URL (for example `https://proxy.example.com/v1`)
  - `OPENAI_PROXY_API_KEY`: optional env fallback when a saved provider key is not present
- Provider key saves are strict:
  - `provider_auth_set_api_key` validates the submitted token against `<OPENAI_PROXY_BASE_URL>/models` before persisting it.
  - If the proxy URL is missing, or `/models` auth/discovery fails, the key save is rejected.
- Model list is dynamic:
  - Cowork fetches `<OPENAI_PROXY_BASE_URL>/models` for provider catalog population.
  - Claude/Anthropic model IDs are preferred when present.
  - If discovery fails/returns no usable models, Cowork falls back to static provider metadata.
  - The active configured model string is preserved even when not present in discovery results.
- All outbound `openai-proxy` requests always include:
  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 1`
  - This is provider-specific and required for cache behavior in some LiteLLM + Bedrock setups.

## Adding a New Tool

1. Create a new file in `src/tools/`, e.g. `src/tools/myTool.ts`:

```typescript
import { z } from "zod";
import type { ToolContext } from "./context";

export function createMyTool(ctx: ToolContext) {
  return {
    description: "What this tool does",
    parameters: z.object({
      input: z.string().describe("Description of the parameter"),
    }),
    async execute({ input }: { input: string }) {
      // Tool logic here. Use ctx.log(), ctx.askUser(), ctx.approveCommand() as needed.
      return "result";
    },
  };
}
```

2. Register it in `src/tools/index.ts`:

```typescript
import { createMyTool } from "./myTool";

export function createTools(ctx: ToolContext): Record<string, any> {
  return {
    // ... existing tools
    myTool: createMyTool(ctx),
  };
}
```

The `ToolContext` interface (defined in `src/tools/context.ts`) provides:
- `config` -- current `AgentConfig`
- `log(line)` -- emit log output
- `askUser(question, options?)` -- ask the user a question (returns a promise)
- `approveCommand(command)` -- request approval for a risky command
- `updateTodos?(todos)` -- update the todo list
- `abortSignal?` -- abort signal for the active turn

## Adding a WebSocket Message

Follow these four steps whenever you add a new client message or server event:

1. **Add the type** to `ClientMessage` or `ServerEvent` in `src/server/protocol.ts`.
2. **Add validation** in `safeParseClientMessage()` (same file) if it is a client message.
3. **Add the handler** in `src/server/startServer.ts` (message routing) and/or `src/server/session.ts` (session logic).
4. **Update `docs/websocket-protocol.md`** with the new message format, fields, example JSON, and where it fits in the flow.

The protocol doc is the source of truth for anyone building an alternative UI.

## Writing Skills

Skills live in `skills/` directories (built-in, user `~/.agent/skills/`, or project `.agent/skills/`).

Each skill is a directory containing a `SKILL.md` file with YAML front-matter:

```markdown
---
name: "my-skill"
description: "What this skill does (max 1024 chars)"
---

# My Skill

Instructions for the agent when this skill is active...
```

Front-matter fields:
- **`name`** (required) -- kebab-case, must match the directory name
- **`description`** (required) -- max 1024 characters
- **`triggers`** (optional) -- conditions that auto-activate the skill
- **`allowed-tools`** (optional) -- restrict which tools the skill can use
- **`license`** (optional) -- license identifier
- **`compatibility`** (optional) -- version constraints
- **`metadata`** (optional) -- arbitrary key-value pairs

Skills can optionally include an `agents/` subdirectory with YAML files for interface metadata.

## MCP Server Configuration

MCP (Model Context Protocol) servers extend the agent with external tools.

**Config locations:**
- **Workspace**: `.cowork/mcp-servers.json` (in project root)
- **User**: `~/.cowork/config/mcp-servers.json`
- **System**: `config/mcp-servers.json` (built-in)

**Auth modes:** `none`, `api_key`, `oauth`

Credentials are stored separately from server configs:
- **Workspace auth**: `.cowork/auth/`
- **User auth**: `~/.cowork/auth/`

**Tool namespacing:** MCP tools are exposed to the agent as `mcp__{serverName}__{toolName}`.

## Testing

Tests use **Bun's built-in test runner** and live in the `test/` directory.

```bash
bun test                        # Run all tests
bun test test/agent             # Run tests matching a pattern
bun test test/tools.test.ts     # Run a specific test file
```

Key testing patterns:
- **Dependency injection factories** -- `createRunTurn()`, `createTools()`, and tool factories accept injectable dependencies so you can mock AI SDK calls without patching modules.
- **No network calls** -- Tests should not make real API calls. Use the DI factories to inject fake model responses.
- **Test files follow `*.test.ts` naming** -- Place them in `test/` alongside related test files.

Opt-in live proxy cache verification:

```bash
RUN_LIVE_API_TESTS=1 \
OPENAI_PROXY_TEST_BASE_URL="https://proxy.example.com/v1" \
OPENAI_PROXY_TEST_API_KEY="..." \
OPENAI_PROXY_TEST_MODEL="anthropic.claude-3-5-sonnet-20241022-v2:0" \
bun test test/providers/openai-proxy-cache.integration.test.ts
```

This test sends the same long prompt twice through the proxy and only reports a cache pass when the second response has stronger explicit cache-hit telemetry (for example `cachedPromptTokens`, `cacheRead`, or equivalent fields). If telemetry is missing, it reports **inconclusive** instead of claiming cache success.

## Commits & PRs

- **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- **Always run tests** before pushing: `bun test`
- **Focused PRs**: Keep pull requests small and focused on a single concern.
- **TypeScript strict mode** is the primary code quality check (`tsc --noEmit` via tsconfig). There is no linter or formatter configured.

## Useful References

- [`docs/websocket-protocol.md`](docs/websocket-protocol.md) -- WebSocket message format and flow
- [`docs/session-storage-architecture.md`](docs/session-storage-architecture.md) -- Session persistence design
- [`CLAUDE.md`](CLAUDE.md) -- Repository assistant notes and architecture context
- [`apps/TUI/docs/opentui.md`](apps/TUI/docs/opentui.md) -- OpenTUI framework documentation

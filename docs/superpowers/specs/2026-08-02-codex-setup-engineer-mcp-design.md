# Codex Setup Engineer MCP Bridge Design

## Goal

Let the Experiments Setup Engineer use the installed, ChatGPT-authenticated Codex CLI while executing the same session-bound RaceIQ tools as Mastra-backed providers. A successful Codex response must correspond to real setup files or snapshots, experiment-version rows, action rows, and head updates—not text that merely claims those effects.

## Problem

The Codex provider currently takes the provider-native chat path:

1. `runAiChat()` selects `CodexProviderAdapter.createChatResponse()`.
2. `createCodexChatResponse()` flattens the system prompt and messages into stdin for `codex exec --json --ephemeral`.
3. `parseCodexJsonl()` extracts the final `agent_message` only.
4. The Mastra `agent.stream()` callback never runs, so Codex never receives `preview_change`, `apply_changes`, or the other Setup Engineer tools.

Codex CLI supports application-defined tools through MCP. Mastra's `@mastra/mcp` package can expose existing Mastra tools through `MCPServer`; a custom AI SDK model provider is therefore unnecessary.

## Scope

In scope:

- Codex CLI turns in the Experiments Setup Engineer and Driver Coach chat.
- A per-turn stdio MCP server exposing the same tools as the selected Mastra specialist.
- Session binding that the model cannot forge or omit.
- Codex JSONL parsing for MCP tool lifecycle events and deterministic mutation status.
- Existing detached chat execution, persistence, setup-file guards, confirmation guards, action logging, WebSocket refreshes, and undo behavior.

Out of scope:

- Converting Codex CLI into a general AI SDK `LanguageModel` implementation.
- Giving Codex arbitrary database, HTTP, filesystem, or shell tools.
- Changing Gemini, OpenAI API, or Local/LM Studio execution.
- Writing persistent MCP configuration into the user's repository or global Codex config.
- Relaxing the existing propose-then-confirm safety rule for setup mutations.

## Architecture

### Shared session-bound tool construction

Keep one implementation of every tool. Extend the tool builders with an injectable context resolver:

```ts
type SetupEngineerContextResolver = (executionContext: unknown) => {
  gameId: GameId;
  sessionId: number;
};

buildSetupEngineerTools(contextResolver = mastraRequestContextResolver)
```

The existing `setupEngineerTools` singleton uses the default resolver and keeps reading `gameId` and `sessionId` from Mastra `requestContext`. The MCP entry point builds another toolset whose resolver reads validated process environment supplied by RaceIQ when launching that turn.

Neither MCP tool schema accepts `sessionId` or `gameId`. Codex cannot select another experiment. Invalid or missing bound context fails before any tool reads or mutates state.

Apply the same pattern to Driver Coach tools so focus routing retains its current authority split:

- Car focus exposes only Setup Engineer tools.
- Driver focus exposes only Driver Coach tools.

The exposed allowlist must exactly mirror each agent's existing `tools` object. Deterministically gathered read context remains in the system prompt; MCP does not reintroduce removed read tools unless they are already in that agent allowlist.

### Per-turn stdio MCP server

Add a small runtime entry point that:

1. validates `RACEIQ_GAME_ID`, `RACEIQ_EXPERIMENT_ID`, and `DATA_DIR`;
2. selects the specialist tool allowlist from `RACEIQ_EXPERIMENT_FOCUS`;
3. constructs `MCPServer` from `@mastra/mcp` with those bound tools only;
4. calls `startStdio()`;
5. writes diagnostics to stderr only, preserving stdout for MCP framing.

The entry point imports tool modules and database helpers directly. It must not import `mastra/index.ts` or open the DuckDB observability store; this preserves the repository's single-writer observability invariant. LibSQL/SQLite uses the same resolved `DATA_DIR` as the parent server.

### Scoped Codex launch

Extend the Codex subprocess options with an optional RaceIQ MCP launch descriptor. Normal Codex analysis and ordinary text chat remain unchanged.

For a tool-using experiment turn, launch `codex exec` with a complete one-off `mcp_servers` inline table containing one `raceiq` stdio server. A launch-level characterization test must prove that this override suppresses inherited MCP servers before implementation relies on it. Configuration includes:

- absolute Bun/runtime executable and MCP entry-point paths;
- absolute working directory;
- bound session environment;
- `enabled_tools` matching the selected specialist;
- non-interactive approval for only those RaceIQ tools;
- read-only Codex filesystem sandbox, because state mutation belongs to guarded RaceIQ tools.

Do not run `codex mcp add`, write `.codex/config.toml`, or mutate `~/.codex/config.toml`. The process continues using the user's existing Codex login. If the CLI merges inherited MCP entries despite the complete-table override, launch from an isolated temporary `CODEX_HOME` containing only the required authentication state and RaceIQ config; clean it after the process exits.

### Turn flow

```text
POST experiment chat
  -> load experiment and focus
  -> persist user message
  -> gather deterministic session context
  -> snapshot current experiment action/version state
  -> launch Codex with scoped RaceIQ MCP server
  -> Codex calls preview/action tools through MCP
  -> existing handlers write setup/version/action/head state
  -> existing WebSocket notification refreshes open version trees
  -> Codex receives exact tool results and writes final answer
  -> RaceIQ parses JSONL, persists response and tool metadata
  -> response stream completes
```

Tool results, not model prose, remain authoritative. `apply_changes` continues posting its deterministic applied-change summary to chat and returning exact generated version/file data. The final Codex answer may describe only labels returned by tool results.

### Multiple requested branches

Keep the existing safety contract:

- A goal such as "more downforce" is not an exact confirmed change set. Codex previews concrete components and magnitudes, then asks for confirmation.
- After the driver confirms two distinct proposals, Codex may call `apply_changes` once for each confirmed variant, both with `target: "v1"`.
- Repeated calls with identical inputs remain forbidden.
- Each successful tool result supplies the exact branch label; Codex must not infer labels.

Clarify the agent instruction that the one-action rule prevents unrequested or duplicate mutations, not multiple distinct variants explicitly requested and confirmed by the driver.

## JSONL and UI behavior

Replace final-message-only parsing with an incremental parser that recognizes:

- MCP tool start;
- MCP tool completion or failure;
- final agent message;
- turn completion and usage.

Normalize recognized MCP events into provider-neutral tool activity records. Where the installed Codex version includes arguments/results, convert them to AI SDK tool-call/tool-result UI parts. Regardless of event-detail availability, derive mutation status from RaceIQ's action/version state after the turn; never infer mutation success from assistant text.

The response metadata records the deterministic turn outcome:

- created/restored/deleted version IDs and labels;
- resulting head version;
- no mutation;
- tool failure.

A Codex turn with no successful mutation must not manufacture a setup-action card. Existing deterministic chat messages from mutating handlers remain reload-safe.

## Failure handling

- MCP startup failure: fail the turn with actionable Codex/MCP diagnostics; do not fall back to text-only Codex chat.
- Missing or invalid session environment: MCP server exits before exposing tools.
- Tool validation failure: return the tool's structured error to Codex; preserve existing state.
- Codex timeout or abort: terminate Codex and its MCP child process group; completed tool mutations remain logged and undoable.
- Codex non-zero exit after a completed mutation: reload authoritative action/version state and report partial completion instead of claiming nothing happened.
- Malformed MCP JSONL: preserve bounded diagnostics and authoritative database state; never replay the turn automatically because a mutating tool may already have committed.
- Duplicate HTTP post: retain the existing detached-run registry so only one Codex/MCP process executes for a thread.

## Security

- RaceIQ binds session identity outside model-controlled arguments.
- Codex receives only the selected specialist's allowlisted tools.
- Built-in filesystem execution stays read-only for these turns.
- Existing `driverConfirmed`, path traversal, no-op, component-grounding, and target-version checks stay inside tool handlers.
- MCP process receives no API keys. Codex authentication remains owned by the installed CLI.
- No global or project Codex configuration is persisted.

## Verification

### Automated contracts

1. Context binding: MCP calls cannot supply or override experiment/game identity.
2. Tool parity: MCP and Mastra specialist allowlists match exactly.
3. Direct MCP tool call: a confirmed `apply_changes` call creates the setup output, child version, action row, head update, and deterministic chat summary in disposable data.
4. Two-branch regression: two distinct confirmed variants targeting `v1` create two distinct children with exact returned labels and different applied changes.
5. No-tool regression: Codex final text alone creates no version/action and produces no mutation metadata.
6. Failure/abort: completed mutations remain observable and undoable; uncompleted calls leave no phantom version.
7. Provider isolation: Gemini/OpenAI/Local continue through Mastra unchanged; ordinary Codex chat remains text-only where no application tools are required.
8. JSONL characterization: fixtures cover actual Codex MCP start/completion/failure event shapes and forward-compatible unknown-event handling.

### Smoke verification

Using disposable `DATA_DIR` and a seeded experiment:

1. send the original two-variant request;
2. observe two concrete proposals and confirmation request;
3. confirm both;
4. observe two real children under `v1` in the version tree;
5. verify setup files/snapshots, action rows, exact labels, head, chat tool activity, and reload persistence;
6. undo each action and verify state reverses correctly.

Use a fake Codex executable for deterministic automated tests. Run one real authenticated Codex CLI smoke turn after those tests pass; never require subscription access in the permanent suite.

## Documentation references

- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Codex configuration: https://learn.chatgpt.com/docs/config-file/config-basic
- Mastra MCP overview: https://mastra.ai/docs/mcp/overview
- Mastra `MCPServer`: https://mastra.ai/reference/tools/mcp-server

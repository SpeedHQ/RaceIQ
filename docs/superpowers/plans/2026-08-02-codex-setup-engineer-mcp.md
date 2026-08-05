# Codex Setup Engineer MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ChatGPT-authenticated Codex CLI turns the same guarded, session-bound Setup Engineer and Driver Coach tools as Mastra providers, with real branch mutations, live tool activity, reload persistence, and no text-only false success.

**Architecture:** Keep Codex CLI as the agent runtime and expose existing Mastra tools through a per-turn `@mastra/mcp` stdio server. Bind experiment identity in server environment, isolate Codex from inherited MCP servers through one-off disable overrides, translate Codex JSONL MCP events into AI SDK UI chunks, and derive mutation status from experiment database state.

**Tech Stack:** Bun, TypeScript, Mastra Core 1.55, `@mastra/mcp` 1.15, Codex CLI JSONL/MCP, AI SDK 7 UI streams, LibSQL/Drizzle, Bun test.

## Global Constraints

- Preserve installed Codex CLI and ChatGPT subscription authentication; never require `OPENAI_API_KEY`.
- Do not use Mastra `OpenAISDKAgent`: it wraps OpenAI Agents SDK and uses API-key billing, not the installed Codex CLI.
- Never persist RaceIQ MCP configuration in `.codex/config.toml` or `~/.codex/config.toml`.
- Disable every inherited enabled MCP server for each tool-using Codex turn; expose one nonce-named RaceIQ server only.
- Never put `gameId` or `sessionId` in model-controlled tool schemas.
- MCP tool implementations and Mastra agent tool implementations must be the same objects from the same builders.
- MCP entry must not import `mastra/index.ts` or initialize DuckDB observability.
- Existing mutation, confirmation, target, no-op, and path guards remain authoritative.
- Goal-only setup requests still preview concrete changes and require a later explicit confirmation.
- Gemini, OpenAI API, Local/LM Studio, analysis, and non-experiment Codex paths remain behaviorally unchanged.

---

### Task 1: Session-Bound Specialist Tool Factories

**Files:**
- Modify: `mastra/tools/setup-engineer-request-context.ts`
- Modify: `mastra/tools/setup-engineer.ts`
- Modify: `mastra/tools/driver-coach.ts`
- Create: `mastra/tools/experiment-specialist-tools.ts`
- Modify: `mastra/agents/setup-engineer.ts`
- Modify: `mastra/agents/driver-coach.ts`
- Modify: `test/setup-engineer-tools.test.ts`
- Create: `test/experiment-specialist-tools.test.ts`

**Interfaces:**
- Produces: `ExperimentContextResolver`, `requestContextResolver`, `boundExperimentContext(context)`.
- Produces: `buildSetupEngineerAgentTools(resolver?)`, `buildDriverCoachAgentTools(resolver?)`.
- Produces: `buildExperimentSpecialistTools(focus, resolver)` and `EXPERIMENT_SPECIALIST_TOOL_NAMES`.
- Consumes: existing `SetupEngineerRequestContext`, `ExperimentFocus`, and all current tool implementations.

- [ ] **Step 1: Add failing context-binding and tool-parity tests**

Add these contracts to `test/setup-engineer-tools.test.ts` and new `test/experiment-specialist-tools.test.ts`:

```ts
const bound = boundExperimentContext({ gameId: "acc", sessionId: 61 });
expect(bound({ requestContext: ctx({ gameId: "ac-evo", sessionId: 999 }) })).toEqual({
  gameId: "acc",
  sessionId: 61,
});

expect(EXPERIMENT_SPECIALIST_TOOL_NAMES.car).toEqual([
  "consult_lap_analyst", "compare_lap_consistency", "preview_change",
  "apply_changes", "set_lap_excluded", "update_notes",
  "record_driver_notes", "delete_version", "undo_last_action",
  "list_laps", "get_lap_detail", "get_lap_issues", "compare_laps",
]);
expect(EXPERIMENT_SPECIALIST_TOOL_NAMES.driver).toEqual([
  "consult_lap_analyst", "compare_lap_consistency", "record_drill",
  "set_lap_excluded", "update_notes", "record_driver_notes",
  "list_laps", "get_lap_detail", "get_lap_issues", "compare_laps",
]);

const carTools = buildExperimentSpecialistTools("car", bound);
expect(Object.keys(carTools)).toEqual(EXPERIMENT_SPECIALIST_TOOL_NAMES.car);
for (const tool of Object.values(carTools)) {
  expect("sessionId" in (tool.inputSchema as z.ZodObject<any>).shape).toBe(false);
  expect("gameId" in (tool.inputSchema as z.ZodObject<any>).shape).toBe(false);
}
```

Also assert driver tools contain no `preview_change`, `apply_changes`, or `delete_version`.

- [ ] **Step 2: Run tests and confirm factory imports fail**

Run:

```bash
DATA_DIR="$PWD/.data-test" bun test test/setup-engineer-tools.test.ts test/experiment-specialist-tools.test.ts --timeout 30000
```

Expected: FAIL because resolver/factory exports do not exist.

- [ ] **Step 3: Add injectable context resolver**

Add to `setup-engineer-request-context.ts`:

```ts
export interface ExperimentToolExecutionContext {
  requestContext?: RequestContextLike;
}

export type ExperimentContextResolver = (
  executionContext: ExperimentToolExecutionContext,
) => SetupEngineerRequestContext;

export const requestContextResolver: ExperimentContextResolver = (executionContext) =>
  readSetupEngineerContext(executionContext.requestContext);

export function boundExperimentContext(
  context: SetupEngineerRequestContext,
): ExperimentContextResolver {
  const bound = readSetupEngineerContext({ get: (key) => context[key as keyof typeof context] });
  return () => bound;
}
```

Validation happens once when binding. A model-supplied `requestContext` can never override the closure.

- [ ] **Step 4: Parameterize both existing tool builders**

Change builder signatures:

```ts
export function buildSetupEngineerTools(
  resolveContext: ExperimentContextResolver = requestContextResolver,
) { /* existing tools */ }

export function buildDriverCoachTools(
  resolveContext: ExperimentContextResolver = requestContextResolver,
) { /* existing tools */ }
```

Inside every tool `execute`, replace:

```ts
readSetupEngineerContext(execCtx.requestContext)
```

with:

```ts
resolveContext(execCtx as ExperimentToolExecutionContext)
```

Keep singleton exports for compatibility:

```ts
export const setupEngineerTools = buildSetupEngineerTools();
export const driverCoachTools = buildDriverCoachTools();
```

- [ ] **Step 5: Centralize snake-case agent/MCP allowlists**

In each tool module, add a mapping function over a supplied builder result. In `experiment-specialist-tools.ts`, expose one focus dispatcher:

```ts
export const EXPERIMENT_SPECIALIST_TOOL_NAMES = {
  car: [/* exact car list from Step 1 */],
  driver: [/* exact driver list from Step 1 */],
} as const;

export function buildExperimentSpecialistTools(
  focus: ExperimentFocus,
  resolver: ExperimentContextResolver = requestContextResolver,
) {
  return focus === "driver"
    ? buildDriverCoachAgentTools(resolver)
    : buildSetupEngineerAgentTools(resolver);
}
```

Update both agent definitions to use these returned objects instead of inline maps:

```ts
tools: buildSetupEngineerAgentTools(),
```

and:

```ts
tools: buildDriverCoachAgentTools(),
```

- [ ] **Step 6: Run focused tool tests**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit tool factory cutover**

```bash
git add mastra/tools/setup-engineer-request-context.ts mastra/tools/setup-engineer.ts mastra/tools/driver-coach.ts mastra/tools/experiment-specialist-tools.ts mastra/agents/setup-engineer.ts mastra/agents/driver-coach.ts test/setup-engineer-tools.test.ts test/experiment-specialist-tools.test.ts
git commit -m "refactor(ai): share experiment tool factories"
```

---

### Task 2: Stdio MCP Runtime and Production Entry

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `server/mcp/experiment-tools-runtime.ts`
- Create: `server/mcp/experiment-tools-server.ts`
- Modify: `server/bootstrap.ts`
- Create: `test/experiment-tools-mcp.test.ts`

**Interfaces:**
- Consumes: `buildExperimentSpecialistTools(focus, boundExperimentContext(context))` from Task 1.
- Produces from runtime module: `parseExperimentMcpEnvironment(env)`, `buildBoundExperimentTools(environment)`, `createExperimentToolsMcpServer(environment)`.
- Produces from launcher module: `startExperimentToolsMcpServer(environment)`.
- Produces executable mode: `raceiq --experiment-tools-mcp` in compiled builds and `bun server/mcp/experiment-tools-server.ts` in development.

- [ ] **Step 1: Install compatible MCP package**

Run:

```bash
bun add @mastra/mcp@^1.15.0
```

Expected: `package.json` contains `@mastra/mcp`; lockfile resolves a peer-compatible version with `@mastra/core@1.55.x`.

- [ ] **Step 2: Write failing environment and allowlist tests**

Create `test/experiment-tools-mcp.test.ts` with these contracts:

```ts
expect(() => parseExperimentMcpEnvironment({})).toThrow("RACEIQ_GAME_ID");
expect(() => parseExperimentMcpEnvironment({
  RACEIQ_GAME_ID: "acc",
  RACEIQ_EXPERIMENT_ID: "not-a-number",
  RACEIQ_EXPERIMENT_FOCUS: "car",
  DATA_DIR: "/tmp/data",
})).toThrow("RACEIQ_EXPERIMENT_ID");

const parsed = parseExperimentMcpEnvironment({
  RACEIQ_GAME_ID: "acc",
  RACEIQ_EXPERIMENT_ID: "61",
  RACEIQ_EXPERIMENT_FOCUS: "driver",
  DATA_DIR: "/tmp/data",
});
expect(parsed).toMatchObject({ gameId: "acc", sessionId: 61, focus: "driver" });

const tools = buildBoundExperimentTools(parsed);
expect(Object.keys(tools)).toEqual(EXPERIMENT_SPECIALIST_TOOL_NAMES.driver);
```

- [ ] **Step 3: Run test and confirm MCP module is missing**

```bash
DATA_DIR="$PWD/.data-test" bun test test/experiment-tools-mcp.test.ts --timeout 30000
```

Expected: FAIL because server module does not exist.

- [ ] **Step 4: Implement validated runtime and protocol-safe launcher**

Create `server/mcp/experiment-tools-runtime.ts` around this contract:

```ts
const EnvironmentSchema = z.object({
  RACEIQ_GAME_ID: z.string().min(1),
  RACEIQ_EXPERIMENT_ID: z.coerce.number().int().positive(),
  RACEIQ_EXPERIMENT_FOCUS: z.enum(["car", "driver"]),
  DATA_DIR: z.string().min(1),
});

export function parseExperimentMcpEnvironment(env: Record<string, string | undefined>) {
  const value = EnvironmentSchema.parse(env);
  return {
    gameId: value.RACEIQ_GAME_ID as GameId,
    sessionId: value.RACEIQ_EXPERIMENT_ID,
    focus: value.RACEIQ_EXPERIMENT_FOCUS,
    dataDir: value.DATA_DIR,
  };
}

export function buildBoundExperimentTools(environment: ExperimentMcpEnvironment) {
  const resolver = boundExperimentContext({
    gameId: environment.gameId,
    sessionId: environment.sessionId,
  });
  return buildExperimentSpecialistTools(environment.focus, resolver);
}

export function createExperimentToolsMcpServer(environment: ExperimentMcpEnvironment) {
  return new MCPServer({
    name: "RaceIQ Experiment Tools",
    version: "1.0.0",
    tools: buildBoundExperimentTools(environment),
  });
}
```

Create `server/mcp/experiment-tools-server.ts` as the protocol-safe launcher. Before dynamically importing `experiment-tools-runtime.ts`, database modules, or tool modules, redirect `console.log`, `console.info`, and `console.debug` to stderr. Then validate environment, call `initDb()`, create the server, and `await server.startStdio()`. Guard direct source execution with `import.meta.main`. stdout remains MCP framing only.

- [ ] **Step 5: Dispatch compiled binary before importing normal server**

Change `server/bootstrap.ts` final dispatch:

```ts
if (process.argv.includes("--experiment-tools-mcp")) {
  const { startExperimentToolsMcpServer } = await import("./mcp/experiment-tools-server");
  await startExperimentToolsMcpServer(process.env);
} else {
  await import("./index");
}
```

Keep existing fatal crash handling around both modes. Dev server commands remain unchanged; development MCP launches the source entry directly with Bun.

- [ ] **Step 6: Add stdio protocol parity test**

Use `MCPClient` in the same test to spawn the source entry with a valid bound environment, call `listTools()`, and always `await client.disconnect()` in `finally`. Assert namespaced tools equal the focus allowlist and neither `gameId` nor `sessionId` exists in their input schemas.

- [ ] **Step 7: Run MCP tests**

Run the Step 3 command. Expected: PASS, child process exits cleanly after disconnect.

- [ ] **Step 8: Commit MCP runtime**

```bash
git add package.json bun.lock server/mcp/experiment-tools-runtime.ts server/mcp/experiment-tools-server.ts server/bootstrap.ts test/experiment-tools-mcp.test.ts
git commit -m "feat(ai): expose experiment tools over MCP"
```

---

### Task 3: Scoped Codex Launch and Incremental MCP Events

**Files:**
- Create: `server/ai/codex-mcp-config.ts`
- Modify: `server/ai/providers.ts`
- Modify: `server/ai/provider-adapters.ts`
- Modify: `server/ai/ai-types.ts`
- Modify: `test/codex-provider.test.ts`

**Interfaces:**
- Consumes: MCP executable mode from Task 2.
- Produces: `CodexExperimentMcpOptions`, `CodexMcpToolCall`, `CodexTurnEvent`.
- Produces: `listEnabledCodexMcpServers(options)`, `buildCodexExperimentArgs(session, inheritedServers, nonce)`.
- Extends: `CodexCliOptions` with `signal?`, `experimentMcp?`, and `onEvent?`.
- Extends: `CodexResult` with ordered `toolCalls`.

- [ ] **Step 1: Add failing Codex isolation and parser tests**

Extend `test/codex-provider.test.ts` with a fake executable that handles two invocations:

```sh
if [ "$1" = "mcp" ]; then
  printf '%s\n' '[{"name":"github","enabled":true},{"name":"node_repl","enabled":true}]'
  exit 0
fi
printf '%s\n' "$@" > "$CODEX_ARGS_FILE"
cat > "$CODEX_STDIN_FILE"
printf '%s\n' "$CODEX_MCP_JSONL"
```

Assert experiment mode:

```ts
expect(args).toContain("mcp_servers.github.enabled=false");
expect(args).toContain("mcp_servers.node_repl.enabled=false");
expect(args.join("\n")).toContain("mcp_servers.raceiq_turn_");
expect(args.join("\n")).toContain("default_tools_approval_mode=\"approve\"");
expect(args.join("\n")).toContain("sandbox_mode=\"read-only\"");
expect(args.join("\n")).toContain("features.shell_tool=false");
```

Add JSONL fixtures using Codex's canonical event shape:

```ts
{ type: "item.started", item: {
  id: "call-1", type: "mcp_tool_call", server: "raceiq_turn_abc",
  tool: "apply_changes", arguments: { target: "v1" }, result: null,
  error: null, status: "in_progress",
} }
{ type: "item.completed", item: {
  id: "call-1", type: "mcp_tool_call", server: "raceiq_turn_abc",
  tool: "apply_changes", arguments: { target: "v1" },
  result: { content: [], structured_content: { ok: true, version: 2, label: "v1.1" } },
  error: null, status: "completed",
} }
```

Assert start/completion callbacks arrive in order and `parseCodexJsonl()` returns one completed tool call with structured output. Add failed-tool and unknown-event fixtures.

- [ ] **Step 2: Run provider tests and confirm missing MCP options/events**

```bash
DATA_DIR="$PWD/.data-test" bun test test/codex-provider.test.ts --timeout 30000
```

Expected: FAIL on missing types/config/event fields.

- [ ] **Step 3: Implement effective-server discovery and one-off overrides**

In `codex-mcp-config.ts`, define:

```ts
export interface CodexExperimentMcpOptions {
  gameId: GameId;
  sessionId: number;
  focus: ExperimentFocus;
  dataDir: string;
}
```

`listEnabledCodexMcpServers()` runs:

```text
codex mcp list --json
```

with the same executable/environment/timeout guard as other Codex calls. Reject malformed/non-array output. `buildCodexExperimentArgs()` must:

1. generate `raceiq_turn_${nonce.replaceAll("-", "")}`;
2. add `-c mcp_servers.<name>.enabled=false` for every enabled inherited server;
3. configure the nonce server's command, args, cwd, environment, exact `enabled_tools`, and `default_tools_approval_mode="approve"`;
4. add `-c sandbox_mode="read-only"`, `-c approval_policy="never"`, and `-c features.shell_tool=false` before `exec`;
5. use the compiled binary plus `--experiment-tools-mcp` when `IS_COMPILED`, otherwise Bun plus the absolute source entry path.

Never log the complete environment or config arguments.

- [ ] **Step 4: Stream stdout lines and support aborts**

Refactor `runCodexProcess()` to consume stdout through a `TextDecoderStream`, split complete lines, invoke `onStdoutLine(line)` immediately, and retain raw stdout for compatibility. Race timeout, `AbortSignal`, and process exit; both timeout and abort terminate the detached process group exactly once.

Add:

```ts
export type CodexMcpToolCall = {
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
  status: "in_progress" | "completed" | "failed";
  output?: unknown;
  error?: string;
};

export type CodexTurnEvent =
  | { type: "tool-start"; call: CodexMcpToolCall }
  | { type: "tool-complete"; call: CodexMcpToolCall }
  | { type: "assistant-message"; text: string }
  | { type: "turn-complete"; usage: { inputTokens: number; outputTokens: number } };
```

Only recognize MCP calls whose `server` equals the nonce server for this turn.

- [ ] **Step 5: Preserve ordinary Codex behavior**

`runCodexCli()` performs MCP discovery/configuration only when `options.experimentMcp` is present. Existing analysis, structured generation, status, and normal chat argument arrays remain byte-for-byte compatible with their tests.

Thread `experimentMcp` and `signal` through `ChatRequest` and `CodexProviderAdapter.createChatResponse()` without changing other adapters.

- [ ] **Step 6: Run provider tests**

Run the Step 2 command. Expected: PASS, including existing timeout/process-tree and ordinary argument tests.

- [ ] **Step 7: Commit Codex launch support**

```bash
git add server/ai/codex-mcp-config.ts server/ai/providers.ts server/ai/provider-adapters.ts server/ai/ai-types.ts test/codex-provider.test.ts
git commit -m "feat(ai): launch Codex with scoped MCP tools"
```

---

### Task 4: Detached Tool-Aware Chat Stream and Persistence

**Files:**
- Modify: `server/ai/codex-chat-stream.ts`
- Modify: `server/ai/chat-agent.ts`
- Create: `server/ai/experiment-turn-outcome.ts`
- Modify: `server/ai/chat-run-registry.ts`
- Modify: `test/codex-chat-stream.test.ts`
- Create: `test/experiment-turn-outcome.test.ts`
- Modify: `test/tune-chat-message.test.ts`

**Interfaces:**
- Consumes: incremental `CodexTurnEvent` and scoped MCP options from Task 3.
- Produces: `ExperimentTurnSnapshot`, `ExperimentMutationOutcome`, `captureExperimentTurnSnapshot(id)`, `diffExperimentTurnSnapshots(before, after)`.
- Produces: `saveAssistantUIMessage(threadId, { text, parts, metadata })`.
- Produces: `startDetachedCodexTurn(run, options)`; removes synchronous final-text-only response construction.

- [ ] **Step 1: Add failing mutation-outcome tests**

In `test/experiment-turn-outcome.test.ts`, construct snapshots and assert:

```ts
expect(diffExperimentTurnSnapshots(before, before)).toEqual({
  status: "none",
  actions: [],
  versions: [],
  headVersionId: before.headVersionId,
});

expect(diffExperimentTurnSnapshots(before, after)).toEqual({
  status: "mutated",
  actions: [{ id: 42, kind: "apply-changes" }],
  versions: [{ id: 9, label: "v1.1", status: "pending", change: "created" }],
  headVersionId: 9,
});
```

Cover deleted/restored status transitions and an action committed before a later provider failure.

- [ ] **Step 2: Add failing UI stream tests**

Update `test/codex-chat-stream.test.ts` so the fake Codex emits MCP start/completion before final text. Reserve a `ChatRun`, start the Codex turn, consume `buildReplayStream(run)`, and expect:

```ts
expect(chunks.map((chunk) => chunk.type)).toEqual([
  "start",
  "tool-input-start", "tool-input-available", "tool-output-available",
  "text-start", "text-delta", "text-end",
  "finish",
]);
```

Assert tool chunks use `dynamic: true`, `providerExecuted: true`, exact arguments, and exact structured output. Add failure output and aborted-run cases.

- [ ] **Step 3: Run tests and confirm detached/tool APIs are absent**

```bash
DATA_DIR="$PWD/.data-test" bun test test/codex-chat-stream.test.ts test/experiment-turn-outcome.test.ts test/tune-chat-message.test.ts --timeout 30000
```

Expected: FAIL on missing snapshot, persistence, and detached stream APIs.

- [ ] **Step 4: Implement authoritative mutation snapshots**

`captureExperimentTurnSnapshot()` reads `listActions(id)`, `listExperimentVersions(id, { includeDeleted: true })`, and `getExperiment(id)`. Store maps keyed by ID plus `headVersionId`. `diffExperimentTurnSnapshots()` reports:

- actions whose IDs were absent before;
- newly created versions;
- existing versions whose status changed to or from `deleted`;
- final head;
- `status: "none"` only when all three mutation collections are empty and head is unchanged.

Do not infer any mutation from model text.

- [ ] **Step 5: Add full UI-message persistence helper**

In `chat-agent.ts`, add:

```ts
export async function saveAssistantUIMessage(
  threadId: string,
  message: {
    text: string;
    parts: Array<TextUIPart | DynamicToolUIPart>;
    metadata: Record<string, unknown>;
  },
): Promise<string>
```

Persist Mastra message content with `format: 2`, exact `parts`, flat `content: message.text`, and metadata. Do not mark the model response `deterministic`; that flag remains reserved for handler-generated notes. Extend the round-trip test to prove dynamic tool parts and mutation metadata survive the same MessageList/GET conversion used by experiment chat.

- [ ] **Step 6: Emit Codex tool lifecycle into ChatRun**

Replace `createCodexChatResponse()` with a detached starter that:

1. pushes `start` immediately;
2. maps `tool-start` to `tool-input-start` plus `tool-input-available`;
3. maps success to `tool-output-available` and failure to `tool-output-error`;
4. maps final assistant text to text chunks;
5. captures the final mutation snapshot and persists one assistant UI message containing ordered dynamic-tool parts plus text;
6. pushes `finish` and calls `finishRun()`;
7. on provider failure, captures/persists partial mutation outcome, pushes an `error` chunk, then finishes;
8. passes `run.abortController.signal` to Codex.

Use MCP item ID as `toolCallId`. Prefer `result.structured_content`; fall back to `result.content`. Never create a success tool chunk from assistant prose.

- [ ] **Step 7: Run detached stream and persistence tests**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 8: Commit detached stream support**

```bash
git add server/ai/codex-chat-stream.ts server/ai/chat-agent.ts server/ai/experiment-turn-outcome.ts server/ai/chat-run-registry.ts test/codex-chat-stream.test.ts test/experiment-turn-outcome.test.ts test/tune-chat-message.test.ts
git commit -m "feat(ai): stream and persist Codex tool calls"
```

---

### Task 5: Experiment Route Cutover and Multi-Branch Contract

**Files:**
- Modify: `server/routes/tune-chat-routes.ts`
- Modify: `server/ai/model-provider.ts`
- Modify: `mastra/agents/setup-engineer.ts`
- Modify: `test/codex-chat-stream.test.ts`
- Modify: `test/tune-chat-prompt.test.ts`
- Create: `test/codex-experiment-chat.test.ts`

**Interfaces:**
- Consumes: `ChatRun`, `CodexExperimentMcpOptions`, detached Codex starter, and mutation snapshots from Tasks 3–4.
- Produces: one duplicate-safe route path shared by native Codex and Mastra providers.

- [ ] **Step 1: Add failing route-level regression tests**

Create `test/codex-experiment-chat.test.ts` around a fake Codex executable and seeded experiment. Cover:

1. duplicate POSTs for the same thread cause one fake `exec` invocation;
2. `focus: "car"` config exposes the car allowlist;
3. `focus: "driver"` config exposes the driver allowlist and no car mutation tools;
4. final assistant text without MCP events creates no version/action and persists `mutation.status: "none"`;
5. completed MCP mutation events persist tool parts and authoritative mutation metadata;
6. provider failure after a committed action reports partial mutation rather than “nothing happened.”

- [ ] **Step 2: Add failing prompt contract test for two confirmed variants**

Add to `test/tune-chat-prompt.test.ts`:

```ts
expect(SETUP_ENGINEER_INSTRUCTIONS).toContain(
  "one apply_changes call for each distinct variant explicitly requested and confirmed",
);
expect(SETUP_ENGINEER_INSTRUCTIONS).toContain(
  "Repeated calls with identical inputs are forbidden",
);
```

Retain assertions that goal-only variants require preview plus a later confirmation.

- [ ] **Step 3: Run route and prompt regressions**

```bash
DATA_DIR="$PWD/.data-test" bun test test/codex-experiment-chat.test.ts test/tune-chat-prompt.test.ts --timeout 30000
```

Expected: FAIL because Codex route bypasses run reservation and prompt still says one instruction equals one action.

- [ ] **Step 4: Reserve detached run before provider dispatch**

In the POST route, reserve once before `runAiChat()`:

```ts
const { run, isNew } = reserveChatRun(threadId);
if (!isNew) return replayResponse(run);
```

Pass this run to both paths. Mastra starts its current `agent.stream()` into the reserved run. Codex starts `startDetachedCodexTurn()` with:

```ts
experimentMcp: {
  gameId,
  sessionId: id,
  focus,
  dataDir: resolveDataDir(),
},
before: await captureExperimentTurnSnapshot(id),
```

Return `buildReplayStream(run)` immediately with the same `x-resumable-stream-id` header for both providers. `runAiChat()` must no longer let native chat execute before the route reserves the run.

If startup fails before a detached task exists, call `finishRun(run)` before returning the 500 response.

- [ ] **Step 5: Clarify multiple-variant prompt rules**

Replace the contradictory absolute one-action wording with:

```text
One confirmed distinct variant = one mutating tool call. If the driver explicitly
requests and later confirms N different variants, make exactly N apply_changes
calls, one per variant, using the requested common target. Repeated calls with
identical inputs are forbidden. Never add an unrequested “also try” variant.
```

Keep the explicit post-proposal confirmation requirement and exact returned-label rule unchanged.

- [ ] **Step 6: Run route and prompt regressions**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 7: Run provider isolation regressions**

```bash
DATA_DIR="$PWD/.data-test" bun test test/codex-provider.test.ts test/codex-chat-stream.test.ts test/tune-chat-message.test.ts test/setup-engineer-tools.test.ts test/setup-engineer-apply-guard.test.ts --timeout 30000
```

Expected: PASS; existing Gemini/OpenAI/Local tests remain unchanged.

- [ ] **Step 8: Commit route cutover**

```bash
git add server/routes/tune-chat-routes.ts server/ai/model-provider.ts mastra/agents/setup-engineer.ts test/codex-chat-stream.test.ts test/tune-chat-prompt.test.ts test/codex-experiment-chat.test.ts
git commit -m "fix(ai): execute Codex experiment tools"
```

---

### Task 6: Real MCP Branch Regression and Smoke Verification

**Files:**
- Modify: `test/experiment-tools-mcp.test.ts`
- Modify: `test/codex-experiment-chat.test.ts`
- Modify only if user-visible wording changed: `CHANGELOG.md`

**Interfaces:**
- Consumes all prior task contracts.
- Produces end-to-end proof that two confirmed variants become two real sibling versions and remain undoable.

- [ ] **Step 1: Seed a disposable ACC experiment with a real setup file**

In `test/experiment-tools-mcp.test.ts`, write a valid ACC JSON setup under `process.env.DATA_DIR`, create experiment `focus: "car"`, create `v1` with that setup path, and set it as head. Use the existing `baseAccSetup()` shape from Setup Engineer tests.

- [ ] **Step 2: Call two confirmed variants through stdio MCP**

Through `MCPClient`, invoke namespaced `apply_changes` twice:

```ts
const downforce = await apply.execute!({
  target: "v1",
  driverConfirmed: true,
  goal: "more downforce for steering response",
  changes: [
    { component: "Front Wing", direction: "increase", magnitude: "small", reason: "front response" },
    { component: "Rear Wing", direction: "increase", magnitude: "small", reason: "aero stability" },
  ],
}, {} as any);

const stable = await apply.execute!({
  target: "v1",
  driverConfirmed: true,
  goal: "less oversteer",
  changes: [
    { component: "Rear Anti-Roll Bar", direction: "decrease", magnitude: "small", reason: "rear grip" },
  ],
}, {} as any);
```

Assert both return `ok: true`, labels differ, and neither label was inferred by the test.

- [ ] **Step 3: Verify durable branch effects**

Assert:

- two new version rows are children of the original `v1` ID;
- `appliedChanges` differ and match each requested variant;
- generated setup files exist and contain changed values;
- two `apply-changes` action rows exist;
- session head equals the second returned version;
- deterministic applied-change chat summaries contain exact returned labels;
- disconnect/reconnect and chat reload preserve both branches/tool parts.

- [ ] **Step 4: Verify undo reverses each mutation**

Call the existing undo path twice. Assert newest child/head reverses first, then the first child, with no orphan setup/version state beyond the repository's existing soft-delete rules.

- [ ] **Step 5: Run the complete focused bridge suite**

```bash
DATA_DIR="$PWD/.data-test" bun test \
  test/experiment-specialist-tools.test.ts \
  test/experiment-tools-mcp.test.ts \
  test/experiment-turn-outcome.test.ts \
  test/codex-provider.test.ts \
  test/codex-chat-stream.test.ts \
  test/codex-experiment-chat.test.ts \
  test/tune-chat-message.test.ts \
  test/tune-chat-prompt.test.ts \
  test/setup-engineer-tools.test.ts \
  test/setup-engineer-apply-guard.test.ts \
  test/experiment-undo.test.ts \
  --timeout 30000
```

Expected: all focused tests pass.

- [ ] **Step 6: Build compiled binary and smoke MCP mode**

```bash
bun run build
```

Then start `dist/raceiq --experiment-tools-mcp` through an MCP client with disposable bound environment. Expected: tool list succeeds, no HTTP server/caffeinate/DuckDB startup messages appear on stdout, and disconnect exits cleanly.

- [ ] **Step 7: Run one authenticated Codex CLI smoke turn**

With disposable `DATA_DIR` and seeded experiment:

1. send original two-goal request;
2. verify Codex calls preview tools and asks for concrete confirmation without creating versions;
3. confirm both proposals;
4. verify two `apply_changes` MCP calls and two sibling children under `v1`;
5. reload chat and version tree;
6. verify exact labels, tool cards, mutation metadata, setup files, action rows, head, and undo.

Also inspect `codex mcp list --json` arguments captured for the turn: every inherited enabled server must be disabled and only the nonce RaceIQ server enabled.

- [ ] **Step 8: Add release note**

Load the `update-release-notes` skill. Under `CHANGELOG.md` Unreleased, add a concise fix entry stating Codex-backed experiment chat now executes real Setup Engineer/Driver Coach tools instead of returning text-only mutation claims.

- [ ] **Step 9: Commit verification and release note**

```bash
git add test/experiment-tools-mcp.test.ts test/codex-experiment-chat.test.ts CHANGELOG.md
git commit -m "test(ai): cover Codex MCP branch creation"
```

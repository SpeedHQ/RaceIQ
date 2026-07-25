# Setup Engineer: static agent + tools via `requestContext` (consolidation)

Replace the per-request **factory** (`buildSetupEngineerAgent` / `buildSetupEngineerTools`)
with a single **module-level static** agent + tool set, and pass the per-session
values (`gameId`, `sessionId`) through Mastra's `requestContext` on
`agent.stream(...)`. This is the pattern Mastra recommends for per-request data and
lets the agent be **registered on the Mastra instance** (observability, telemetry,
memory and addressability), which a freshly-constructed per-request `Agent` bypasses.

Builds on / touches:
- `mastra/tools/setup-engineer.ts` — factory → static `setupEngineerTools`
- `mastra/agents/setup-engineer.ts` — factory → static `setupEngineerAgent`
- `mastra/index.ts` — register `setupEngineerAgent` in `agents: { ... }`
- `server/routes/tune-routes.ts` — drop `buildSetupEngineerAgent(...)`, resolve the
  registered agent and call `agent.stream(messages, { requestContext: { gameId, sessionId } })`

---

## 1. Why (recap of the decision)
The current header of `setup-engineer.ts` argues the factory "sidesteps Mastra
`runtimeContext` entirely." That was a deliberate simplification, but the cost is:
- The agent is **not registered** on the Mastra instance → no unified observability /
  telemetry / addressability, and a new `Agent` object is allocated per request.
- Two parallel construction paths (tools + agent factories) that must stay in sync.

"Go with what Mastra recommends" = static registration + `requestContext`.

## 2. Confirmed API (`@mastra/core@^1.50.1`)
- **Tool execute** (`dist/tools/types.d.ts` `ToolExecutionContext`):
  `execute: (inputData, ctx) => ...` where `ctx.requestContext?: RequestContext<T>`.
- **Agent stream/generate options** accept `requestContext?: Record<string, unknown>`.

So a static tool reads: `execute: async (inputData, { requestContext }) => { ... }`
and the route supplies the values once per request.

## 3. The one real casualty: the `component` enum
`preview_change` (schema line ~162) and `apply_changes` (~202) currently use
`component` = `z.enum(knownComponents(gameId))` baked in at factory time — a static
tool's `inputSchema` cannot vary per game. Relax both to `z.string()`.

**Safe because** `applyIntents(gameId, setup, intents)` already runtime-validates:
an unknown component is dropped into `skipped` with a reason, never silently
applied. The enum was defence-in-depth on the *schema*; the engine is the real
guard. The system prompt + `get_setup` still tell the model the exact
knob list, so grounding is unchanged in practice.

`get_symptoms` / `get_version_history` / `get_setup` already use `z.string()`
for `component` — no change there.

## 4. Edits

### 4a. `mastra/tools/setup-engineer.ts`
- Delete `componentEnum(gameId)` and the `component` local.
- Export a module-level `export const setupEngineerTools = { ... }` (no factory,
  no closure over `gameId` / `sessionId`).
- Add a helper to read + validate the request context once per execute:
  ```ts
  interface SetupEngineerRequestContext { gameId: GameId; sessionId: number }
  function readCtx(requestContext: RequestContext | undefined): SetupEngineerRequestContext {
    const gameId = requestContext?.get("gameId") as GameId | undefined;
    const sessionId = requestContext?.get("sessionId") as number | undefined;
    if (!gameId || typeof sessionId !== "number") {
      throw new Error("setup-engineer tool called without gameId/sessionId requestContext");
    }
    return { gameId, sessionId };
  }
  ```
  (Confirm `RequestContext` is a `.get()`-style map vs a plain object during Red
  step — adjust `readCtx` accordingly; it's the only API-shape unknown.)
- Every `execute` gains the second `ctx` param and calls `readCtx` instead of
  closing over `sessionId` / `gameId`.
- `preview_change` + `apply_changes`: `component: z.string()`.

### 4b. `mastra/agents/setup-engineer.ts`
- `export const setupEngineerAgent = new Agent({ id, name, instructions, model, tools })`.
- `instructions` and `model` become **functions** (as `compare-engineer.ts` does)
  that read global settings via `loadSettings()`. Per-session text that today comes
  from factory args (`carName`, `trackName`, `sessionName`) must instead be read
  from `requestContext` inside `instructions: ({ requestContext }) => ...`, OR moved
  into the first system/user message. Prefer `requestContext` to keep the agent
  self-describing. Verify `instructions` receives `requestContext` in v1.50; if not,
  prepend the session preamble as a message in the route.

### 4c. `mastra/index.ts`
- Add `setupEngineerAgent` to the `agents: { ... }` map on the `Mastra` instance.

### 4d. `server/routes/tune-routes.ts` (UTF-16 file — preserve encoding on write)
- Replace the `buildSetupEngineerAgent({...})` call (~1069) with
  `const agent = mastra.getAgent("setup-engineer")` (or import the static agent).
- On `agent.stream(messages, { ... })` (~1115) add
  `requestContext: { gameId, sessionId: id }` alongside the existing `memory`.

## 5. Test plan (TDD)

**Confirmed while prepping Red:** the existing suite (`test/setup-engineer-tools.test.ts`,
**11 tests**) deliberately **does not import the tool file** — it exercises the
primitives directly (`describeKnobs`, `applyIntents`, and a *locally mirrored*
`componentEnum`) because the tool file pulls DB/fs/memory deps at import. So there is
**no factory invocation in the suite to update**. Consequences:
- The suite's mirrored-`componentEnum` test ("an unlisted component is a
  schema-validation failure") documents behaviour we are **removing**. Replace it with
  a test asserting the opposite contract: an unknown `component` string is accepted by
  the (now `z.string()`) schema and lands in `applyIntents(...).skipped` with a reason
  — i.e. the **engine** is the guard, not the schema.
- To keep the new `requestContext` guard unit-testable **without** importing the heavy
  tool graph, put the guard in a **leaf module** with zero heavy imports:
  `mastra/tools/setup-engineer-request-context.ts` exporting
  `SetupEngineerRequestContext` + `readSetupEngineerContext(requestContext)`. The tool
  file imports it; the test imports only the leaf.
- **Red first**: new test on the leaf — `readSetupEngineerContext` returns
  `{ gameId, sessionId }` from a real `RequestContext` and **throws** the guard error
  when `gameId`/`sessionId` are absent.
- `bun test test/setup-engineer-tools.test.ts` green, then `bun run typecheck`.

## 6. Risks / unknowns
- ~~`RequestContext` shape~~ **Resolved**: `@mastra/core` `RequestContext` is a
  `Map`-like class — `.get(key)` / `.set(key, value)` (strictly typed when
  parameterised with a `Record`). `readSetupEngineerContext` uses `.get()`.
- **`instructions({ requestContext })`** availability — if the agent-instructions
  callback doesn't receive `requestContext` in v1.50, fall back to a session preamble
  message built in the route (no behaviour change to the model). Verify at build time.
- **UTF-16 route file** — must round-trip encoding; edit via a script that preserves
  the encoding rather than a naive rewrite.

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
guard. The system prompt + `get_current_setup` still tell the model the exact
knob list, so grounding is unchanged in practice.

`get_symptoms` / `get_version_history` / `get_current_setup` already use `z.string()`
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
Existing suite: **11 tests** in `test/setup-engineer-tools.test.ts` (must stay green).
- **Red first**: add a test asserting a tool (e.g. `get_current_setup`) reads
  `gameId`/`sessionId` from `requestContext` and that calling it *without* context
  throws the guard error. This is the new behaviour that proves the migration.
- Update the existing 11 tests' invocation to pass `{ requestContext: { gameId,
  sessionId } }` as the second execute arg instead of constructing via the factory.
- Keep an assertion that an unknown `component` string lands in `skipped` (proves
  the enum relaxation didn't weaken the real guard).
- `bun test test/setup-engineer-tools.test.ts` green, then `bun run typecheck`.

## 6. Risks / unknowns
- **`RequestContext` shape** (`.get()` map vs object) — resolve at Red step from the
  installed `.d.ts`; contained in `readCtx`, single point of change.
- **`instructions({ requestContext })`** availability — if the agent-instructions
  callback doesn't receive `requestContext` in v1.50, fall back to a session preamble
  message built in the route (no behaviour change to the model).
- **UTF-16 route file** — must round-trip encoding; edit via a script that preserves
  the BOM/encoding rather than a naive rewrite.

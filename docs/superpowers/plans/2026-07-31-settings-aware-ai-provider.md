# Central Settings-Aware AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish PR #196 with one feature-based, settings-aware model utility and no provider/model/capability checks duplicated across agents or routes.

**Architecture:** `resolveAi(feature)` remains sole settings, credential, readiness, provider, and fallback resolver. `getModel(feature, requestContext?)` is the sole Mastra model entry point. Private `ResolvedAi` internals and central execution helpers bind request-local models and dispatch Mastra versus provider-native execution without leaking transport details to consumers.

**Tech Stack:** Bun, TypeScript, Hono, Mastra, AI SDK, React Query, Bun test.

## Global Constraints

- Preserve existing Mastra tools, personas, memory, reasoning options, detached streaming, and provider-native Codex behavior.
- Never mutate `OPENAI_API_KEY`, `OPENAI_BASE_URL`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
- Routes and agents must not inspect provider IDs, optional provider methods, raw model bindings, endpoints, or credential state.
- Direct Mastra Studio/workflow agent calls must resolve saved settings and keystore credentials.
- No compatibility aliases, stale duplicate helpers, vacuous tests, or task-report artifacts remain.

---

### Task 1: Build private model binding and feature utility

**Files:**
- Create: `server/ai/resolved-ai-internals.ts`
- Create: `server/ai/model-provider.ts`
- Modify: `server/ai/ai-types.ts`
- Modify: `server/ai/provider-adapters.ts`
- Modify: `mastra/model.ts`
- Test: `test/ai-model-provider.test.ts`

**Interfaces:**
- Consumes: `resolveAi(feature, settings?)`, `modelFromRequestContext(context)`, `BoundMastraModel`, `RequestContext`.
- Produces: `getModel(feature: AiFeature, requestContext?: MastraRequestContext): Promise<BoundMastraModel>`.
- Produces: `createModelContext(ai: ResolvedAi, context?: RequestContext): RequestContext | undefined`.
- Produces: private WeakMap-backed `setResolvedAiInternals(ai, internals)` and `getResolvedAiInternals(ai)`; no internal field appears on `ResolvedAi`.

- [ ] **Step 1: Add failing feature-model tests**

Cover request-bound reuse, direct settings resolution, per-feature model selection, explicit credential binding, and Codex unsupported-Mastra error:

```ts
expect(await getModel("chat", boundContext)).toBe(boundModel);
expect(await getModel("analysis")).toBe(resolvedAnalysisModel);
await expect(getModel("chat", codexSettingsContext)).rejects.toMatchObject({
  code: "unsupported-operation",
  provider: "codex",
});
```

Use complete keystore mocks by spreading the real module or defining every imported export so this file composes with `test/settings.test.ts` in one Bun process.

- [ ] **Step 2: Verify tests fail for missing utility**

Run: `bun test test/ai-model-provider.test.ts test/settings.test.ts`

Expected: failure because `server/ai/model-provider.ts` does not exist.

- [ ] **Step 3: Hide provider-specific internals**

Remove `mastraModel` and `createChatResponse` from public `ResolvedAi`. Store optional bound Mastra model and provider-native chat function in a module-private `WeakMap<ResolvedAi, ResolvedAiInternals>`:

```ts
export type ResolvedAiInternals = {
  model?: BoundMastraModel;
  createChatResponse?: (input: ChatRequest) => Promise<Response>;
};
```

`resolvedAiFromAdapter()` constructs public operations, then registers private internals. No route or agent imports this internal module.

- [ ] **Step 4: Implement `getModel(feature, requestContext?)`**

First return a validated model already bound to request context. Otherwise call `resolveAi(feature)`, read its private bound model, and return it. Throw `AiProviderError` with `unsupported-operation` when selected provider has no Mastra model. Do not load settings or secrets anywhere else.

- [ ] **Step 5: Implement opaque context creation**

`createModelContext(ai, context?)` writes only the private bound model under one module-owned key. Return `undefined` when provider has no Mastra model so central dispatch can choose provider-native execution.

- [ ] **Step 6: Run focused model tests**

Run: `bun test test/ai-model-provider.test.ts test/ai-runtime.test.ts test/settings.test.ts`

Expected: all pass together; no missing keystore export.

- [ ] **Step 7: Commit**

```bash
git add server/ai/resolved-ai-internals.ts server/ai/model-provider.ts server/ai/ai-types.ts server/ai/provider-adapters.ts mastra/model.ts test/ai-model-provider.test.ts
git commit -m "refactor: centralize settings-aware AI models"
```

### Task 2: Centralize execution dispatch and migrate consumers

**Files:**
- Modify: `server/ai/model-provider.ts`
- Modify: `mastra/agents/compare-chat.ts`
- Modify: `mastra/agents/compare-engineer.ts`
- Modify: `mastra/agents/driver-coach.ts`
- Modify: `mastra/agents/driver-profiler.ts`
- Modify: `mastra/agents/lap-analyst.ts`
- Modify: `mastra/agents/lap-chat.ts`
- Modify: `mastra/agents/setup-engineer.ts`
- Modify: `server/ai/consult-lap-analyst.ts`
- Modify: `server/routes/lap-routes.ts`
- Modify: `server/routes/tune-chat-routes.ts`
- Test: `test/ai-model-provider.test.ts`
- Test: existing route and consumer tests.

**Interfaces:**
- Consumes: Task 1 `getModel()` and private resolved-AI internals.
- Produces: `runAiChat(ai, input, runMastra): Promise<Response>` where `runMastra(context)` returns final HTTP response.
- Produces: `runAiStructured(ai, input, runMastra): Promise<AiResult>` where Mastra output is normalized centrally to `AiResult`.

- [ ] **Step 1: Add failing central-dispatch tests**

Assert provider-native Codex dispatch never invokes Mastra closure, Mastra dispatch receives bound context, and both paths return the same public response/result shape:

```ts
const response = await runAiChat(codexAi, chatInput, async () => {
  throw new Error("Mastra must not run");
});
expect(response.status).toBe(200);

const result = await runAiStructured(openAi, structuredInput, async (context) =>
  fakeAgentResult(context),
);
expect(result).toMatchObject({ analysis: "ok", usage: { model: "gpt-4o-mini" } });
```

- [ ] **Step 2: Verify dispatch tests fail**

Run: `bun test test/ai-model-provider.test.ts`

Expected: failure because central dispatch functions do not exist.

- [ ] **Step 3: Implement central dispatch**

`runAiChat` reads private internals once: call provider-native chat when available, otherwise create opaque context and invoke Mastra closure. `runAiStructured` uses provider-native structured execution when no Mastra model exists, otherwise invokes Mastra closure and normalizes text/usage once. Provider and capability checks exist only here.

- [ ] **Step 4: Simplify every agent model callback**

Replace repeated context inspection and `loadSettings()` model fallback with only:

```ts
model: ({ requestContext }) => getModel("chat", requestContext),
```

Use `analysis` for lap analyst and compare engineer; `driverProfile` for driver profiler. Keep `loadSettings()` only where instructions/personas need unit, temperature, or language.

- [ ] **Step 5: Migrate chat routes**

Replace every `resolveAi` + `if (ai.createChatResponse)` + manual `aiProviderConfig` block with `runAiChat`. Each Mastra closure preserves current memory thread, tools, provider options, detached streaming, and error mapping. Routes contain no provider/capability checks.

- [ ] **Step 6: Migrate structured Mastra consumers**

Use `runAiStructured` for lap analyst route and `consult-lap-analyst`. Preserve schemas, tools, max steps, reasoning options, usage accounting, and JSON parsing. Comparison analysis continues through central feature resolution; unsupported Codex comparison handling moves to central feature/operation validation rather than a route check.

- [ ] **Step 7: Prove forbidden duplication is gone**

Search production code for `aiProviderConfig`, `.mastraModel`, `if (ai.createChatResponse)`, and agent-level `getMastraModelId`. Expected: no route/agent matches. `loadSettings()` may remain in agent instruction functions only.

- [ ] **Step 8: Run route and consumer tests**

Run:

```bash
bun test test/ai-model-provider.test.ts test/ai-consumer-resolution.test.ts test/ai-runtime.test.ts test/codex-chat-stream.test.ts test/lap-route-game-id.test.ts test/analysis-telemetry.test.ts test/compact-route.test.ts test/driver-profile-runner.test.ts
```

Expected: all pass in one process.

- [ ] **Step 9: Commit**

```bash
git add server/ai/model-provider.ts mastra/agents server/ai/consult-lap-analyst.ts server/routes/lap-routes.ts server/routes/tune-chat-routes.ts test/ai-model-provider.test.ts
git commit -m "refactor: route AI calls through central provider"
```

### Task 3: Remove stale code, tests, and PR artifacts

**Files:**
- Modify: `server/ai/chat-agent.ts`
- Modify: `test/ai-features.test.ts`
- Modify: `test/ai-runtime.test.ts`
- Modify: `test/ai-consumer-resolution.test.ts`
- Remove: `.superpowers/sdd/2026-07-31-settings-aware-ai-provider/task-4-report.md`
- Remove: `docs/superpowers/plans/2026-07-30-codex-cli-provider.md`
- Remove: `docs/superpowers/specs/2026-07-30-codex-cli-provider-design.md`
- Keep and update: `docs/superpowers/specs/2026-07-31-settings-aware-ai-provider-design.md`
- Keep this final implementation plan.

**Interfaces:**
- Consumes: final Task 1 and Task 2 APIs.
- Produces: one documented architecture, composable tests, no dead provider helpers.

- [ ] **Step 1: Make test mocks composable**

Replace partial `mock.module("../server/keystore", () => ({ getSecret }))` definitions with complete mocks that preserve `setSecret`, `deleteSecret`, and other exports used by concurrently loaded test files. Run combined tests to verify previous `Export named 'setSecret' not found` failure is gone.

- [ ] **Step 2: Restore compaction assertions**

In `test/ai-features.test.ts`, assert resolved compaction feature, provider, model, and thinking budget instead of assigning an unused `resolved` value.

- [ ] **Step 3: Delete duplicate legacy model helper**

Remove `getMastraModelId` from `server/ai/chat-agent.ts` and update its module comment to describe memory/thread ownership only. Confirm LSP references show no callers before deletion.

- [ ] **Step 4: Remove stale artifacts**

Delete the task report and superseded 2026-07-30 Codex design/plan. Retained final documents already cover Codex readiness, transport, process cleanup, parsing, chat streaming, errors, and verification. Do not remove changelog, UI, settings, dependency, context-window, or provider tests that still defend shipped behavior.

- [ ] **Step 5: Run combined regression group**

Run:

```bash
bun test test/ai-configured.test.ts test/ai-consumer-resolution.test.ts test/ai-features.test.ts test/ai-model-provider.test.ts test/ai-runtime.test.ts test/codex-chat-stream.test.ts test/codex-provider.test.ts test/context-window.test.ts test/settings.test.ts
```

Expected: all pass together, zero unhandled module-export errors.

- [ ] **Step 6: Commit**

```bash
git add -A server/ai/chat-agent.ts test .superpowers/sdd docs/superpowers
git commit -m "chore: clean AI provider migration artifacts"
```

### Task 4: Verify behavior and reconcile PR

**Files:**
- Modify only if verification exposes a real defect.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: verified PR branch with no merge conflict and current focused evidence.

- [ ] **Step 1: Run focused suite together**

Run the combined Task 3 command. Expected: zero failures.

- [ ] **Step 2: Run build/typecheck**

Run: `bun run build`

Expected: TypeScript and client build succeed. If final binary packaging still fails solely from missing optional DuckDB native binding, record exact observed stage and do not claim full build success.

- [ ] **Step 3: Run fake-Codex smoke path**

Run Codex provider and chat-stream tests with fake executable fixtures. Confirm command arguments, stdin, readiness, timeout process-tree cleanup, JSONL parsing, and UI stream completion.

- [ ] **Step 4: Reconcile `main`**

Fetch current `origin/main`, reconcile the feature branch using repository convention, resolve conflicts by preserving central provider behavior, then rerun Steps 1–3. GitHub PR merge state must no longer be `DIRTY`.

- [ ] **Step 5: Final architecture audit**

Confirm production routes/agents contain no duplicated provider/model/capability checks; public `ResolvedAi` exposes no model binding or provider-native optional method; only central runtime reads AI settings and keystore credentials.

- [ ] **Step 6: Commit any reconciliation fixes**

```bash
git add -A
git commit -m "fix: reconcile central AI provider cleanup"
```

Skip commit when reconciliation is a clean fast-forward/rebase with no new changes.

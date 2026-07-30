# Settings-Aware AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicated provider selection, credentials, model fallback, and Codex routing so AI consumers resolve behavior from one feature key.

**Architecture:** Add a typed feature registry and provider-neutral `resolveAi(feature)` runtime. Provider adapters own credentials, readiness, SDK/subprocess execution, structured output, and chat streaming. Consumers receive a resolved operation object and never switch on provider IDs or mutate environment variables.

**Tech Stack:** TypeScript, Bun, Hono, AI SDK v7, Mastra, Zod, Bun test runner.

## Global Constraints

- Consumers MUST pass an `AiFeature` key rather than provider IDs.
- `ResolvedAi` MUST NOT expose API keys.
- Normal request execution MUST NOT mutate process-global `process.env`.
- Codex MUST use the installed CLI and authenticated session, never `OPENAI_API_KEY`.
- No provider failure may silently fall back to another provider.
- Existing Gemini, OpenAI, Local, and settings defaults MUST remain behaviorally compatible.
- Tests MUST use deterministic fakes and MUST NOT call real AI services.

---

### Task 1: Define feature registry and provider-neutral contracts

**Files:**
- Create: `server/ai/ai-features.ts`
- Create: `server/ai/ai-types.ts`
- Modify: `server/settings.ts` only if exported setting key types are needed
- Test: `test/ai-features.test.ts`

**Interfaces:**

```ts
export type AiFeature = "analysis" | "chat" | "autoTune" | "driverProfile" | "compaction";
export type AiProvider = "gemini" | "openai" | "local" | "codex";

export type AiFeatureConfig = {
  providerSetting: "aiProvider" | "chatProvider" | "autoTuneProvider" | "driverProfileProvider";
  modelSetting: "aiModel" | "chatModel" | "autoTuneModel" | "driverProfileModel";
  thinkingBudgetSetting: "aiThinkingBudget" | "chatThinkingBudget" | "driverProfileThinkingBudget";
  fallbackFeature?: "analysis";
};

export const AI_FEATURES: Record<AiFeature, AiFeatureConfig> = ...;
```

`compaction` must map to chat settings and must not introduce a second compaction provider setting. `autoTune` must fall back to analysis provider/model when its dedicated settings are empty. `driverProfile` keeps its independent settings.

- [ ] Write tests asserting all five feature mappings, including auto-tune fallback and compaction-to-chat mapping.
- [ ] Run `bun test test/ai-features.test.ts`; confirm tests fail because registry/contracts do not exist.
- [ ] Implement registry and request/result types without provider execution.
- [ ] Run the focused test again; confirm pass.
- [ ] Commit `refactor: define AI feature registry`.

### Task 2: Implement explicit provider adapters and resolver

**Files:**
- Create: `server/ai/provider-adapters.ts`
- Create: `server/ai/ai-runtime.ts`
- Modify: `server/ai/providers.ts` to expose low-level Gemini/OpenAI transport primitives used by adapters; remove feature-level dispatch from this module
- Modify: `server/ai/provider-error.ts`
- Test: `test/ai-runtime.test.ts`

**Interfaces:**

```ts
export interface ResolvedAi {
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  generateText(input: TextRequest): Promise<AiResult>;
  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult>;
  createChatResponse?(input: ChatRequest): Promise<Response>;
}

export async function resolveAi(feature: AiFeature, settings?: AppSettings): Promise<ResolvedAi>;
```

Adapters must receive secrets/endpoints through constructor or request-local arguments. `resolveAi` may read secrets while resolving, but must return closures that retain credentials privately instead of exposing `apiKey`.

- [ ] Write tests for Gemini/OpenAI/Local/Codex resolution, missing provider, missing API key, unsupported feature operation, and model fallback.
- [ ] Add a concurrency test that resolves two providers with different credentials and verifies no `process.env` key or endpoint is changed.
- [ ] Run focused tests and verify failures before implementation.
- [ ] Implement explicit client construction and the resolver using `AI_FEATURES`.
- [ ] Move feature-specific error text into typed provider errors; map errors to the existing client error shape once.
- [ ] Run `bun test test/ai-runtime.test.ts`; confirm pass.
- [ ] Commit `refactor: centralize AI provider resolution`.

### Task 3: Harden Codex adapter and shared chat stream

**Files:**
- Modify: `server/ai/provider-adapters.ts` for Codex readiness, subprocess execution, and shared stream construction
- Test: `test/codex-provider.test.ts`
- Test: `test/codex-chat-stream.test.ts`

**Interfaces:**

```ts
export type CodexStatus = { ready: true } | { ready: false; reason: string };
export async function getCodexStatus(): Promise<CodexStatus>;
export function parseCodexJsonl(raw: string): CodexResult;
```

- [ ] Add parser tests for progress events, final message, usage, malformed non-empty lines, missing completion, empty output, and multiple agent messages.
- [ ] Add subprocess tests using a fake executable for command arguments, stdin, non-zero exit, timeout, stderr truncation, and no `OPENAI_API_KEY` access.
- [ ] Add status tests for executable missing, unauthenticated login status, and ready state.
- [ ] Add stream contract tests for start, text-start, text-delta, text-end, finish, and provider failure.
- [ ] Run focused tests and verify failures before implementation.
- [ ] Make parser reject malformed non-empty JSONL instead of silently ignoring it.
- [ ] Implement readiness and subprocess lifecycle behind the Codex adapter.
- [ ] Ensure stream construction occurs only after successful provider execution and failed turns cannot write memory.
- [ ] Run both focused test files; confirm pass.
- [ ] Commit `refactor: harden Codex provider adapter`.

### Task 4: Migrate AI consumers to feature-key resolution

**Files:**
- Modify: `server/ai/consult-lap-analyst.ts`
- Modify: `server/ai/tune-intent.ts`
- Modify: `server/ai/driver-profile-runner.ts`
- Modify: `server/ai/compact-thread.ts`
- Modify: `server/routes/lap-routes.ts`
- Modify: `server/routes/tune-chat-routes.ts`
- Modify: `mastra/model.ts` to consume explicit provider configuration where legacy Mastra-backed consumers still require it
- Test: existing focused route/AI tests plus `test/ai-consumer-resolution.test.ts`

**Interfaces:**

Each consumer must use this shape and contain no provider switch:

```ts
const ai = await resolveAi("autoTune");
const result = await ai.generateStructured({ prompt, schema });
```

Chat routes must call `resolveAi("chat").createChatResponse(...)`. Compaction must call `resolveAi("compaction").generateText(...)`. Analysis and driver-profile structured parsing remain at their existing boundaries.

- [ ] Add regression tests that inject each feature key and assert the correct settings fields are used.
- [ ] Run focused tests and record failures caused by current provider branches.
- [ ] Replace direct `getSecret`, `process.env`, provider switches, model fallback expressions, and Codex stream construction in each consumer.
- [ ] Preserve comparison-analysis rejection for unsupported Codex structured behavior, but route its readiness/configuration through the shared runtime where applicable.
- [ ] Ensure failures map through one provider-error path and no successful fallback occurs.
- [ ] Run `bun test test/ai-consumer-resolution.test.ts test/codex-provider.test.ts test/provider-error.test.ts`; confirm pass.
- [ ] Commit `refactor: migrate AI consumers to feature resolver`.

### Task 5: Unify settings readiness and model discovery

**Files:**
- Modify: `server/routes/settings-routes.ts`
- Modify: `client/src/lib/is-ai-configured.ts`
- Modify: `client/src/components/settings/AiSection.tsx`
- Modify: `shared/ai/context-window.ts`
- Test: `test/settings.test.ts`
- Test: `test/ai-configured.test.ts`

**Interfaces:**

The provider discovery response must include Codex readiness without secrets:

```ts
{
  id: "codex",
  name: "OpenAI Codex (ChatGPT subscription)",
  ready: boolean,
  error: string | null
}
```

- [ ] Add tests showing Codex is not configured when executable/authentication is unavailable and configured when status is ready.
- [ ] Run focused settings/configuration tests and verify failure before implementation.
- [ ] Make settings UI consume readiness rather than treating Codex as always configured.
- [ ] Keep Codex model discovery empty while preserving configured model input and context-window fallback behavior.
- [ ] Run focused settings/configuration tests; confirm pass.
- [ ] Commit `fix: expose AI provider readiness consistently`.

### Task 6: Verify end-to-end behavior and clean duplicate code

**Files:**
- Modify: `CHANGELOG.md`
- Remove obsolete provider branches and compatibility imports discovered during Tasks 2–5
- Test: all focused AI/settings tests

- [ ] Run `bun test test/ai-features.test.ts test/ai-runtime.test.ts test/codex-provider.test.ts test/codex-chat-stream.test.ts test/ai-consumer-resolution.test.ts test/ai-configured.test.ts test/provider-error.test.ts`.
- [ ] Run `bun run build` and record any unrelated optional-native-binding limitation separately.
- [ ] Run fake-Codex smoke checks for ready, unauthenticated, timeout, malformed output, and successful chat/structured calls.
- [ ] Search migrated consumers for `getSecret`, `process.env.OPENAI`, `process.env.GOOGLE`, and provider `switch` statements; expected result is no feature-level occurrences.
- [ ] Review errors and logs for API-key leakage and unbounded subprocess output.
- [ ] Add one Unreleased changelog entry describing centralized settings-aware provider resolution.
- [ ] Commit `refactor: remove duplicated AI provider plumbing`.

# Settings-Aware AI Provider Design

## Goal

Replace per-feature provider switches and credential plumbing with one settings-aware AI runtime. Consumers provide an `AiFeature` key and request an operation; provider selection, model selection, readiness, credentials, and provider-specific execution remain inside the runtime.

## Scope

Features:

- `analysis`
- `chat`
- `autoTune`
- `driverProfile`
- `compaction`

Providers remain Gemini, OpenAI API, Local OpenAI-compatible, and Codex CLI. Existing feature behavior and settings defaults remain unchanged. Comparison analysis is not added to the supported feature set until it has a complete structured-output adapter.

## Architecture

### Feature registry and model utility

Keep one typed feature registry for settings selection. Every Mastra agent declares only the feature it needs:

```ts
model: ({ requestContext }) => getModel("chat", requestContext);
```

`getModel(feature, requestContext?)` is the sole Mastra model utility. It reuses an opaque request-bound model when present; otherwise it asynchronously calls `resolveAi(feature)` so direct Mastra Studio and workflow runs use saved settings and keystore credentials. Agent files do not read provider/model settings, select fallbacks, inspect raw context keys, or branch on provider IDs.

`resolveAi(feature, settings?)` remains the only settings and credential resolver. It validates provider readiness and returns a provider-neutral `ResolvedAi`.

### Provider adapters

Each provider implements the common execution contract and owns credentials, endpoints, readiness, and transport:

- Gemini adapter creates Gemini requests and a bound Mastra model with an explicit API key.
- OpenAI adapter creates OpenAI requests and a bound Mastra model with an explicit API key.
- Local adapter creates OpenAI-compatible requests and a bound Mastra model using the configured endpoint.
- Codex adapter owns executable/authentication checks, subprocess lifecycle, JSONL parsing, timeout handling, and UI-message conversion.

No adapter mutates process-global provider environment. Provider/model fallback checks exist only in the feature resolver and model utility, never in routes or agents.

### Central execution helpers

Opaque binding and provider capability selection remain behind small execution helpers:

- `getModel(feature, requestContext?)` returns the settings-aware, credential-bound Mastra model.
- `createModelContext(ai, context?)` binds a resolved model without exposing provider IDs, endpoints, credentials, or raw context keys.
- `startChat(feature, input)` and the structured-agent equivalent choose Mastra or provider-native execution once, centrally.

Routes supply prompts, schemas, memory, tools, and generation options. They do not construct `aiProviderConfig`, read `mastraModel`, test `createChatResponse`, or branch on provider IDs. Existing Mastra tools, personas, memory, reasoning options, and detached streaming remain unchanged.

`ResolvedAi` exposes provider-neutral operations only:

```ts
interface ResolvedAi {
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  generateText(input: TextRequest): Promise<AiResult>;
  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult>;
}
```

Any internal model binding remains private to the adapter/bridge boundary. Unsupported provider/operation combinations fail inside central resolution with a stable `AiProviderError`; consumers never infer support from optional methods.

Thinking-budget selection remains internal to feature resolution and provider execution; it is not exposed as `ResolvedAi` metadata. Feature mapping tests verify compaction's chat budget setting, while provider transport tests verify the selected budget reaches supported request bodies.

## Settings and readiness

A Codex provider is not considered configured solely because settings contain `codex`. Readiness checks executable availability and `codex login status`; the status endpoint and settings UI consume the same readiness result. API providers check secret presence without returning secret values.

Provider resolution must be safe under concurrent requests. No request may inherit another request's API key or endpoint. All SDK clients use explicit request-scoped credentials; provider environment variables are never mutated.

## Codex behavior

`parseCodexJsonl` accepts recognized progress events, extracts the final `agent_message`, reads completion usage, and rejects malformed non-empty JSONL, missing completion, or empty output. `runCodexCli` bounds diagnostics, enforces the existing timeout, reports missing executable/authentication/non-zero exit distinctly, and never reads or writes `OPENAI_API_KEY`.

The central chat-stream helper uses the shared Codex UI-message stream adapter when required. It emits the same start, text, and finish chunks as existing chat routes and performs no persistence or memory write after a failed provider call.

## Error handling

Errors are typed at the provider boundary and mapped once to client responses. Every error includes feature, provider, and actionable remediation when a user action can resolve it:

- missing API key: settings section name
- missing model: selected AI settings section; provider-specific model names are never inferred
- missing Codex executable: install/available-on-PATH guidance
- unauthenticated Codex: `codex login`
- timeout: bounded timeout message
- malformed output: provider parser failure without leaking raw credentials or unbounded subprocess output

No silent fallback to another provider or provider-specific default model is permitted.

## Verification

Focused tests must cover:

- every feature mapping and auto-tune fallback
- provider/model resolution, missing-model rejection, and unsupported operations
- direct agent resolution through stored settings and request-bound resolution without duplicate lookups
- API-key non-leakage and concurrent request isolation
- Codex readiness, command arguments, process-tree timeout cleanup, exit failure, malformed JSONL, empty output, and usage parsing
- shared structured-agent and chat-stream dispatch without route-level provider/capability checks
- all migrated consumers using feature or agent resolution without constructing provider context
- test mocks composing in one Bun process

Cleanup removes the unused duplicate model helper, vacuous assertions, stale task report, and superseded provider documentation. Relevant Codex UI, settings, dependencies, runtime, consumer, and changelog changes remain.

Run the focused AI/settings suite together, TypeScript/build verification, and a fake-Codex smoke path. Do not make real subscription or API calls in tests. Reconcile the branch with `main` only after focused verification passes, then repeat affected verification.

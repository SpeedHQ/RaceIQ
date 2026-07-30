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

### Feature registry

Create one typed registry mapping each feature to its settings fields, UI label, default model behavior, and supported operations. The registry is the only place that knows that analysis uses `aiProvider`/`aiModel`, chat uses `chatProvider`/`chatModel`, and auto-tune may fall back to analysis settings.

`resolveAi(feature, settings?)` loads and validates the selected settings, resolves the model, checks provider readiness, and returns a provider-neutral `ResolvedAi` object. Unknown providers and unavailable credentials/CLI sessions fail before execution with feature-specific actionable errors.

### Provider adapters

Each provider implements a common execution contract. Adapters own credentials and transport:

- Gemini adapter creates Gemini requests with an explicit API key.
- OpenAI adapter creates OpenAI requests with an explicit API key.
- Local adapter creates OpenAI-compatible requests using the configured endpoint.
- Codex adapter owns executable/authentication checks, subprocess lifecycle, JSONL parsing, timeout handling, and UI-message stream conversion.

`ResolvedAi` does not expose API keys and does not mutate process-global environment during normal execution. Any unavoidable legacy Mastra bridge is isolated behind one compatibility function with scoped cleanup and is not part of the consumer API.

### Consumer contract

Consumers pass only a feature key and request data:

```ts
const ai = await resolveAi("analysis");
return ai.generateStructured({ prompt, schema });
```

No route or feature module switches on provider IDs, reads secrets, sets environment variables, selects provider-specific model fallbacks, or constructs Codex chat streams.

Supported operations:

```ts
interface ResolvedAi {
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  generateText(input: TextRequest): Promise<AiResult>;
  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult>;
  createChatResponse?(input: ChatRequest): Promise<Response>;
}
```

The runtime rejects unsupported operations at resolution time with a stable error. Codex structured calls continue using existing downstream JSON/schema parsing until a provider-native structured-output contract is available.

## Settings and readiness

A Codex provider is not considered configured solely because settings contain `codex`. Readiness checks executable availability and `codex login status`; the status endpoint and settings UI consume the same readiness result. API providers check secret presence without returning secret values.

Provider resolution must be safe under concurrent requests. No request may inherit another request's API key or endpoint. Prefer explicit SDK client construction; legacy environment bridging must snapshot and restore every touched variable in `finally` and be removed as adapters migrate.

## Codex behavior

`parseCodexJsonl` accepts recognized progress events, extracts the final `agent_message`, reads completion usage, and rejects malformed non-empty JSONL, missing completion, or empty output. `runCodexCli` bounds diagnostics, enforces the existing timeout, reports missing executable/authentication/non-zero exit distinctly, and never reads or writes `OPENAI_API_KEY`.

Chat routes use one shared Codex UI-message stream adapter. It emits the same start, text, and finish chunks as existing chat routes and performs no persistence or memory write after a failed provider call.

## Error handling

Errors are typed at the provider boundary and mapped once to client responses. Every error includes feature, provider, and actionable remediation when a user action can resolve it:

- missing API key: settings section name
- missing Codex executable: install/available-on-PATH guidance
- unauthenticated Codex: `codex login`
- timeout: bounded timeout message
- malformed output: provider parser failure without leaking raw credentials or unbounded subprocess output

No silent fallback to another provider is permitted.

## Verification

Add focused tests for:

- every feature registry mapping and auto-tune fallback
- provider/model resolution and unsupported operations
- API-key non-leakage and concurrent request isolation
- Codex readiness, command arguments, timeout, exit failure, malformed JSONL, empty output, and usage parsing
- shared structured-output behavior
- shared chat UI-message stream contract
- all migrated consumers using feature-key resolution without provider switches

Run focused tests, TypeScript/build verification, and a fake-Codex smoke path. Do not make real subscription or API calls in tests.

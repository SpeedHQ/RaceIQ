# AI

## Purpose
Collect all AI-facing logic: deterministic telemetry symptom extraction, prompt construction, AI provider dispatch, tune-intent orchestration, chat/thread primitives, and track-guidance lookup used by analyst prompts.

## Structure
- Deterministic symptom layer: `tune-symptoms.ts`, `tune-tire-symptoms.ts`, `tune-damper-symptoms.ts`, `tune-weight-transfer.ts`.
- Auto-tune pipeline: `tune-intent.ts`, `tune-recommend.ts`, `tune-writer.ts`.
- AI provider/response path: `providers.ts`, `schemas.ts`, `google-provider-options.ts`.
- Provider transport policy: `provider-resilience.ts` (per-request deadlines, transport-only retries with jitter/Retry-After, circuit breaker), `stream-deadline.ts` (stall watchdog for UI streams).
- Prompt formatting and coaching entry points: `tune-*` prompt files, `chat-prompt.ts`, `compare-chat-prompt.ts`, `analyst-prompt.ts`, `inputs-compare-prompt.ts`.
- Chat persistence/state: `chat-agent.ts`.
- Track knowledge bridge: `track-guides.ts`.

## Boundaries and invariants
- Public contracts kept stable unless proven unused across repository.
- Deterministic symptom builders return `null` when required channels are unavailable instead of throwing.
- Provider calls are side-effect isolated; formatting/parsing functions own schema expectations.
- Provider failures are typed `AiProviderError`s: 4xx is never retried, transport failures retry at most 3 times inside one total deadline, and an open breaker fails fast instead of hanging the caller.
- `writeSetupFile` enforces setup-path confinement before writing.
- `chat-agent` owns thread-id conventions and generation ordering.
- `track-guides` owns track-name -> guide slug resolution and label normalization.

## Testing
- Type-check changed surface with Bun: `bun check`.
- Smoke affected user flow through server route tests that touch auto-tune and chat providers (or rerun targeted `bun test` subsets if focused on AI quality).
- For logic-only verification, compare generated symptom payloads from `telemetryToSymptoms` against known telemetry fixtures before/after edits for invariants like `null` on missing channels and stable aggregate shape.
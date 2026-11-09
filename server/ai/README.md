# AI

## Purpose
Deterministic telemetry symptom extraction and setup-output validation used by both the backend and assistant package. Assistant prompts, provider dispatch, and chat primitives live in `packages/assistant`.

## Structure
- Deterministic symptom layer: `tune-symptoms.ts`, `tune-tire-symptoms.ts`, `tune-damper-symptoms.ts`, `tune-weight-transfer.ts`, and `tune-issues.ts`.
- Setup-output validation: `schemas.ts` and `output-schema.ts`.
- Track conditions: `track-conditions.ts`.

## Provider registration
Add the provider ID, display name, and default model to `packages/assistant/src/ai/ai-features.ts`. Add its adapter factory to `packages/assistant/src/ai/ai-runtime.ts`. Implement provider-specific credentials, transport, model discovery, settings, and UI integration as required.

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
# Race Engineer UI naming plan

Boundary and acceptance: [shared contract](race-engineer-naming-contract.md). Backend work: [backend plan](race-engineer-naming-backend-plan.md).

## Scope and ownership

Code rename owner updates `client/src/components/dev/DevLiveEngineerReplay.tsx`, `DevSpotterSpeechPanel.tsx` and any other client consumers discovered by repository search. Main assistant owns real application/browser integration checks. No UI redesign, new setting, audio fallback or changed game support.

## Tasks

1. Humanize `race-engineer:*` replay system IDs and replace old subsystem wording with Race Engineer (N1/N3).
2. Consume shared renamed types and `race-engineer-v1` discriminator directly; no legacy aliases (N3/N4).
3. Preserve playback queues, error handling and generated Qwen segment IDs (N2).

## Verification

Reuse shared E1 browser audio smoke for generated damage clips and production audio player. Shared E2 starts actual application with production backend; inspect replay and spotter developer surfaces for Race Engineer labels and readable system names. Include no-session/source-unavailable surface: display existing availability state without inventing telemetry (N2/N3). Run E3 focused client diagnostics. UI can implement from contract while backend rename runs; final completion depends on main integration owner executing real UI/backend E2, not isolated mock rendering.

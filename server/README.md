# Server

## Purpose

`server/` contains RaceIQ backend code. `bootstrap.ts` is executable process entry point and fatal-error boundary; `index.ts` installs logging before handing control to `runtime/boot.ts`.

All other code belongs to domain folders. Each domain README defines ownership, invariants, and focused verification.

## Domain map

### Runtime and transport

- [`runtime/`](runtime/README.md) — process lifecycle, configuration, HTTP/WebSocket/UDP transport, desktop integration, and updates.
- [`routes/`](routes/README.md) — Hono HTTP boundary, request validation, and response translation.
- [`sync/`](sync/README.md) — remote lap-time manifest and payload synchronization.

### Game and telemetry pipeline

- [`games/`](games/README.md) — game adapters, packet parsing, extraction, and game-specific runtime policy.
- [`telemetry/`](telemetry/README.md) — normalized live pipeline, replay, and injected persistence/transport ports.
- [`session-capture/`](session-capture/README.md) — raw frame recording, compression, import, and reprocessing.
- [`lap-detection/`](lap-detection/README.md) — shared session/lap boundary state machine.
- [`laps/`](laps/README.md) — persisted lap retrieval, binary archives, and lap transfer contracts.
- [`lap-analysis/`](lap-analysis/README.md) — deterministic sectors, corners, consistency, quality, and comparison metrics.
- [`tracks/`](tracks/README.md) — track identity, calibration, metadata, geometry, and catalog services.
- [`motec/`](motec/README.md) — MoTeC export and LD/LDX encoding.

### Setup engineering

- [`setups/`](setups/README.md) — setup file guards, I/O, rules, and deterministic change application.
- [`tunes/`](tunes/README.md) — tune normalization, sharing, synchronization, and setup association.
- [`experiments/`](experiments/README.md) — tuning experiments, setup lineage, lap evidence, comparison, and undo.
- [`ai/`](ai/README.md) — symptom extraction, prompts, provider dispatch, and tune-intent orchestration.

### Persistent and derived data

- [`db/`](db/README.md) — SQLite schema, migrations, adapters, and domain query modules.
- [`driver-profile/`](driver-profile/README.md) — derived driver fingerprints, trends, and AI summaries.
- [`live-strategy/`](live-strategy/README.md) — live pit, fuel, tyre, and strategy state.
- [`race-results/`](race-results/README.md) — race-result provenance, derivation, and reconciliation.

## Boundaries

- Put protocol decoding and game policy under `games/<game>/`; keep shared normalized contracts in `games/types.ts` or owning downstream domain.
- Keep HTTP concerns in `routes/`; routes validate and delegate rather than own persistence or analysis.
- Keep process wiring in `runtime/`; domain modules must not start listeners, schedules, or desktop services at import time.
- Keep SQL and persisted row shapes in `db/`; domain folders consume query contracts instead of embedding database access.
- Prefer dependency injection at stateful boundaries. Do not add a second shared helper when an owning domain already exposes one.
- Preserve binary formats, database payloads, route paths, response shapes, game-adapter behavior, and startup order unless contract change is intentional.

## Verification

Run focused tests named by affected domain README. For cross-domain moves or public-contract changes, also run full Bun test suite and production build:

```bash
bun test
bun run build
```

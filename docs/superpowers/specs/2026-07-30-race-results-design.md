# Race and Stint Result Metadata Design

## Goal

Persist one normalized race-result contract per telemetry session, an ordered pit ledger, and deterministic provenance-aware derivations that can be rerun against historical sessions and consumed by Home, Driver, Car, and Track surfaces.

## Scope

Supported games use the same contract. Game adapters may populate different subsets. Missing source values remain explicit `unknown`/`null`; no result, pit, tyre action, or fuel action is inferred from absence alone.

The first release covers session result metadata and pit events. Existing tuning experiments remain the source of stint membership: laps linked to an experiment are the stint's lap set; unlinked historical sessions still receive session-level results. No synthetic stint boundaries are created where the recorder has no boundary signal.

## Data model

Add `session_results`, keyed uniquely by `session_id`, with:

- session type (`practice`, `qualifying`, `race`, `other`, `unknown`)
- classification (`finished`, `dnf`, `retired`, `qualifying`, `unknown`)
- finishing and qualifying positions
- `is_podium`, `is_fastest_lap`
- pit count and derivation status
- tyre and fuel strategy JSON snapshots
- provenance JSON and unresolved/ambiguous reason JSON
- created/updated timestamps

Add `pit_events`, keyed by result and stable sequence, with lap number, elapsed time, duration, service classification (`tyres`, `fuel`, `combined`, `unknown`), tyre details, fuel added, fuel level before/after, linkage status, and raw source JSON. Nullable values remain nullable.

Drizzle schema and the hand-rolled migration list must stay synchronized. Upserts must enforce one result row per session and stable event identity `(result_id, sequence)`.

## Derivation

Create pure derivation functions in `server/race-results/`:

- normalize session type from existing session metadata and game packet fields
- derive classification and positions only from explicit source fields
- derive podium (`1..3`) and fastest-lap only when source values support deterministic comparison; expose the source rule
- detect pit transitions from game-specific telemetry where a pit signal exists
- classify tyre-only, fuel-only, combined, or unknown service without treating a pit as a service action
- preserve fuel added separately from fuel level
- report unsupported, missing, and ambiguous fields

Game adapters provide source extraction; shared result types remain game-neutral.

## Backfill and reconciliation

Add a bounded service and API command that scans sessions in ascending id order, decodes each available raw lap once, derives a result, and upserts the result plus ledger. It is safe to rerun: unchanged sessions produce no duplicate rows/events. Results include processed, enriched, unchanged, skipped, ambiguous, and error counts plus per-session reasons. Raw source snapshots remain available for future parser improvements.

Live session completion calls the same reconciliation service, so historical backfill and new recordings share definitions.

## API and aggregates

Expose typed Hono RPC endpoints for:

- one session result
- bounded backfill/reconciliation
- recent result summaries
- aggregate result summaries by game, driver scope, car, and track

All aggregate queries include game scope before identity filters. The shared DTO is the only contract used by UI containers; page-specific calculations are prohibited.

## UI

Add shared result summary/status/pit-ledger components and typed queries. Home shows recent outcomes and highlights. Driver, car, and track pages show counts and distributions for podiums, fastest laps, classification, qualifying movement, pits, durations, tyres, and fuel only when available. Unknown and unsupported states are visibly distinct from zero.

## Error handling and observability

Malformed raw telemetry, unsupported games, and ambiguous source values do not invalidate existing sessions. They produce explicit reconciliation reasons. Backfill is bounded by batch size and returns progress data. API errors use existing Hono validation/error conventions.

## Verification

Focused tests cover derivation boundaries, null/unknown handling, source provenance, pit ordering and service classification, stable upserts, rerunnable backfill, game-scoped aggregates, route DTOs, and UI rendering of finished/DNF/qualifying/unknown states. Run the full Bun suite and client build before completion.

# Sessions

Canonical session and lap DTOs shared by ingest, storage, and UI.

## Purpose
- Define persisted session/lap metadata shapes.
- Keep recap summaries, sector metadata, and source flags consistent across db, API, and UI.
- Provide stable types for session route payloads and analysis queries.

## Key modules
- `types.ts`
  - `LapMeta`
  - `SessionMeta`
  - `SessionRecap`


## Dashboard read contract
- `dashboard.ts` defines a browser-safe request/response DTO and a bounded in-memory reference reducer for dashboard SQL parity tests.
- Request `from`/`to` are half-open UTC instants; `timeZone` controls local-calendar bucket boundaries only. SQLite timezone-naive datetimes are interpreted as UTC, not host-local time.
- Dashboard session and lap aggregates require exact `ownership === "mine"`; null, unknown, or future values are excluded. Cross-game card totals include every known game, while selected-game metrics are scoped by `gameId`.
- Native numeric IDs and numeric-string IDs canonicalize to the same numeric identity. Native string IDs remain strings; blank and numeric `-1` values are unknown and fall back to ordinal when available; ordinal `0` is valid. Identity keys include game ID.
- Recorded laps count even at zero/invalid time. Positive lap time contributes driven totals; only valid positive laps contribute best/average/valid totals. Incomplete laps are excluded from favourite-entity totals, not historical track distribution.
- Session-duration shares include finite nonnegative durations, including confirmed zero; missing/invalid duration contributes no seconds and is separately counted. Unknown session kinds remain distinct from known zero duration.
- Calendar days use request timezone's actual midnight instants and naturally span 23/25 hours at DST transitions. Every eligible interval of at most 367 local days returns all its buckets, including zero-data days. Buckets expose raw valid/positive counts; clean rate is valid-positive divided by all-positive, and driven seconds retain heatmap tooltip meaning.
- Favourite candidates rank by finite positive driven time, then lap count, then game and native identity for deterministic ties; incomplete laps do not contribute. Distinct session membership unions eligible lap sessions with in-period sessions having the same game-scoped entity. Distance is null without known track-length evidence.
- Podiums require exact-mine, confirmed, finished race results with finite integer position >0; position 1–3 counts as podium. Availability distinguishes no evidence (`null` per favourite) from confirmed zero.
- Consistency is population standard deviation for each session with at least two valid positive laps and one stable game/car/track context; session values are averaged unweighted and bucketed at 0.1-0.9 seconds. Only roundoff-sized negative variance is clamped; significant negative or non-finite results are rejected. Sessions must also fall in the requested interval.

### SQLite read-model implementation
- Migration v63 adds indexed UTC session/lap projections and versioned per-session, day, and time-bucket contributions; source session rows remain unchanged.
- Publication computes a revision-bound candidate and replaces contributions only when source revision still matches. Reads require exact `ownership === "mine"` and reconcile stale contributions for dirty, revoked, or deleted sessions in the same snapshot.
- `getDashboard` in `server/db/dashboard-queries.ts` returns dashboard widgets from one read transaction. Dirty or missing facts use bounded source fallback; work beyond the cap is reported as pending, not complete. `coverage.metadataComplete` distinguishes exact metadata aggregates from unavailable aggregates: false means overflow prevented computation, so zero values are unavailable rather than known zeros. It remains true when exact source fallback or summary reconciliation completed, including pending capture-only values and empty databases. Capture-derived values preserve available, unavailable, and pending evidence states.
- Migration v64 persists capture-ready state, source-sector starts, and weather conditions. Dashboard capture publication uses processor version 5 and accepts evidence only for the candidate's current source revision.
- The startup-owned SQLite processor publishes metadata first, streams captures through the game parser for derived duration, sector-layout, and weather facts, and resumes versioned backfill from a persisted keyset cursor. It yields every 25 sessions and stores retry timing and error state. Live and import pipelines contribute facts during their existing packet pass; they do not run a second lap detector.
- Capture fingerprints cover parsed record kinds, frame bytes, and frame timestamps rather than file size or modification time. Lossless compression can preserve capture identity; other file lifecycle changes explicitly invalidate evidence.
- `getDashboardSessionRecap()` is exposed through `GET /api/dashboard/sessions/:id/recap`, a capture-free query over persisted facts; it requires `X-Game-Id` and returns 404 unless the current parent is exact-mine for that game. Generic `/api/sessions/:id/recap` remains unchanged.
- `GET /api/dashboard` accepts finite half-open UTC `from`/`to` instants (maximum 366 days), an IANA `timeZone`, and optional `X-Game-Id`; absent game scope means all games. Selected-game metrics stay scoped while `cards` contain all-game totals. The response includes at most ten recent sessions using `DashboardRecentSession`, never raw captures, paths, setup, or provenance.
- Successful summary publication emits `{ type: "dashboard_updated" }`; runtime coalesces notifications so period and recap queries refresh after publication.
- Phase 5 scale/performance/resource and supported-Windows recording gates have not been run. Phase 4 browser acceptance remains unverified until its runtime gate completes.

Update this contract and its independent SQL/reference regressions together when metric eligibility or identity semantics change.

## Browser vs Node boundary
- Plain TypeScript contracts, browser-safe.
- No runtime side effects.

## Dependency direction
- Depends on
  - `shared/games/ids`
  - `shared/telemetry/version`
- Consumed by:
  - server persistence and query layers (`server/db/*`, route handlers)
  - client displays and selectors (`client/src/components/*`, hooks)

## Add/extend safely
- Treat as schema-shaped shared contract; update together:
  - DB migration layer
  - row mapping code
  - serializer/deserializer in query outputs
- Add new fields as optional/nullable to preserve older stored payloads.
- For `source` and `experiment*` fields, keep null semantics documented in field comments.
- Keep imports explicit by leaf module path.

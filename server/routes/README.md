# Routes

## Purpose

`server/routes` is the HTTP boundary for RaceIQ. It composes Hono routers, validates request inputs, translates domain results into HTTP responses, and delegates persistence or computation to the owning server domain.

`index.ts` is the server router entry point. It applies global CORS and error logging, mounts production routers, and conditionally mounts development-only routes.

## Structure

- Top-level route files expose cross-cutting resources such as settings, drivers, sessions, chats, cars, tunes, and cache status.
- `laps/` handles lap resources, transfer, analysis, chat, comparison, per-lap quality, and eligibility-aware trace access.
- `tracks/` handles track catalog, geometry, outlines, segments, sectors, corners, and leaderboards.
- `tunes/` handles tune CRUD, setup-file workflows, and automatic setup resources; `experiments/` handles tuning-session lifecycle and comparisons.
- `games/` exposes game-specific setup and source endpoints.
- `system/` exposes diagnostics, storage, networking, updates, extraction, and telemetry history.
- `dev/` exposes recording and import tools and is mounted only when `IS_DEV` is true.
- Session routes expose quality status and evidence-retention assessment. `GET /api/sessions/:id/evidence-retention` reports whether retained evidence supports raw removal. `GET /api/sessions/:id/quality` reports rebuild state, while `POST /api/sessions/:id/quality/rebuild` rebuilds decisions or reprocesses retained raw evidence and returns `409` when source evidence is unavailable. Missing sessions return `404`; operational failures remain server errors. Bulk stale processing clears stale health only after every session reaches a current state.

Subdirectories with an `index.ts` use it as their composition point. Shared helpers stay beside the routes that use them (`support.ts`, `tune-shared.ts`, or `recording-support.ts`).

## Boundaries and invariants

- Keep route paths, methods, status codes, and response shapes stable unless the API contract intentionally changes.
- Preserve router registration order. Static routes must remain ahead of overlapping parameter routes, and middleware must remain ahead of handlers it governs.
- Validate transport input at the route boundary, then delegate database, telemetry, game-policy, and analysis behavior to their owning domains.
- Blocked comparison, trace, and AI routes return shared eligibility decisions and exact reasons. Routes delegate policy evaluation and rebuild mechanics rather than interpreting quality locally.
- Preserve each endpoint's established game-context source (validated query, header, or path parameter); these are not interchangeable.
- Development routes must remain unreachable in production.
- Route helpers may normalize transport-facing data, but must not change persisted formats or game-specific meaning.

## Testing

Run focused Bun test files for the resource or domain touched, then run `bun test` for cross-router regressions when route composition or shared helpers change. Exercise handlers through Hono's `request()` API when changing validation, status codes, or response bodies. Verify development-only endpoints in both `IS_DEV` states when changing their registration or guards.

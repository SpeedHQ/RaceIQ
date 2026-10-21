# Catalogue server extraction implementation plan

Authority: [shared catalogue contract](catalogues-contract.md); counterpart: [UI plan](catalogues-ui-plan.md). Reuse the [feature pattern](../docs/architecture/feature-packages.md). Dashboard and neutral capture/pipeline algorithms are outside scope.

ADR: [Feature-owned E2E boundaries](../docs/adr/0015-e2e-aware-package-extraction.md).

## Ownership and tasks

1. Cars implementer owns `packages/cars-catalogue/server/` and server contracts, moves `apps/backend/src/routes/car-routes.ts`, and extracts only car catalogue endpoints from game route files while preserving unrelated game routes. Tracks implementer owns `packages/tracks-catalogue/server/` and contracts, moves `apps/backend/src/routes/tracks/` route groups/support. Each feature implementer also owns its corresponding UI slice from the UI plan. Shared app route composition, manifests/configs/lockfile, shared caller references and root test infrastructure have ONE coordinator editor.
2. Query exported symbol references with LSP before moves. Preserve route registration order and all methods, validated params/headers/query/payloads, response shapes, errors, nullable values and auth/CSRF host middleware. Exact source authorities and protocol are in the shared contract; do not introduce a normalized cross-game API or missing-game fallback.
3. Export typed Hono groups through `./server`; composition stays in app. Server uses existing backend-core/shared/game metadata services, never app/UI imports. Shared track support needed by other routes must remain a narrow shared/public service without duplicated implementations or cycles. Do not change DB schema, migrations, telemetry algorithms, file locations or permissions.
4. Keep browser-safe DTO/binding contracts separate from server implementation. Package exports, UI/server TypeScript scopes and feature manifests are integrated by coordinator. No mixed root barrel or wildcard private exports.
5. Move exclusively owned tests to feature ownership with all owner manifests/callers updated. Preserve application/cross-feature tests where appropriate; expose feature `test:e2e` and side-effect-free `e2e:impact` with actual dependencies and fixtures. Keep app-build execution prerequisites separate from impact inputs; no dependency erasure or result-cache policy changes.

## Acceptance and edge handling

Owned CAT-01/02/03/05; shared CAT-04/06/07/08. Refer to the [contract's criteria](catalogues-contract.md#acceptance-criteria) rather than duplicate response definitions. Preserve discovered car merging/deduplication, missing/invalid game headers, unknown IDs, strict car-model config updates, map/outline/curb availability, track mutations and literal/parameter registration precedence. Shared filesystem/DB/native concerns remain explicit dependencies, not no-op callbacks.

Tasks 1–3 map to CAT-E02/E04/E08; contracts/exports to CAT-E06; test/impact integration to CAT-E05/E07. UI/server plans can proceed in parallel after contract agreement, but real full-app integration is their shared completion dependency.

## Verification after edits settle

Coordinator runs affected real endpoint/application integration tests plus CAT-E01–08 through the actual compiled app and relocated feature suites. Supplement with explicit server/feature typechecks, root `bun run typecheck`, lint, test shard checks and production build. Invalid-header/unknown-resource tests must assert current consumer-visible behavior, not source structure or mock echoes. Record actual statuses/payload invariants and preserve before/after Playwright discovery.

Workers skip tests/builds/lint/formatters, delegation, staging and commits. Report exact changed paths, public typed server exports, removed paths, required app integration, blockers and verification gaps. Coordinator owns all final gates, integration, docs and changelog. No checkpoints, per user choice.

## Completion

Implemented and integrated. The feature server entries own their relocated catalogue routes and exported schemas; application composition retains Hono inference, registration order and shared auth/CSRF/CORS. Existing game identity, error and persistence behavior remains unchanged.

Owned and shared acceptance criteria passed [contract verification outcomes](catalogues-contract.md#verification-outcomes): real API/browser integration, config persistence across restart, unavailable/unknown resources, invalid debug mutation handling, fresh authentication/startup and feature-owned execution/failure propagation. Final UI/server integration is complete. Task paths above identify the pre-extraction sources; dashboard and neutral replay extraction remain deferred.

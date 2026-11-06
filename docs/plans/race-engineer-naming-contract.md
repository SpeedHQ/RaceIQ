# Race Engineer naming contract

Linked plans: [backend](race-engineer-naming-backend-plan.md), [UI](race-engineer-naming-ui-plan.md).

## Agreed boundary

User requires repository-owned subsystem naming to be Race Engineer. Existing runtime semantics and source attribution are authoritative. This is a coordinated clean cutover, not a mixed-version rollout; restart backend and reload browser together. No database or recording-data migration is needed: replay system identifiers are computed, not stored in source telemetry. Rollback restores both producer and consumer naming together; recordings and generated audio remain unchanged.

- PascalCase identifier prefix becomes `RaceEngineer`; camelCase becomes `raceEngineer`; constants become `RACE_ENGINEER`.
- Module/file/directory segments become `race-engineer`, including `race-engineer-triggers`, `race-engineer-callout-contract`, `race-engineer-coverage`, and `race-engineer-callout-coverage`.
- Replay `systemId` is `race-engineer:${family}`; subsystem selector is `race-engineer`. Example: `race-engineer:DamageReporting`.
- Race Engineer callout `render.renderingVersion` is `race-engineer-v1`. Existing protocol version 3, message types, required fields, payload types/nullability, errors, authentication, ordering, cooldown, lifecycle, and game gates are unchanged. No aliases or legacy fallbacks.
- Coverage evidence property becomes `referenceSources`; parity value becomes `reference-native`; absent upstream adapter reason becomes `no-reference-adapter`. Evidence retains real upstream host/project/commit/path/symbol values; never falsify third-party URLs or filenames. Reference factory inventory key becomes `event-factory`.
- UI labels, prose, internal test names, exports, import paths, manifests, and diagnostic strings use Race Engineer. Actual external source identifiers may retain their original proper name only as attribution.

## Acceptance and integration evidence

- N1: no old repository-owned symbols, module paths, labels, or metadata remain. Search all tracked source/documentation; allow only genuine upstream attribution paths/projects/URLs.
- N2: same telemetry transitions produce same announcements and playable Qwen audio under renamed code. E1: use existing damage integration cases for ACC, AC Evo, and F1; exercise new zones, heavy escalation, repair, transient damage, unavailable source recovery, and session reset. Expected clips and debounce remain unchanged. Browser smoke uses production audio player and regenerated assets.
- N3: real producer/consumer contract accepts `race-engineer-v1`; replay produces `race-engineer:*` systems and UI humanizes their IDs. E2: run existing replay and WebSocket contract suites, then serve actual application and inspect replay/spotter UI naming; no fixtures substitute for production parsing or playback.
- N4: exports and suite manifests resolve after file moves. E3: run focused TypeScript diagnostics, relevant tests and suite-manifest validation; no obsolete exports/shims.

## Edge handling

Source loss/reset, timing boundaries, duplicate telemetry, queue order, release gates and unsupported games retain current handling (N2/E1). Old client/backend pairs are intentionally unsupported during cutover; reload together (N3/E2). Real upstream attribution remains accurate rather than inventing renamed external projects (N1). Unavailable runtime environment or existing unrelated failures must be recorded, not claimed as passing.

Integration owner: main assistant. Implementation can proceed in parallel after this contract; completion depends on E1–E3 evidence.

## Executed evidence

- N1: repository search leaves only genuine upstream project/path/URL attribution. All source/test modules moved; obsolete empty directories removed.
- N2 / E1: generated 11 damage clips using the existing pinned Qwen model and Aussie voice reference. Model revision/reference hash match prior catalog; all unrelated clip hashes and full lines are unchanged. Catalog validation passes for 975 clips and 21 full lines. Production Chromium audio player completed all 11 new clips with hash/decode checks; playback was muted, not human listening approval.
- N2–N4 / E1–E3: 161 tests pass across 22 runtime/replay/WebSocket/coverage files. One known Windows directory-fsync test was filtered out after its earlier failure; it is not claimed passing. Final changed-path run passes 69 tests across nine files. Test manifests assign all 428 tests exactly once. Focused production and affected-test LSP diagnostics report no errors; existing non-error hints remain.
- N3 / E2: launched real backend and Vite against isolated database seeded from captured F1 telemetry. Real streamed replay endpoint returned HTTP 200, 2,033 frames and 25 `race-engineer:*` system IDs plus opponent-pace/live-spotter systems. Manual scenario action loaded the same actual capture through the production UI; Systems tab rendered readable names and ready DamageReporting. Spotter developer surface showed Race Engineer wording; no-session UI remained intact. The isolated fixture mapped the real capture to the scenario's expected session ID; no HTTP responses or telemetry integrations were mocked.
- Browser auto-load navigation did not finish its loading state during this check; manual scenario loading passed. This navigation behavior is not changed or claimed fixed by the naming cutover.
- Rollout requires coordinated backend restart and browser reload because internal render/subsystem identifiers were cleanly replaced.

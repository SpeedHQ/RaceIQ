# Task 3 Report: Expose ownership and enforce owned-stat filtering

## Implemented

- Added normalized `ownership` to `SessionMeta` from `getSessions` and recap session inputs.
- Added normalized ownership to every LapMeta projection routed through `toLapMeta`, including general lap reads, profile-scope reads, experiment reads, and telemetry-loaded lap reads.
- Added SQL ownership predicate to owned lap statistics and profile-scope candidate selection before aggregation, grouping, pagination, and profile decoding. Predicate excludes only explicit `others`; NULL/unknown legacy values remain owned and normalize to `mine`.
- Preserved general `getSessions` and `getLaps` visibility for both ownership values.
- Restored complete telemetry LapMeta fields including track ordinal, tune ID, and parser version.
- Added focused regression coverage.

## Verification

`bun test test/db/lap-ownership.test.ts`: 2 passed, 0 failed, 8 assertions.

`bun test test/db/lap-ownership.test.ts test/telemetry/dynamic-sector-persistence.test.ts`: 3 passed, 0 failed, 10 assertions.

`bunx tsc --project tsconfig.json --noEmit --pretty false`: 24 existing diagnostics across 23 files (21 missing generated `@/paraglide/messages` modules, 2 unrelated setup test type errors, and the test's intentionally legacy ownership fixture before its SQL literal fix). No LapMeta/server ownership diagnostic was reported.

No formatter, linter, or project-wide test suite was run.

## Concerns

Current migration declares `sessions.ownership` NOT NULL, so regression test uses unknown legacy value rather than SQL NULL. Predicate and mappers handle NULL as mine if encountered.

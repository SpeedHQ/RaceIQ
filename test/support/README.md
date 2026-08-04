# Test support

`test/support/` contains reusable test-only setup, parsers, assertions, fixture
loaders, and renderers. It has no test entry points and must not become a second
production API.

## Domains

- `recordings/` — binary/session recording readers and recording metadata
  (`parse-dump.ts`, `udp.ts`, `session-frames.ts`, `fixtures.ts`).
- `laps/` — lap assertions and visualization helpers (`assertions.ts`,
  `visualizations.ts`, `svg.ts`).
- `tracks/` — segment rendering and accepted track-gap ledgers
  (`segment-svg.ts`, `known-gaps.ts`).
- `telemetry/` — telemetry catalog E2E support (`catalog-e2e.ts`).
- `motec/` — MoTeC `.ld` parsing and overlay/centerline rendering
  (`ld.ts`, `from-centerline.ts`, `overlay-svg.ts`).
- `setup-data-dir.ts` — Bun preload that isolates test `DATA_DIR`.
- `games/` — shared game SDK or adapter support.
- `lap-analysis/` — shared lap-analysis support.
- `experiments/` — experiment support and factories.
- `driver-profile/` — driver-profile factories.
- `db/` — database migration and persistence setup.

Place support beside its owning domain, not in a generic catch-all directory.
Keep names specific enough to describe boundary
(`recordings/parse-dump.ts`, `telemetry/catalog-e2e.ts`, `tracks/segment-svg.ts`).
A helper belongs here when at least two tests share it or when it defines a stable
fixture/adapter boundary. Keep one-consumer setup in its test file.
Do not move immutable fixture data into support, and do not treat generated
`test/artifacts/` output as fixture source.

When adding support:

1. Identify owning test domain and choose matching support directory.
2. Keep imports test-only; support must not alter production state or hide failures.
3. Reuse existing support before adding another parser, assertion, or renderer.
4. Keep cohesive support together; prefer splitting near 400 lines only at a real
   behavior seam, not as a blind line-count rule.

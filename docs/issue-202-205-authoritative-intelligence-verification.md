# Issue #202 and #205 Authoritative Intelligence Verification

**Date:** 2026-08-01
**Verified target:** current working tree; no commit created
**Baseline:** `docs/Authoritative Intelligence Layer.md`

## Verdict

- [Issue #202](https://github.com/SpeedHQ/RaceIQ/issues/202): **implementation acceptance satisfied**
- [Issue #205](https://github.com/SpeedHQ/RaceIQ/issues/205): **implementation acceptance satisfied**
- Authoritative Intelligence Layer: **immediate catalog, resolver, replay, and authority baseline implemented**

Both GitHub issues remain open. Verdict reflects implementation evidence, not issue state.

## Issue #202 — executable runtime adoption

**Satisfied: 7/7.**

| Acceptance criterion | Verdict | Evidence |
|---|---|---|
| Runtime consumer requests semantic IDs | Complete | `client/src/components/TrackMap.tsx` compiles one resolver per simulator, reuses its frame view, and requests position, velocity, speed, yaw, input, lap-fraction, and distance semantics. `shared/lib/lap-path.ts` consumes the semantic reader; direct packet reads remain explicit unavailable-value fallbacks. |
| Typed executable resolver | Complete | `shared/telemetry-resolver.ts` provides branded numeric slots, dense compiled plans, reusable frame views, allocation-free scalar hot reads, rich typed diagnostics, freshness, structured/per-wheel validation, enum-domain validation, and direct, normalized, registered-derived, simplified, unavailable, missing, stale, invalid, not-applicable, and error behavior. `shared/telemetry-derivations.ts` provides versioned deterministic DAG nodes and cycle rejection. |
| Stored schema/catalog identity | Complete | Sessions and laps persist catalog version/hash/schema, parser version, resolver version, and derivation version through migrations v50/v51, schema fields, recording adapters, import, replay, and reprocessing. |
| Detailed native values queryable after replay | Complete | iRacing SDK and IBT readers retain every validated native descriptor in source-frame v2 dictionaries/deltas. `queryLapTelemetryBySemanticId` resolves retained native and normalized values into canonical replay envelopes without one database row per value per tick. |
| Older stored laps continue loading | Complete with historical boundary | Migration v19 preserves legacy blobs, v35 purges only truly telemetry-less sessions, v46 preserves fallback bytes, and current reads fall back after every raw replay failure. Reprocessing retains blobs in same-count and count-change paths. Bytes or rows deleted by older already-applied destructive migrations cannot be recreated; recovery requires a pre-upgrade backup. |
| Bounded consumer migration plan | Complete | `docs/Authoritative Intelligence Layer.md` inventories 78 direct-field consumers and groups remaining work into bounded shared-analysis, runtime, replay/export, server-analysis, map-client, and dashboard pull requests. |
| Focused end-to-end tests | Complete | Resolver conformance covers all five games, mapping states, structured/per-wheel values, derivations, freshness, reuse, and error paths. Persistence tests cover version identity, raw/native replay, legacy fallback, reprocessing, and migration histories. Production consumer parity and race authority tests pass. |

### Runtime contracts now present

1. `compileTelemetryResolver` with numeric `SemanticSlot` plans.
2. Reusable `TelemetryFrameView` with `readNumber`, `readBoolean`, and typed `readValue` hot APIs.
3. Separate `resolveNumber`, `resolveBoolean`, `resolveValue`, and caller-owned `resolveMany` diagnostics.
4. Versioned derivation definitions with declared semantic inputs, missing-data policies, deterministic code hashes, memoization, and cycle rejection.
5. Typed failure for normalized mappings lacking a canonical packet field or trusted generic/registered conversion executor. Such mappings never return raw native units mislabeled as canonical values.
6. Canonical replay envelopes with current and recorded runtime identities, confidence components, limitations, provenance, and stable raw references.
7. Stable raw-capture identity and decompressed-byte hashes shared by telemetry replay and race-result provenance.

## Issue #205 — authoritative catalog foundation

**Satisfied: 12/12.**

| Acceptance criterion | Verdict | Evidence |
|---|---|---|
| One authoritative catalog source | Complete | `scripts/generate-telemetry-catalog.ts` builds all machine and review artifacts from one in-memory catalog. Generated headers identify inputs and generator. |
| Stable meaning, value type, and canonical unit | Complete | All 712 semantics declare stable IDs, labels, descriptions, canonical units, value types, dimensions, cardinality, limitations, and ranges or enum domains where applicable. |
| Explicit mapping for every supported simulator | Complete | Every semantic has a mapping state for FM 2023, F1 2025, ACC, AC Evo, and iRacing. |
| Distinct fidelity states | Complete | `direct`, `normalized`, `derived`, `simplified`, and `unavailable` remain discriminated states. Runtime mapping fidelity stays separate from freshness and resolution state. |
| Structured cardinality and ordering | Complete | Fixed arrays and per-wheel values declare cardinality/order. All 129 structured semantics carry typed `structuredSchema` index, ordering, field, and cardinality contracts. |
| Fidelity and limitations available | Complete | Available mappings expose structured limitations, freshness, provenance, and executable mapping identity. Simplified mappings require fidelity limitations. |
| TypeScript, JSON, and Markdown generation | Complete | Generator emits `shared/telemetry-catalog.generated.ts`, `shared/telemetry-catalog.generated.json`, `shared/TELEMETRY_CATALOG.md`, and the compatibility matrix from the same catalog build. |
| Required artifact metadata | Complete | Artifacts use catalog schema/format version 6 and contain catalog version, generator name/version/source identity, reproducible timestamp, and deterministic content hash. The five-state enum has no legacy aliases or shims. |
| Cross-simulator matrix | Complete | `shared/telemetry-catalog-matrix.md` is generated and checked in CI. It reports status, sources, units, execution, and limitations per simulator. |
| CI compatibility validation | Complete | Catalog checks validate parser references, conversion and derivation execution metadata, types, units, dimensions, arrays, structured schemas, enum domains, deterministic generation, and artifact drift. PR-base comparison rejects unreviewed fidelity transitions. |
| Retention distinction documented | Complete | Catalog docs preserve `exact`, `normalized`, and `not-recorded`; semantic coverage does not claim durable native retention. |
| Resolver-ready machine contract | Complete | Generated mappings preserve source provenance and deterministic execution identity. Direct mappings require no execution; normalized mappings use `conversion`; derived mappings use `derivation`; simplified mappings use `simplification`. Resolver compiles canonical packet mappings and reviewed trusted executors; unsupported execution returns typed error instead of a false canonical value. |

### Mapping taxonomy exercised

- `direct`: source already has the canonical semantic meaning and representation. It carries provenance but no execution metadata.
- `normalized`: same source semantic, changed only for representation or convention: unit/range conversion, clamp/round, value-with-unit text parsing, enum/boolean canonicalization, sign/axis convention, or equivalent-source selection. It uses `conversion`; it does not synthesize independent signals or use temporal state.
- `derived`: semantic synthesis from multiple non-equivalent inputs, temporal state/history, integration, aggregation, geometry, inference, or domain formula. It uses `derivation`.
- `simplified`: lossy substitute for the requested semantic. It uses `simplification` and declares limitations.
- `unavailable`: source does not expose an applicable mapping.

Recorded E2E fixtures exercise representation-only normalization separately from real derivation. F1 2025, ACC, and AC Evo speed/input conversions are `normalized`; iRacing `inputs.brake`, `motion.speed`, `timing.lap-fraction`, and `timing.track-length` are `normalized`. iRacing `timing.current-lap`, F1 `timing.lap-fraction`, `engine.power`, and `tires.tire-combined-slip` remain `derived` because they synthesize semantics from state or non-equivalent inputs. ACC `weather.weather-type` and F1 `tires.wheel-rotation-speed` are `simplified` because they depend on proxies or assumed geometry.

Resolver fidelity order is `direct` (`1.0`), `normalized` (`0.99`), `derived` (`0.95`), then `simplified` (`0.7`).

## Architecture baseline

### Implemented

- Simulator-independent semantic IDs and canonical units.
- Generated language-neutral contract, TypeScript manifest, Markdown catalog, and compatibility matrix.
- Build/initialization-time compilation into numeric slots and reusable frame caches.
- Separate allocation-free scalar hot path and rich diagnostic path.
- Versioned deterministic derivation registry with declared inputs, missing-data policy, code hashes, cycle detection, and per-frame memoization.
- Canonical telemetry replay envelopes with stable raw references and recorded/current version identity.
- Full validated iRacing native-variable retention through source-frame v2.
- Claim-level ordered authority arbitration with highest-authority, preserve-alternatives, consensus, and abstain-on-conflict strategies.
- Race-result provenance containing catalog, parser, resolver, derivation/code, raw/canonical input, and authority-policy identities.
- LLM remains outside the authority chain.

### Deliberate boundaries

- Remaining direct-field consumers are tracked in the bounded migration inventory; no claim is made that every consumer has migrated.
- Normalized, derived, or simplified mappings without a canonical packet field or appropriate trusted executor resolve `error`; arbitrary normalization prose is never evaluated.
- Databases that already lost legacy-only rows or blobs under older v35/v46 code cannot recover deleted bytes without a pre-upgrade backup. Current migrations prevent that loss for retained and newly upgraded databases.

## Verification evidence

Catalog regeneration and repeatability:

```text
bun scripts/generate-telemetry-catalog.ts --check --repeat
```

Result: **passed** — 712 semantic variables, 1,761 parser/source links. Final catalog content hash:

```text
4eee8928dd3b6409f5da9537fed2e18e8601d413b81a1e6a391301bfac9ba135
```

Focused authoritative-intelligence suite:

```text
bun test \
  test/telemetry-catalog.test.ts \
  test/telemetry-resolver.test.ts \
  test/lap-path.test.ts \
  test/legacy-telemetry-persistence.test.ts \
  test/semantic-replay-native.test.ts \
  test/raw-capture-identity.test.ts \
  test/migrations-e2e.test.ts \
  test/migrations.test.ts \
  test/telemetry-storage.test.ts \
  test/raw-binary-storage.test.ts \
  test/iracing-sdk.test.ts \
  test/iracing-ibt.test.ts \
  test/race-results-authority.test.ts \
  test/race-results-derive.test.ts \
  test/race-results-storage.test.ts \
  test/race-results-source.test.ts \
  --timeout 60000
```

Result: **134 passed, 0 failed**.

Cross-game mapping-taxonomy suite:

```text
bun test \
  test/telemetry-catalog.test.ts \
  test/telemetry-resolver.test.ts \
  test/telemetry-catalog-{fm-2023,f1-2025,acc,ac-evo,iracing}-e2e.test.ts \
  --timeout 120000
```

Result: **51 passed, 0 failed**. Broader parser, storage, native replay, and raw-capture regression run: **127 passed, 0 failed** across 16 files.

Resolver benchmark on 12th Gen Intel Core i9-12900K, Bun 1.3.14:

```text
reusable frame direct readNumber                 18.90 ns/iter
reusable frame fuel derivation readNumber        79.21 ns/iter
reusable frame and four allocation-free reads   131.76 ns/iter
```

Mitata heap samples reached **0.00 B** minimum on direct, derived, and combined hot paths; sub-byte reported averages were sampler noise. Rich `resolveMany` intentionally allocates diagnostic result objects unless caller storage is reused.

Full repository suite:

```text
bun test --timeout 60000
```

Result: **2,672 passed, 2 failed** across 170 files. Both failures are existing track-curation coverage artifact drift:

```text
track curation coverage > committed summary matches the repo
track curation coverage > committed detail tables match the repo
```

No authoritative catalog, resolver, replay, migration, native-retention, consumer, or authority test failed.

Build verification:

- Client i18n generation, TypeScript project build, and Vite production build: **passed**.
- Final standalone binary packaging: **blocked by missing local optional `@duckdb/node-bindings-*` packages**, after application TypeScript/client build completed.
- Client Biome check remains blocked by 3,613 repository-wide formatting diagnostics across 1,912 files, primarily existing CRLF/LF drift; TypeScript build remains clean.

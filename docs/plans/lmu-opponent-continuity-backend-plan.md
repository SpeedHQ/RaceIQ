# LMU opponent continuity backend plan

Contract: [Shared continuity contract](lmu-opponent-continuity-contract.md). Companion plan: [UI](lmu-opponent-continuity-ui-plan.md). Contract decisions are agreed; backend and UI implementation can proceed independently. Main orchestrator owns integration and execution of shared E1–E4.

## Scope and ownership

Backend worker owns `server/lap-analysis/lmu-opponent-laps.ts`, opponent index schema/build code, necessary lifecycle compatibility checks, and relevant backend tests. Preserve native files and source loader/export contracts. No UI changes, changes to acquisition recording cadence, broad recorder refactor, or unrelated cleanup.

## Tasks and observable acceptance

1. Reconstruct authoritative opponent session continuity from native simulator event/session/track identity and scoring-clock progression across the whole session source. Acquisition generation/file layout is not a simulator session boundary. Preserve original `lmuContext.key` and source provenance. Acceptance: OC1 and OC3; shared E1 and E3.
2. Retain real event/session/track changes, scoring clock resets and vehicle incarnations. Missing native identity must not cause speculative merging. Preserve native gaps and honest partial coverage. Acceptance: OC2–OC3; E1 and E4.
3. Version the derived index algorithm and make old publications rebuild through existing admitted background maintenance. Preserve atomic publication, failed-build recovery, retention revision and request-time bounded reads. Acceptance: OC4 and OC7; E2.
4. Extend existing native-import/route and lifecycle tests at consumer-visible seams. Assert semantic sample fidelity and independent real sessions, not implementation text or incidental IDs. Remove obsolete tests pinning acquisition keys as opponent session identity. Verify comparison/export still consume selected corrected intervals. Acceptance: OC1–OC4 and OC7; E1–E3.

## Edge-case implementation obligations

Follow the contract's edge table without duplicating definitions: native splits merge only with authoritative continuous identity; true resets/incarnations separate; missing identity stays conservative; missing observations remain discontinuities; obsolete IDs do not silently resolve another interval. Existing on-disk data is input only; recombination is logical indexing, not native file concatenation.

OC8 is UI-owned: native opponent elevation remains unchanged in source files, semantic values and exports. Backend requires no additional mutation or reimport. E2's versioned maintenance rebuild and E3b's unchanged production source revision/hashes prove that reseeding is unnecessary; UI E5 depends on those preservation guarantees, not on a new backend operation.

## Verification

Main executes shared E1 and E2 using actual import, storage and maintenance, then E3 real Sessions replay and E4 gap/player regression. Run relevant backend tests and required repository typecheck after implementation. UI does not depend on backend implementation finishing except for final E3 integration. Production-read/index-version changes invalidate prior backend verification.

## Outcomes

E1: Native route integration suite passed all 23 route tests in the combined backend run. Acquisition splits recombine; real event/session/track/clock and incarnation boundaries remain separate.

E2: `bun test packages/game-lmu/test/e2e/backend/integration/opponent-index-lifecycle.test.ts --timeout 180000` passed: 1 test, 62 assertions. An obsolete algorithm publication rebuilds through maintenance; semantic and comparison reads succeed without additional opponent source scans, parser priming or index materialization. Native hash equality and publication recovery remain verified.

E3b native fidelity: `bun .omp/evidence/verify-opponent-continuity.ts` passed after the final global-clock correction. Exact source values, states, freshness, provenance and all 2,555 capture keys survive indexing into 151 semantic observations over 30 seconds. Seven acquisition keys recombine into one Antonio lap 7 interval; coverage remains partial and full lap time unknown. All eight source files retain their original hashes; the obsolete opponent ID returns 404. Evidence: [result](../../.omp/evidence/opponent-native-continuity-result.json), [baseline](../../.omp/evidence/opponent-native-continuity-baseline.json).

Player/native preservation supplement: `bun test packages/game-lmu/test/e2e/backend/lap-analysis/lmu-export-import-roundtrip.test.ts --test-name-pattern 'compact replay preserves every' --timeout 180000` passed: one test, 1,205 assertions. All 1,200 player lap samples retain their 10 ms cadence, compact and expanded responses agree, and split capture bytes remain unchanged. This successful targeted run supersedes the earlier timeout during heavily concurrent verification. Evidence: [100 Hz roundtrip](../../.omp/evidence/opponent-native-100hz-roundtrip.log).

Repository `bun run typecheck` ran after the final implementation and verification-type corrections. It reports one existing TS2345 in `packages/game-lmu/test/e2e/backend/lap-analysis/lmu-export-import-roundtrip.test.ts:261` (`competitors` can be undefined). This is a failed gate, not a successful typecheck. Evidence: [typecheck log](../../.omp/evidence/opponent-typecheck.log), [route run](../../.omp/evidence/opponent-route-boundaries.log), [passing lifecycle rerun](../../.omp/evidence/opponent-index-lifecycle.log). The combined route log contains the earlier lifecycle-only metric assertion failure; the dedicated rerun supersedes that failure.

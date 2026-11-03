# Review fixes backend plan

[Shared contract](review-fixes-contract.md) · [UI plan](review-fixes-ui-plan.md)

## Scope and owners

Independent OMP scopes: capture runtime (AC2–4), AMS2 parser/source (AC6), update runtime (AC12). Update UI may proceed against contract fixtures. Main owns final integration, gates and evidence. No scope expansion; retain raw recording bytes and processing semantics.

## Acceptance, handling, execution

| ID | Observable acceptance and implementation | Edge/failure handling | Concrete E2E verification |
|---|---|---|---|
| AC2 | LMU admission uses existing `syncDirectory(indexRoot)` | Preserve helper's Windows-specific restriction handling; unrelated errors propagate | E2: isolated real index admission and worker publication persist durable state; inject documented Windows directory error only at filesystem boundary for supplemental coverage; Windows execution required for platform proof |
| AC3 | Cleanup inventories all direct capture members before deleting files and rechecks references against inventory | Same raw/manifest path, shared members, missing members, deletion failure: do not lose discovery or erase protected references | E3: isolated real DB plus direct recording manifest/chunks; preview and execute reclaim same unshared members/bytes; shared reference retains member, failure reported |
| AC4 | Published live lap refreshes authoritative processing metadata | Missing lap harmless; LMU indexing still gates readiness | Shared E4 and E5 |
| AC6 | Raw AMS2 imports and live acquisition share epoch-scoped transition eligibility | Reject stale qualifying-to-race timing within one epoch; accept finished sessions after an epoch change, including uint32 wraparound; preserve empty and session-only legacy checkpoints, and include epochs in new state checkpoints and priming | E6: native raw/live fixture histories match and source bytes remain unchanged; production frame import preserves qualifying → menu → finished race in a new epoch; full/index parsing, checkpoint replay and priming reject same-epoch stale frames but accept new-epoch sessions; legacy checkpoints still restore |
| AC12 | Runtime exposes external update capability per shared contract | Windows installer unchanged; Docker managed; unsupported apply remains rejected; failed discovery preserves safe capability | Shared E12 |

## Tasks

1. Read existing callers, authoritative semantic contracts and relevant tests; reuse implementations rather than duplicate guards.
2. Implement bounded fixes and meaningful regressions at real consumer seams. Workers skip tests/builds/lint/formatters; main executes after wave completion.
3. Run E2/E3/E4/E6/E12 using existing recording, integration and compiled app harnesses; extend minimal fixture support where necessary. Controlled external dependencies must not replace application integrations.
4. Main records passing/failing/unavailable evidence per AC, runs `bun run typecheck`, updates release notes once and validates them. Completion depends on real UI/backend E5/E12 integration, not independent mocks.

## AC6 epoch-boundary verification

- `bun scripts/test/run-suite.ts e2e --package @raceiq/game-ams2`: 7 passed. The production frame importer retained both qualifying and finished-race sessions across a menu and uint32 epoch wraparound. Full/index parsing, checkpoint restore, legacy checkpoint compatibility, and priming assertions passed.
- `bun scripts/test/run-suite.ts integration --package @raceiq/game-ams2`: 32 passed, 1 skipped. The skipped native mapped-memory test requires Windows x64.
- `bun test --preload ./apps/backend/test/support/setup-app.ts ./apps/backend/test/session-capture/live-parser-evidence.test.ts --timeout=20000`: 2 passed.
- `bun run typecheck` in `packages/game-ams2`: passed.
- Native game capture and packaged Windows execution were not run. These results cover AC6 only, not the other acceptance criteria in this plan.

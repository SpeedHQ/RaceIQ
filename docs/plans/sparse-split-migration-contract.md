# Sparse recording split migration

[Backend plan](sparse-split-migration-backend-plan.md) · [UI plan](sparse-split-migration-ui-plan.md)

## Boundary

Existing sparse whole-session recordings and historical completed-session bundles need physical per-lap file migration, independently of folder organization. Preserve automatic splitting for imports and live session closes during the current app run. Do not alter seed data to manufacture an old folder layout.

Backend owns authenticated storage endpoints:
- `GET /api/storage/split-migration`: `{ sessionCount: number, progress: { status: "idle" | "running" | "success" | "partial" | "error", done: number, total: number, migrated: number, failed: number, error: string | null } }`.
- `POST /api/storage/split-migration`: empty JSON object; consent or retry, returns HTTP 202 with the same snapshot. Duplicate running requests are idempotent. Existing storage-operation conflicts return 409 with `{ error: string, code: string }`.

`sessionCount` counts remaining startup migration sessions, not newly imported sessions. Counters count sessions; done includes failures. Only verified physical directory publications count as migrated. Persisted split job/publication state remains authoritative. Restart may require renewed consent for unfinished work. Source bytes must remain available; never mark failed jobs successful or bypass split verification. Missing/unsupported sources must not create an unfinishable consent prompt. Already physical layout-1 captures, empty sessions, and active live captures are excluded; historical layout-2 bundles are included.

Example idle response: `{ "sessionCount": 2, "progress": { "status": "idle", "done": 0, "total": 2, "migrated": 0, "failed": 0, "error": null } }`.

## Physical per-lap cutover

The current requirement supersedes the bundled completed-session representation: every completed/imported lap must have its own physical sparse `.bin` file. A manifest may index files but must not substitute virtual archive members for files. Reuse directory manifest v3 / database layout 1, with non-negative detector lap numbers including lap 0. Keep auxiliary source ranges in separate physical files to conserve all source records. Keep canonical source recordings under the existing retention policy; this change does not authorize deleting user recordings.

Production completed-session splitting and sparse imports must publish only directory files, never a new `capture.bin.gz` bundle. Existing layout-2 completed-session bundles with retained canonical sources join startup consent and migrate atomically to directory files. Existing readers may read old bundles while migration is pending; after publication, every lap resolves to its own physical file. The release-gated incremental live layout-3 recorder is not enabled in production and is outside this completed-recordings cutover.

- PL1: A real completed/imported recording with N persisted laps publishes N distinct physical lap `.bin` files, including invalid/incomplete and lap-0 windows when persisted. No completed-session archive is newly published.
- PL2: Each lap file independently replays and exports through production entry points with unchanged native payloads, timestamps, parser bootstrap, lap timing, and ownership. Auxiliary ranges retain all non-lap source data.
- PL3: Existing layout-2 bundled seed sessions prompt on restart; consent publishes physical files and switches all DB references atomically. The old publication remains readable until successful cutover.
- PL4: Normal unsplit seeds prompt; current-run sparse imports auto-split without consent and never join startup backlog.
- PL5: Failed/cancelled/stale split attempts never expose partial lap files as ready; retry/restart finishes safely. Folder migration, cleanup, and export continue to operate on physical publications.
- PL6: All six game adapters pass relevant fixture integration, plus selected-file replay/export; final typecheck and focused storage/lifecycle tests pass.

## Observable acceptance

- AC1: Normal sparse seed → app startup → split confirmation appears before startup records are split, including records already queued by offline seed.
- AC2: Consent → existing verified splitter publishes physical per-lap files → progress/success → explicit Close; completed physical records do not prompt after reload/restart.
- AC3: Sparse import through production import endpoint automatically publishes physical lap files without migration consent, even while startup work awaits consent.
- AC4: Folder migration precedes split confirmation; no competing modal/dock. Empty/already physical/unsupported captures do not prompt.
- AC5: Failure remains visible and retry only retries unfinished startup work; no duplicate publication. Reload restores server status; duplicate consent is safe.

Backend integration owner owns endpoint shapes and startup membership; UI owner consumes this contract, without introducing alternate split processing.

## Initial consent-flow verification (before physical cutover)

- AC1/AC3 passed through production boot and HTTP import: normal FM sparse seed produced two held startup sessions; importing its sparse recording published a new session automatically while both startup sessions remained queued.
- AC2 passed in the running app: consent switched to a non-modal progress dock, both startup sessions published, Close dismissed the result, and reload/restart reported no remaining migration. Selected seeded lap replay returned its saved lap time and 3,078 telemetry frames, including boundary context.
- AC4 passed in the running app: legacy-folder consent and success took precedence; closing folder success exposed split consent without reload, then split completion succeeded. Already indexed, missing-source, unsupported full-frame, and empty-session startup records produced no split prompt.
- AC5 passed in the running app: an injected archive-parent filesystem conflict produced a visible partial failure; removing the conflict and retrying published only unfinished work. Duplicate consent requests returned HTTP 202 with unchanged successful counters.
- Desktop (1280×900) and mobile (390×844) confirmation/result captures inspected. Runtime progress was non-modal and did not make the application main element inert.
- `bun test --preload ./apps/backend/test/support/setup-app.ts --timeout 60000 apps/backend/test/session-capture/split-lifecycle.test.ts apps/backend/test/runtime/stale-session-jobs.test.ts test/changelog.test.ts`: 22 passed, 0 failed.
- `bun run typecheck`: passed, including client, Storybook, backend, and workspace packages. Impeccable detector: no findings on changed dialog surfaces.
- Runtime integration used isolated temporary data and the real Bun backend/Vite client with the committed FM recording fixture; the six-game browser matrix and compiled installer were not run.

## Physical-file verification outcomes

- PL1/PL2/PL3/PL6: migrated nine real bundled seed sessions across all six games into 32 physical lap `.bin` files and six auxiliary `.bin` files. Every file matched the SHA-256 of its decoded original archive member; selected lap replay passed for nine laps. No new completed-session archive was published.
- PL2/PL4: exported a full recorded physical lap through the production HTTP endpoint, reimported it, and observed automatic physical splitting. A separate normal sparse seed kept two startup sessions queued while a current-run import automatically published files; consent then completed the two seeds, yielding seven lap files total.
- PL3/PL5: missing retained source preserved the old bundle and selected-lap replay, reported a server diagnostic, and did not create an unfinishable prompt. Restoring the source and restarting enabled successful consent-driven migration. The failed iRacing attempt under an initially disabled verification feature flag recovered after enabling the app flag and consenting.
- Package gates: 25 passed. Focused backend split/replay/export/cleanup/relocation plus changelog gates: 97 passed. Full `bun run typecheck`: passed.
- AC Evo replay comparison excludes only its existing generated `TimestampMS` when recorded capture UTC is absent; all capture timestamp bytes and absence/presence are still covered by exact artifact hashes. Other telemetry fields, saved lap times and frame counts match.
- Evidence: [structured outcomes](../../.omp/evidence/physical-per-lap-recordings.json), [full backend gate output](../../.omp/evidence/physical-file-backend-tests.log). Compiled installer and release-gated live recorder activation were not run.

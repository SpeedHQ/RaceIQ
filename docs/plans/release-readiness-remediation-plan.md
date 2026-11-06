# Release-readiness remediation

Implementation plans:
- UI: [release-readiness-remediation-ui-plan.md](./release-readiness-remediation-ui-plan.md)
- Backend: [release-readiness-remediation-backend-plan.md](./release-readiness-remediation-backend-plan.md)
- Shared integration boundary: [release-readiness-remediation-contract.md](./release-readiness-remediation-contract.md)

## Goal
Repair the observed candidate-SHA failures without weakening behavioral assertions. Keep user data, existing planning documents, and unrelated branch work intact. Candidate: `25165833f7a55961cdc255d15bf236c00bb4c7b4`.

## Acceptance criteria
- **R1 — Compile:** all affected packages typecheck and the release-equivalent Windows compile succeeds.
- **R2 — Resolver/catalog:** native collection source values resolve in packet order; generated catalog and compatibility contracts agree.
- **R3 — Recording/import:** backend, session identity, AC Evo/ACC recording, iRacing IBT, and capture publication/import integration regressions pass with original bytes and correct lap classification.
- **R4 — Runtime/platform:** worker SQL, capture maintenance, shutdown, candidate database upgrade, and Windows temporary-data cleanup tests pass under Bun 1.4.4 / Node 24 without unrelated file/data mutation.
- **R5 — Browser integration:** actual compiled UI fresh-install, production import, replay, comparison, sessions, and seeded iRacing Compare scenarios pass; retain only expected environmental skips.
- **R6 — Evidence:** rerun full uncached tests/build and relevant end-to-end scenarios, record exact commands and outcomes; do not claim release readiness while any failure or required platform evidence remains.

## Observed evidence
- Lint, shard manifest, i18n key check, telemetry catalog generator check passed.
- Typecheck/build found missing iRacing replay search fields, unused `fileURLToPath`, unused `x`/`z`.
- Initial uncached suite summary: 4,795 passed, 84 failed, 5 skipped. Fixed resolver/catalog, recording-classification/identity, navigation, replay, sessions cleanup, and runtime regressions. Full-suite rerun remains red on unrelated LMU `fsync` (`EPERM`) plus Windows concurrency/resource-lifecycle failures; telemetry-core remains owner-restricted and unchanged.
- Focused compiled-browser E2E rerun: 36 passed / 1 failed. Cars catalogue (including iRacing), replay mobile/workspace, Spectate, cleanup, and seeded iRacing/A-EVO Compare passed. Remaining sessions E9 test fails during LMU fixture seed because Windows `fsync` returns `EPERM`.
- Candidate upgrade rerun: 19 passed / 2 failed. Historical Tourist migration still returns `MOVE_ACTIVE`; UDP conflict splitting receives HTTP 409 instead of 202. One terminal-results test cleanup still sees Windows `EBUSY`. Database-path standalone remains unverified after final changes.
- Lint, typecheck, Windows release build, shard manifest, i18n key check, telemetry catalog generator check passed under Bun 1.4.4 / Node 24.20.0. Linux/AppImage, installer, live iRacing evidence unavailable. Exact-SHA CI jobs remain queued, not passing.

## Implementation steps
1. Fix R1 blockers with regression-safe navigation route contract tests and typecheck.
2. Trace each R2 failure through catalog definitions, generated artifact provenance, and resolver consumer API; update source and regenerate only where authoritative generation requires it.
3. Trace recording/identity failures (R3) from failing assertions to production state transitions. Repair implementation, not expected outputs; keep raw-byte, gap, and ownership invariants.
4. Reproduce Windows-only R4 failures in focused tests; fix actual shutdown/resource ownership and maintain deterministic per-test isolation. Do not increase timeouts or suppress errors without proof of a timing-only cause.
5. Fix R5 UI integration failures from Playwright traces and production request/response evidence. Keep production server integration; do not replace with mocks or weaken assertions.
6. Run focused regression suites after each slice. Then rerun full uncached lint/typecheck/build/test/recording/E2E gates and candidate upgrade.
7. Recheck exact-SHA CI/release platform evidence. Report READY only if all release acceptance gates pass; otherwise list remaining external proof blockers.

## Verification scenarios
- **E1 / R1:** run client and affected package typechecks; compile Windows executable with candidate runtime and start isolated binary on 3117; observe successful HTTP readiness.
- **E2 / R2:** unit/integration assertions resolve structured collection packets to expected positions; generator `--check` passes without stale artifact.
- **E3 / R3:** production import of committed IBT preserves source bytes and valid laps; capture completion/disconnect finalizes once; real recording-backed suites retain expected lap identities and gaps.
- **E4 / R4:** candidate boot against release DB reaches reconciliation completion; API preserves historical sessions/recordings; Windows temp DB/worker processes close before cleanup; shutdown marker and migration API outcomes match asserted contracts.
- **E5 / R5:** compiled actual application, isolated seeded DB, Chromium: complete fresh-install to home, import original capture, select two distinct iRacing laps and render Compare/Spectate/replay, inspect requests/errors/screenshots.
- **E6 / R6:** complete uncached suite commands and report all counts/skips; exact-SHA Windows/Linux release jobs and live simulator exercise remain explicit external scenarios if no local runner/device exists.

## Constraints and risks
- Verification run previously modified `test/e2e/output` SVGs. Those generated outputs were saved to `%TEMP%/raceiq-verify-2BUIe9/generated-test-output` and restored. Avoid repeating writes in the user worktree; run in disposable SHA worktree.
- Existing `playwright/test-results` and user `data/` are protected; use isolated checkout/data directories.
- Disabled owner `@raceiq/game-lmu` remains excluded by repository runner policy; its enabled `@raceiq/game-lmu-tests` failures still count.
- Available runtime accepted by user: Bun 1.4.4 and Node 24.20.0.

## Status
In progress.

# 3 to Improve — implementation verification

Contract: [shared contract](3-to-improve-contract.md). Implementation plans: [UI](3-to-improve-ui-plan.md), [backend](3-to-improve-backend-plan.md).

## Outcome

The integrated feature passes the canonical compiled-app session-analyse suite: **21 passed**. Broader regression verification is **not fully passing**: three existing replay-workspace scenarios failed. This report does not claim those failures predate this branch; a baseline run was not performed. The feature should remain under review until those failures are triaged.

The application uses real imported native recordings, SQLite persistence, version-aware detectors, distance alignment, typed HTTP services and on-demand evidence. Successful integration tests do not intercept coaching responses.

## Acceptance mapping

| Scenarios / criteria | Executed evidence | Result |
| --- | --- | --- |
| TI-E1; TI-1/2/6, TI-U1, TI-B1 | `coaching-signals.spec.ts`: exact ranked families, repeated counts, whole-session independence, distinct locations and evidence activation. Existing group-review cases preserve selection and both session routes. | Passed |
| TI-E2; TI-1/2/4, TI-U1/U3, TI-B1/B3 | Zero/one/two native signal cases; one supporting lap uses single-lap wording. | Passed |
| TI-E3; TI-2/3/4, TI-U1/U2/U3, TI-B1/B2/B3 | `coaching-distance.spec.ts`: nonlinear recorded distance differs from sample fraction; source frames 0/15/16/599 map to start, opposite sides of a bucket boundary and final fraction 1. Actual detail and UI open at the final point. `coaching-capture-integrity.spec.ts` rejects indices -1/999999 and absent distance. Manual ACC recording inspection displayed curated Paddock Hill Bend/Druids; native fixtures exercise percentage fallback. | Passed |
| TI-E4; TI-3/5/6, TI-U2/U3, TI-B2/B3 | Signal/detail tests assert exact representative, fraction and source trace values; keyboard dismissal restores focus. Missing capture/lap returns insufficient data/404; stale evidence rejects rather than substituting. | Passed |
| TI-E5; TI-2/4/5, TI-U3, TI-B1/B3 | Eligibility, missing-evidence and capture-integrity cases exclude invalid/non-pace/experiment-excluded laps, distinguish missing inputs from absent findings, and verify exact counts. Production exclusion mutation changes scope 3→2→3. | Passed |
| TI-E6; TI-4/5, TI-U3, TI-B3 | Lifecycle fixture controls enforce session/lap processing 409, failed 422 and ready recovery through the actual app. | Passed |
| TI-E7; TI-2/4/5, TI-U3, TI-B3 | API cases validate malformed/unsafe identifiers, game headers, wrong game and missing session. Corrupt authoritative capture manifest propagates 500, not empty success. | Passed |
| TI-E8; TI-1/3/6, TI-U2/U4, TI-B4 | Desktop/mobile screenshots, four readable channel traces, no horizontal overflow, keyboard focus restoration, real persisted German/imperial and metric preferences. Compact summary and bounded single-lap detail asserted. | Feature passed; broader replay regression has failures below |
| TI-E9; TI-2/5/6, TI-U3/U4, TI-B1/B2/B3/B4 | Lifecycle stale version with cleared cached findings recomputes from raw recording; session/game switches, deletion and source disappearance cannot reuse another session's cards. | Passed |

Pure selector tests supplement integration for ranking ties, duplicate points, unknown findings and boundary behavior. They do not replace the compiled application scenarios above. Shared experiments and single-lap consumers were exercised separately; three replay layout/navigation assertions remain unresolved.

## Commands and outcomes

Run package commands from `packages/session-analyse` unless stated otherwise.

| Command | Outcome |
| --- | --- |
| `bun run test:e2e` | 21 passed, including setup and existing session-review regressions |
| `bun run test:unit` | 7 passed |
| `bun run test:integration` | 5 passed |
| `bun run test:boundaries` | Passed |
| Root `bun run typecheck` | 42 tasks passed |
| Root `bun run lint` | 40 tasks passed |
| Root `bun run build:browser` | Passed |
| Shared source-loader, lap-read-batching, lap-cache and persist-lap-metrics tests | 44 passed across four files |
| Changelog checks | 11 passed |
| Locale validation and Paraglide compilation | All 32 coaching keys and placeholders present across 16 locales; compilation passed |
| `playwright`: `bun x tsc --noEmit` | Failed: 22 errors in untouched LMU/sessions-page specs/support; no coaching-file errors |
| Targeted shared UI regression command below | 11 passed, 3 failed |

Shared UI regression command, from `playwright`, with the same compiled seeded launcher, isolated DATA_DIR and feature flags as the package E2E script:

```sh
bun ../scripts/playwright-ci.ts test --config=playwright.config.ts \
  --project=lap-replay --project=seeded-e2e --workers=1 \
  --output=test-results/coaching-shared-regression \
  analyse/workspace.spec.ts compare/spectate-insights.spec.ts \
  seeded/experiments/f1-lifecycle.spec.ts \
  seeded/experiments/disposable-lifecycle.spec.ts
```

Failures in untouched `packages/lap-replay/test/e2e/analyse/workspace.spec.ts`:

- Desktop and 390px playback/insight scenarios reach `/fm23/sessions/2/replay/4?opponentRefInvalid=false`; line 213 expects a URL ending exactly `/replay/4`.
- 1600px panel-resize scenario measures 796px; line 301 requires at most 696px.

No assertions were weakened and no unrelated replay fixes were included. Passing shared scenarios include the experiment lifecycle and spectate-insights paths.

## Local artifacts and limitations

Full local logs and screenshots live under ignored `.omp/evidence/3-to-improve/`: `canonical-e2e.log`, `shared-ui-e2e.log`, `playwright-typecheck.log`, root gate/build/unit/integration/shared-helper/locale logs, `browser-smoke.json`, and `overview-{desktop,mobile}.png` / `evidence-{desktop,mobile}.png`. These artifacts are workstation evidence, not files available from a fresh Git checkout. Failed Playwright runs also retain traces under `playwright/test-results/` locally.

The final browser check measured a 422px evidence chart with speed/brake/throttle/steering readouts; 390px layout showed three stacked cards without horizontal overflow. Managed-browser screenshot attempts timed out; an independent page-only Playwright browser captured the actual application successfully. No desktop automation was used. Language/unit checks use the real settings API plus page reload, not the Settings dialog.

Full unrelated repository E2E, native Windows behavior and hardware telemetry capture were not run. Coaching remains observational guidance from existing detectors, not measured time-saving advice. Overall regression acceptance remains open pending the three replay failures and the separately failing full Playwright compiler.

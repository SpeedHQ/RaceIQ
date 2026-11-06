# Review fixes UI plan

[Shared contract](review-fixes-contract.md) · [Backend plan](review-fixes-backend-plan.md)

## Scope and ownership

Independent OMP scopes: readiness/store/comparison (AC5/7/10), replay runtime (AC8/9/11/18), update UI (AC12, same bounded update owner as backend). Main owns integration and verification. Preserve incumbent UI; no redesign or telemetry relabeling. Production data contracts remain unchanged except shared update capability. Fixtures may conform to the contract while backend work proceeds; no fixture fallback ships.

## Acceptance, handling, E2E

| ID | Observable acceptance and solution | Edge/failure handling | Concrete E2E scenario |
|---|---|---|---|
| AC5 | Accepted capture-readiness events invalidate `track-laps` alongside existing queries | Preserve stale-attempt filtering and terminal/debounced refresh | Shared E5 |
| AC7 | Dismissed unchanged terminal classification notice stays dismissed after unrelated revisions | Reopen for new work or changed actionable results; preserve active-run dismissal behavior | E7: actual app dismisses completed notice, records unrelated session, notice stays closed; new run/changed failure reopens |
| AC8 | Renderer/resources initialize without current pose; cars hidden until valid pose | Paired missing poses recover independently; model/renderer errors remain errors; seek during model loading recovers | E8: compiled replay starts with unavailable pose then valid telemetry; same scene becomes visible without Retry; repeat pair/gap during load |
| AC9 | Consumed wear increase yields positive rate; replacement resets history | Null values, seeks, gaps, consumed-wear decrease produce no false spike | E9: actual replay tire label driven by 0.100→0.101, then replacement to zero; label shows positive degradation and no replacement spike |
| AC10 | Cached comparison bookmark restores the map cursor | Initial mount and empty chart-initialization callbacks must not clear restored refs; actual pointer interaction and genuine local selection changes retain their reset behavior | E10: preload client comparison cache through SPA navigation, return to bookmarked URL, wait for deferred map markers at the requested position, then change selected lap and assert reset |
| AC11 | Equal elapsed playback gives equal wheel rotation independent of callback rate/FPS cap | Pause/hidden/resume do not accumulate stale elapsed time | E11: real replay runtime under controlled 30/60/120Hz callbacks and 30fps cap yields equal integrated rotation; pause/hide/resume no jump |
| AC12 | Settings/modal external action follows shared capability; no Windows install on Linux | Docker text retained, Windows Install retained, check failure safe; translate new copy in every locale | Shared E12 |
| AC18 | Render deadline checked before full telemetry interpolation | Active playback and interactions still schedule; paused clean frame does not spin; seeks/resizes remain responsive | E18: real replay with two cars counts interpolation at capped deadlines; interaction wakes; compare same-duration controller/rotation and bounded allocation work |

## Tasks and verification

Read affected consumers and existing tests. Implement smallest complete changes and behavioral regressions. Workers skip tests/builds/lint/formatters. Extend existing compiled Playwright replay/comparison/readiness surfaces, not new broad harnesses. Main runs E5/E7–E12/E18, captures targeted browser visual evidence where available, records exact failures and unavailable native qualifications, then runs applicable gates and `bun run typecheck`. Unit/runtime tests supplement app integration; planned or blocked E2E is not completion evidence.

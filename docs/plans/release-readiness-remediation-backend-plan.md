# Backend remediation plan

Shared contract: [release-readiness-remediation-contract.md](./release-readiness-remediation-contract.md). UI plan: [release-readiness-remediation-ui-plan.md](./release-readiness-remediation-ui-plan.md).

## Scope and ownership
Repair backend/shared behavior and broken tests identified by candidate verification: telemetry resolution/catalog, imports/recording classification, worker SQL, shutdown/resource ownership, and candidate database upgrade. Own related `apps/backend`, `server`, `packages/*` production code and tests, excluding client presentation. Keep existing endpoint/data contracts unless evidence proves implementation and authoritative contract diverge; update shared contract and inform UI owner before any boundary change.

## Acceptance criteria and edge handling
- **BE1:** native structured collection values resolve in packet order; malformed shape/type and missing values remain rejected/unavailable. Generated catalog is current. Maps to R2/IC2.
- **BE2:** IBT/ACC/AC Evo ingestion preserves source bytes, identities and true lap classification including invalid/outlap/incomplete edges. Maps to R3/IC3.
- **BE3:** capture completion, duplicate content, disconnect, retry, cleanup and recovery preserve atomic publication and never resurrect deleted files. Maps to R3.
- **BE4:** Windows worker/database handles close before teardown; shutdown drains owned work; test state stays isolated. Maps to R4.
- **BE5:** candidate startup reconciles release DB and keeps existing sessions/recordings; layout migration returns declared status only after recording locks are clear. Maps to R4.
- **BE6:** iRacing incident and compare APIs return existing contracts for valid/missing/malformed evidence; malformed owned frames fail rather than being suppressed. Maps to IC1–IC4.

## Tasks
1. Reproduce each failure in isolation, inspect full assertion and owner/state path, and rank environmental versus product cause. Do not rerun just to confirm known failures.
2. Repair authoritative catalog definitions/normalization and regenerate generated files using repository generator only when required.
3. Fix actual recording/import identity and state-transition defects; preserve exact input bytes, recorded gaps and ownership boundaries.
4. Fix Windows process/database resource ownership and shutdown sequencing; no timeout-only relaxation absent evidence.
5. Fix migration/upgrade transaction coordination while preserving candidate behavior and real API assertions.
6. Coordinate contract changes before the UI work continues.

## Verification and E2E
- Focused package/backend tests for each repaired invariant; `bun scripts/ci/check-telemetry-catalog.ts`.
- Database path, candidate database upgrade, recording and integration suites uncached.
- Shared production integration E2E defined in the [contract](./release-readiness-remediation-contract.md): isolated candidate server + released DB for upgrade; real seeded/app-imported IBT for IC3; real API requests and visible Compare/replay result for IC1–IC4. Unit/mocked tests supplement only.
- Final integration owner runs full suite and compiled application E2E; record totals, skips, every failure and artifact location. Required edge cases must pass in E2E before declaring complete.

## Status
In progress.

# Test Coverage Gaps

Track confirmed, unresolved gaps in behavioral coverage. This is not a general testing wishlist or a list of skipped tests. Passing tests do not prove behavior listed here.

Each entry must name the missing behavior, evidence or blocker, coverage that remains, and concrete acceptance criteria for closing the gap. Remove an entry once those criteria are exercised successfully; implementation history belongs in version control.

## AC Evo valid-session telemetry reuse

**Missing coverage:** Seeded browser coverage for AC Evo session review reusing base aligned telemetry across sector/view interactions and requesting higher-resolution telemetry only for a selected detail range.

**Evidence and blocker:** The AC Evo seed in `packages/tooling-data/src/data/seed-db-options.ts` uses `session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz`. Import produces four invalid laps:

- Partial-start lap: `start/end positions too far apart`.
- Two laps: `track limits`.
- Final lap: `incomplete`.

None qualifies for `/api/laps/review`. Other checked-in AC Evo recordings also yielded no valid complete laps during investigation. Do not bypass validity filtering or relabel invalid telemetry to satisfy the test.

**Existing coverage:** [`group-review.spec.ts`](../../playwright/tests/seeded/analyse/group-review.spec.ts) actively verifies AC Evo invalid-session status, exclusion from valid review selection, the dashboard's invalid-lap indicator, and lap-header navigation back to session review. ACC exercises base-telemetry reuse, sector/view interactions, and detail-range requests. No case is skipped for this fixture limitation; ACC coverage does not establish AC Evo parity.

**Close when:**

1. Add a real AC Evo recording containing a valid complete lap with replayable telemetry to the seed.
2. Add an active AC Evo telemetry-reuse scenario asserting the review-selected lap IDs, `step: 1` base requests, absence of semantic-telemetry requests across interactions, and bounded `step: 0.1` detail requests.
3. Run the focused seeded browser spec successfully, retaining invalid-session coverage against an all-invalid recording.

```sh
cd playwright
E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test \
  --project=seeded-e2e tests/seeded/analyse/group-review.spec.ts --workers=1
```

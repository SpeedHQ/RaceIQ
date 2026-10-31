---
name: raceiq-online-isolated-qualification
description: "Qualify RaceIQ Online across browser SPA and Cloud using Infisical test identity, isolated data, safe deletion fixtures and genuine native recordings."
---

# RaceIQ Online isolated qualification

## Safety boundary

- The dedicated hosted Supabase credentials are in the RaceIQ Infisical project's `prod` environment, `/testing`: `SUPABASE_TEST_USER` and `SUPABASE_TEST_USER_PASSWORD`.
- Retrieve/inject credentials without printing or persisting values. Use hosted auth only; route application mutations to isolated loopback Rust API/SQLite/files.
- Preserve the shared hosted identity. Full deletion scenarios use disposable local data and a controlled identity-provider fixture. Hosted provider deletion requires a separate disposable identity and explicit authorization.

## Entry points

In the Cloud checkout:

```sh
infisical run --env=prod --path=/testing -- bun run smoke:test-user
bun run e2e:online-website
RACEIQ_DESKTOP_REPO="/path/to/RaceIQ" RACEIQ_E2E_BROWSER_BINARY="/path/to/RaceIQ/dist/raceiq" bun run e2e:online-desktop
```

Verify these commands still exist before using them. Browser harnesses rebuild the same website output with different auth fixtures: run sequentially. Rebuild with deployment configuration before publishing output.

- `smoke:test-user`: hosted password-grant auth, isolated real Rust API consent/preferences/profile/contributions. Local exclusive lease rejects concurrent runs with `TEST_ACCOUNT_BUSY`; CI must serialize across machines. Stop owned services before deleting owned DB/files/lease. Do not remove another run's lease.
- `e2e:online-website`: real website/API/admin-worker/SQLite, controlled IdP; board personalization, friendship transitions, profile/statistics, export cross-account isolation, deletion reauth/schedule/cancel. Historical seeded archive rows do not prove native publication.
- `e2e:online-desktop`: actual browser SPA and Cloud consent return; genuine F1 publication/archive/import/replay. Initial controller HTTP import populates empty local car catalogue; Community then reopens existing import. Do not call this first-import-through-Community coverage.

## Native lifecycle / fault tests

Desktop fixture scripts under `apps/backend/test/fixtures/`:

- `online-upload-native-source.ts`: use a fresh canonical OS temporary `DATA_DIR`. `/var` versus `/private/var` aliases can fail safety checks. With `RACEIQ_TEST_MODE=1`, producer writes `test.db`; consumers may expect `app.db`. Preserve source identities when adapting the isolated fixture.
- `online-upload-lifecycle-smoke.ts` and `online-upload-http-recovery-smoke.ts`: configure `RACEIQ_CLOUD_ROOT`, `RACEIQ_UPLOAD_SOURCE_DATA_DIR`, `RACEIQ_UPLOAD_TEST_CERT`, `RACEIQ_UPLOAD_TEST_KEY`.
- HTTP fault settings: `RACEIQ_UPLOAD_RESERVATION_FAULTS=429,503,disconnect`, `RACEIQ_UPLOAD_TRANSFER_FAULTS=503,disconnect`.
- Correlate faults, Retry-After deadlines, immutable bytes, and lost-response restart by each lap's request key. Two game winners are not one global request identity.
- Test keystore is process-local. Restart reauthentication does not prove OS-keystore persistence.

## Harness pitfalls

- Reverse proxies must preserve upstream redirects (`redirect: 'manual'`) so browsers receive redirect and cookie semantics.
- Deletion IdP fixture needs provider snowflake IDs, matching owner, fresh distinct session ID, `is_anonymous: false`, Discord app metadata and fresh OAuth AMR. Do not weaken production checks to accommodate invalid fixtures.
- Use published catalogue IDs, exact accessible locators, and wait for mutation response/completed state before API readback.
- Contribution lap GUID membership must match metrics. Assert exact rendered totals, not incidental body numbers.
- Run timing-sensitive LMU/Bun regression cases without competing native workloads before diagnosing timeout failures. Never enlarge timeouts or weaken assertions merely to pass.
- Optional Cloud LMU slice tests accept `RACEIQ_LMU_NATIVE_FIXTURE`; a genuine desktop Bahrain recording can exercise otherwise skipped cases. Verify fixture suitability first.

## Evidence limits

Report passed, failed and blocked scenarios separately. Genuine-source retention thresholds must not be manufactured using copied identities or edited times. Five-game publication, populated history UI, faster-winner replacement barriers, deletion races, terminal hosted rejection and real keystore restore require their own evidence. A broad passing regression suite does not prove these paths.

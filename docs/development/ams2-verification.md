# AMS2 verification status

This is the evidence inventory for the AMS2 review branch, not a claim that the
entire new-game checklist is complete. The existing source implementation is
unchanged by the fixture organization work.

## Run the focused checks

From the repository root:

```powershell
bun run --filter '@raceiq/game-ams2' test:integration
bun run --filter '@raceiq/game-ams2' test:e2e:recordings
bun run --filter '@raceiq/telemetry-processor' test:unit
bun test apps/backend/test/lap-analysis/lap-export-zip.test.ts --timeout 60000
bun run typecheck
```

The two AMS2 suites use temporary isolated data directories. They do not open
the driver's real session database. The package E2E command is also included
in the root `bun run test:e2e:recordings` task. Browser Playwright coverage is
separate and has not been added for AMS2 yet.

## Existing automated evidence

| Area | Evidence | Limit |
| --- | --- | --- |
| Parser/source | Controlled-memory tests cover ABI rejection, malformed frames, input/fuel/pressure conversion, duplicate frames, pause/replay, and capture diagnostics. | A fake reader does not exercise Windows memory acquisition. |
| Raw recording | Tests cover pre/post-session frames, menu-driven finalization, gzip reading, and full mapped extensions. | A readable dump alone does not prove clean shutdown after a hard stop. |
| Production sparse recording | Tests cover exact frame restoration across checkpoints and frame-size changes. | Reduced fixtures do not prove full-rate capture performance. |
| Raw recording E2E | Four real-source fixtures run through the source guard, parser, and lap detector with an in-memory persistence adapter. Session finalization is asserted before EOF cleanup. | This is not the full live pipeline, disk database, WebSocket, or browser flow. |
| Lap outcomes | Fixtures assert session types, completed timing, Time Trial lead-in crossings, race-start validity, pit reasons, sparse qualifying rejection, and incomplete tails. | Native sectors and delta-to-best checkpoints are not independently validated. |
| Numbering and duplicate saves | E2E checks expected Time Trial/race/qualifying lap sequences, unique completed session/lap keys, and one save log per completed lap. | Full UI event delivery is not exercised. |
| Timestamp/provenance | Fixture hashes, sizes and frame counts are checked; acquisition times stay chronological and are preserved in dispatched packets. | Hashes describe reduced published fixtures, not full byte-for-byte originals. |
| Driving channels | Race checks finite values, broad speed/pedal/RPM ranges, gear changes and position variation. | These checks do not substitute for independent in-game unit/calibration observations. |
| Standalone exports | Backend tests verify sparse AMS2 windows decode independently with unchanged source frames and timestamps. | Browser-driven download/import round trips remain untested. |
| Portable parsing | Shared processor tests replay Time Trial and pit-stop race captures using the same AMS2 parser and lap policy as the host adapter. | Raw-import stale transition filtering is still distinct from the live source guard. |

Fixtures and provenance: [AMS2 fixture notes](../../test/artifacts/sessions/ams2-fixtures.md).
Tests: `packages/game-ams2/test/e2e/recordings.test.ts`.
Raw capture setup: [AMS2 dump recording](ams2-dump-recording.md).

## Real-game observations already supplied

The driver supplied Windows dump-mode captures for Time Trial, a race with a
pause and manually driven pit stop, a practice/qualifying/race weekend, and a
later healthy qualifying run. These captures provide real source bytes rather
than synthetic telemetry. Existing lap-time expectations come from the earlier
recording review; complete independent sector/delta observations were not
supplied. No new driving or manual UI validation is claimed by this change.

## Still open

- Earlier qualifying capture contains only 104 snapshots. The later qualifying
  run is healthy; the original capture loss has not been reproduced or explained.
- The live source filters one stale qualifying-to-race transition; raw import
  does not apply that source guard.
- Incomplete cooldown entries remain saved as invalid/incomplete.
- Car/track names are discovered; complete catalogs, common circuit mappings,
  and per-layout extracted edge SVGs are not supplied.
- Source specifications need their own attributed/versioned reference material
  under `docs/reference/external/ams2/`, with redistribution permission checked.
- Required independent clean/unclean, native sector and best-lap/delta evidence
  is incomplete. The current reduced/multi-session fixtures do not fulfill the
  guide's exact single-capture six-lap coverage requirement.
- Full pipeline/disk persistence and browser navigation, reconnect, dashboard,
  Analyse/Compare, and UI export/import E2E coverage remain incomplete.
- 100 Hz capacity, sustained recording, p95 latency, bounded queues, retained
  heap/RSS and an agreed memory budget still require measured benchmarks.

Setup editing/import/export is optional for core support and remains outside
this work. Consult [adding new game support](../contributing/adding-new-game-support.md)
for acceptance requirements rather than treating this inventory as approval.

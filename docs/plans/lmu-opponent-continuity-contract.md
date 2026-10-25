# LMU opponent continuity contract

Status: Approved continuity, standalone replay, button navigation and opponent-height scope implemented; E1–E5 behavioral evidence is recorded in the linked plans and [verification results](../../.omp/evidence/opponent-repair-verification.json). Native recordings remain unchanged; no reseed, reimport or checkpoint was required. Repository-wide typecheck still reports an existing roundtrip-test TS2345, documented in the backend plan. Original Antonio comparison alignment remains deferred and is not claimed repaired.

Plans: [Backend](lmu-opponent-continuity-backend-plan.md), [UI](lmu-opponent-continuity-ui-plan.md). Main orchestrator owns this contract and integrated verification. Backend owns derived indexing; UI owns playback and Sessions entry.

## Authorities and boundary

Reuse [opponent DTOs](../../packages/lap-replay/contracts/opponents.ts), [native indexing](../../server/lap-analysis/lmu-opponent-laps.ts), [index format](../../server/lap-analysis/lmu-opponent-index-schema.ts), [source loader](../../server/session-capture/source-loader.ts), [recording maintenance](../contributing/scheduled-recording-maintenance.md), and [semantic rules](../reference/semantics.md). No new HTTP operation or authentication behavior.

- `GET /api/laps/:id/opponent-laps`: existing required `X-Game-Id: lmu`, positive player-lap anchor, index readiness, retention and source revision semantics remain authoritative. `sessions` group real simulator sessions and vehicle incarnations, not player acquisition generations or lap files. `laps` represent source-backed opponent lap intervals, not fragments created solely by player capture splitting. Preserve existing ordering and opaque identity fields.
- `GET /api/laps/:id/opponent-laps/:opponentLapId/semantic-telemetry?sourceRevision=...`: existing opaque nonempty string identity/revision and semantic envelope response remain unchanged. Preserve original capture keys, timestamps, values, states, freshness and provenance. Native observation deduplication may retain one envelope per unchanged source observation; do not manufacture 50 ms samples from 200 ms scoring updates.
- Existing comparison and export operations continue consuming the same corrected interval identity. Do not add a player-only fallback or change native recording/export bytes.
- Existing error body `{ code: string, error: string }` and statuses remain: malformed 400, missing lap/interval 404, stale revision/index pending 409, removed 410, unavailable/failed 422, storage failure 500. Rebuilt indexes may change opaque opponent IDs; old IDs must fail explicitly, never select a different interval.
- Standalone UI uses `/$gameid/sessions/$sessionId/replay/$lapId?opponentLap=<id>&opponentRevision=<revision>`. Route lap ID is only the source-access player anchor. Opponent metadata is discriminated, never fabricated as player `LapMeta`. Both query fields are required together; non-LMU or malformed references show unavailable, never player replay.

Representative reference: `{ "kind": "opponent", "playerLapId": 26, "opponentLapId": "opaque-indexed-interval", "sourceRevision": "native-source-revision" }`. Lap time remains nullable when native full-lap timing is unavailable. Partial coverage may still carry a known native lap time; preserve that value. Playback duration describes the recorded interval, not a claimed completed lap.

## Acceptance criteria

- OC1: Native player-file/acquisition splits do not create separate opponent sessions/lap rows when native simulator identity, scoring clock, vehicle and incarnation remain continuous.
- OC2: True simulator session/event/track changes, scoring clock resets, and vehicle reincarnations remain separate. Missing native identity is conservative: retain separation rather than guess. Never group by driver name alone.
- OC3: Every native opponent observation and original capture/provenance identity survives corrected indexing. Source gaps remain explicit; incomplete coverage never becomes complete merely because fragments are grouped. No native files are rewritten or concatenated.
- OC4: Old index algorithm publications become incompatible and rebuild through existing background maintenance. Catalog/status reads do not perform full native scans or writes. Preserve scheduling, recording admission, atomic publication and failure recovery.
- OC5: Sessions offers shared Replay and Compare buttons using router navigation, not anchor elements, for their respective available opponent capabilities. Preserve exact source anchor/interval/revision. Standalone replay shows the opponent car, native speed/position and recorded path at ordinary 200 ms scoring cadence. No borrowed player telemetry, player-only AI or fabricated controls.
- OC6: Playback/scrub/reload works for partial and complete intervals. Adjacent native observations can animate at their real source cadence; genuine missing sequences, invalid positions and long gaps stay visibly disconnected/unavailable. Player replay's existing continuity rules do not change. Sparse trajectory connectors remain visibly estimated rather than asserted native intermediate samples.
- OC7: Pending, failed, removed, corrupt, missing, stale and malformed references remain explicit. Existing own-lap replay remains functional. Desktop and mobile layouts keep car, path and playback usable.
- OC8: Opponent cars and all opponent replay path variants render on the track's world plane (`y = 0`) in standalone replay and comparison. Preserve original recorded elevation in telemetry values, source files and exports. Player rendering remains unchanged. Existing recordings require derived index maintenance only, not reseeding or reimporting.

## Edge handling

| Case | Handling | Criteria |
| --- | --- | --- |
| Player lap file split or acquisition generation changes with unchanged native session and continuous scoring clock | Group source observations into the same opponent session/lap; preserve original capture keys internally | OC1, OC3 |
| Actual event/session/track change or scoring clock rollback | Start a distinct opponent session; do not splice trajectories | OC2 |
| Same vehicle ID reappears with different incarnation | Keep separate interval identity and metadata | OC2 |
| Missing source metadata | Keep conservative existing separation; do not infer from matching names | OC2, OC3 |
| Missing capture/scoring observations | Preserve discontinuity, partial coverage and disconnected path; no fabricated values | OC3, OC6 |
| Expected 200 ms scoring updates within faster capture ticks | Retain source observations and timestamps; render source-aware playback instead of treating every ordinary update as loss | OC3, OC5, OC6 |
| Incomplete lap without full timing | Display unknown lap time; seek across recorded interval duration | OC5, OC6 |
| Old publication or old deep link | Background rebuild; explicit stale/missing response for obsolete IDs, no wrong-interval fallback | OC4, OC7 |
| Removal, failed preparation, non-LMU or incomplete query | Existing localized unavailable/error/readiness states, no player replay fallback | OC7 |
| Sessions Replay/Compare navigation | Render shared buttons; use router navigation with the unchanged destination, source anchor, opponent ID and revision; no anchor elements | OC5, OC7 |
| Native opponent elevation differs from the flat track visualization | Ignore height in opponent render poses and all native/projected/estimated path geometry; preserve source telemetry and player rendering | OC3, OC8 |

## Shared E2E scenarios and evidence owner

Main orchestrator owns execution and records outcomes in the implementation plans. Reuse the existing LMU backend import/route suite and Playwright real-recording Sessions suite; tests use actual import, persisted indexes, HTTP routes and browser renderer, not mocked application integration.

- E1 / OC1–OC4: Import a deterministic native recording crossing multiple player/acquisition splits while an opponent lap continues. Await normal maintenance. Assert one source session/incarnation/lap interval across artificial splits, exact ordered source observations/provenance, and no native-byte mutation. Add real event/clock/incarnation transitions and assert separation.
- E2 / OC3–OC4, OC7: Present an obsolete publication, restart/reconcile through production maintenance, observe pending then ready, verify corrected catalog without request-time backfill. Exercise source removal/failure/stale IDs and explicit errors.
- E3 / OC1, OC3, OC5–OC7 has two required real-source scenarios. E3a extends the existing isolated OS-E3 browser import of the committed sampled real recording: Sessions → Replay, exact source pose/speed, explicit sample gaps, estimated path, scrub and reload. It must not treat sampled gaps as contiguous native observations. E3b uses the full recording already imported through the production demo/source path (the committed October 22 multipart capture): expand Sessions, select player anchor 26 in session 9 in the supplied dev environment, choose Antonio's corrected lap, click Replay. Assert exact identity, one ready opponent car, numerical native speed/position, visible path, advancing playback, exact-source scrub, partial/unknown timing and reload. Confirm no player semantic or comparison endpoint is requested. Run desktop and mobile. Native file hashes must match the saved pre-rebuild baseline.
- E4 / OC2, OC3, OC6–OC7: Use deterministic native controlled captures through actual import/indexing/routes/renderer for expected 200 ms scoring updates, genuine source gaps, invalid positions and long gaps. Ordinary cadence remains visible; true gaps remain disconnected. Reuse the existing fixture factory with a minimal test-only cadence control if necessary; do not mock the integration or manufacture real-source observations. Open an ordinary player replay to confirm unchanged behavior.
- E5 / OC3, OC8: Extend E3/E4's actual imported replay with nonzero opponent elevation. Verify native API values retain elevation, while the rendered car and each active path geometry use the track plane at an exact sample and after scrub, including comparison's opponent side. Inspect an oblique view to detect floating geometry. Verify player height remains unchanged through the existing core regression. E2 and the production-imported full source demonstrate that reseeding is unnecessary.

The user subsequently added OC8. Completion also requires E5; initial E3/E4 results do not prove the later height repair.

Completion requires passing E1–E4, including E3a and E3b. Planned, blocked or unexecuted scenarios are not passing evidence. Full-source diagnostic baseline is recorded at `../../.omp/evidence/opponent-native-continuity-baseline.json`: 30,957 native frames; Antonio lap 7 has 2,555 captures and 151 distinct scoring timestamps across seven acquisition keys over 30 seconds. The currently selected fragment has only 28 updates over 5.4 seconds, but those extracted values match native values exactly. Native event 16/session 1/lap 7/distance remain unchanged at inspected acquisition transitions. Eight native file hashes are saved for post-rebuild verification. This is diagnostic evidence, not completion.

# Recording and importing telemetry

Collect raw packet dumps to reproduce parser and lap-detection problems and to
preserve regression fixtures.

## Capture a session

Use the game-specific development command:

| Game | Command | Output directory |
| --- | --- | --- |
| Forza Motorsport 2023 | `bun run dev:dump:fm` | `test/artifacts/sessions/` |
| F1 2025 | `bun run dev:dump:f1` | `test/artifacts/sessions/` |
| Assetto Corsa Competizione | `bun run dev:dump:acc` | `test/artifacts/sessions/` |
| Assetto Corsa Evo | `bun run dev:dump:ac-evo` | `test/artifacts/sessions/` |
| iRacing | `bun run dev:dump:iracing` | `test/artifacts/sessions/` |
| Automobilista 2 | `bun run dev:dump:ams2` | `test/artifacts/sessions/` |
| Le Mans Ultimate (LMU) | `bun run dev:dump:lmu` | `test/artifacts/laps/` |

For AMS2, start dump mode before entering a session and leave the session before
stopping capture. Follow [AMS2 fixture instructions](../development/ams2-dump-recording.md)
for required lap coverage and independent observations.


Drive the relevant session, then press `Ctrl+C`. The shutdown handler flushes the
recorder so the file ends on a complete frame.
Drive the relevant session, then press `Ctrl+C` and wait for shutdown to finish.
LMU prints its final frame count and absolute saved BIN path only after header publication, file sync and close succeed.

All `dev:dump:*` commands enable the same global `--dump-only` mode. The game argument selects the native source and BIN format, not whether telemetry is persisted. The selected recorder keeps one BIN for the dump run; lap boundaries, session changes, and source-context resets do not create per-lap/session files. Native-source reconnects reuse the selected reader until shutdown.

Dump launchers deliberately run without `--watch`: automatic restarts or process-tree termination can interrupt recorder finalization. The launcher requests cooperative backend shutdown and awaits completion before exiting. Restart the dump command manually after changing backend code.

Dump frames are parsed only to publish the existing live WebSocket schema/frame and developer telemetry display. They bypass session/lap detection, telemetry-driven database access, calibration, and normal per-lap capture. Historical startup and scheduled maintenance do not run in dump mode. Application startup, dashboard authentication, and initial identity-catalog loading still use the database; this is not a database-free server process.

LMU diagnostic capture waits for bounded worker write acknowledgements when disk is temporarily behind, rather than failing a full queue. Scheduled acquisition pauses while that dump poll is pending, so it cannot accumulate an unbounded snapshot queue; capture cadence can fall below the selected rate during disk stalls. Accepted records remain ordered in the same BIN. Genuine writer failures still surface as errors, including subsequent write attempts. Dump runs do not create Sessions entries.

Examples:

```text
test/artifacts/sessions/fm-2023-<timestamp>.bin
test/artifacts/sessions/f1-2025-<timestamp>.bin
test/artifacts/sessions/acc-<timestamp>.bin
test/artifacts/sessions/ac-evo-<timestamp>.bin
test/artifacts/sessions/iracing-<timestamp>.bin
packages/game-lmu/test/fixtures/laps/lmu-<timestamp>.bin
```

Default LMU seed omits the broken Spa fixture and retains Sep 22 input plus the complete Oct 22 multiplayer source as 11 gzip parts. The LMU seed streams native dump frames directly; native v2/v3 input uses the production player/opponent-partitioning recorder. Do not upload historical full-frame recordings; `/api/laps/import` accepts sparse RaceIQ captures only.

## Replay a dump

Use the game's recording support with `parseDump` from
`@raceiq/backend-core/test-support/recordings/parse-dump` to replay a fixture
through production parsing and lap detection. Check the game, packet count,
car, track, and saved laps against capture notes. Reassemble split recordings
before passing the file to the reader.

Recorders use different binary formats:

- FM and F1: length-prefixed raw UDP datagrams with original receipt timestamps. Diagnostic dumps bypass sparse encoding; normal saved-session recording keeps its existing encoding.
- ACC and AC Evo: `AcRecorder` typed shared-memory frames.
- iRacing: `IRacingRecorder` SDK source frames.
- AMS2: `AMS2DMP1` raw mapped-source frames, including menus and session transitions.
- LMU: `LMURecorder` LMUQDMP format.

Use the corresponding reader or `server/test-support/recordings/parse-dump.ts` helper
rather than decoding recordings ad hoc.

### LMU player observations

LMU source frames remain readable in compact v1 and full-memory v2 form.
Source-frame v3 introduced typed player/session REST observations alongside
the native memory snapshot. Current live recordings partition those frames
into a player-only v5 primary and a separate versioned opponent companion.
Sparse records retain original timestamps and availability states. Selected-lap
ZIP export, import and historical semantic replay preserve this context.
Older captures cannot reconstruct observations they never recorded.

New DuckDB imports use compact synthetic source-frame v4 with an allowlisted,
duplicate-free channel inventory bounded to 4,096 metadata bytes. A channel is
available only when the recording contains an applicable observation; event
channels remain missing before their first event. Unrecorded player extensions
stay missing, while supplied zero and false readings remain valid. This
availability survives selected-lap export and reimport. Previously imported,
unmarked v1 frames cannot safely be distinguished from native v1 recordings
and are not retroactively reclassified. Older application versions cannot read
the new v3/v4 source formats.

Lap detection waits for a finite lap number without inventing one for earlier
observations. Missing lap numbers cannot replace an established lap number or
prevent later valid boundaries from being detected. Fuel recorded in litres
requires a usable tank capacity to resolve a percentage; values below one litre
are not interpreted as fractions. Fraction-valued sources use their declared
catalog conversions instead.

The shared decoded TypeScript contract is `LMUSourceFrame`; its name is not
tied to a source-frame version. Production native acquisition supplies context
to `encodeLMUSourceFrame` and writes v3; DuckDB imports write v4. The compact
v1 payload writer and context-free v2 writer remain for legacy compatibility
fixtures, sharing encoding logic with the current formats rather than adding
separate recording pipelines.

Selected-lap export sparsifies native v3 frames even when supplemental context
length changes. A sparse payload is used only when smaller than its full source
frame; otherwise export writes a full checkpoint. This preserves the frame-size
limit and lets subsequent deltas reconstruct against the correct checkpoint.


Player battery charge is a fraction, native state of charge is a percentage,
virtual energy is a separate fraction, and regeneration is reported in kW.
Engine and electric-motor readings, steering-shaft torque, native rain/wetness,
timing, controls, flags and penalty counts remain separate channels. Native
sector-2 reports are cumulative sectors 1–2, not isolated sector-2 durations.

Scoring-backed weather, timing and race-control readings retain the scoring
snapshot clock rather than inheriting every physics update. Repeated scoring
times do not refresh source observations. Missing, invalid or future clocks
produce unknown freshness. Historical envelopes retain their original capture
clock independently of the native clocks used to resolve channel freshness.


Read-only REST acquisition uses loopback HTTP at `http://127.0.0.1:6397` by
default. `LMU_REST_BASE_URL` can select another loopback HTTP address/port;
credentials, redirects and non-loopback targets are rejected. Requests have
a 500 ms default timeout and a 1 MiB response limit. Vehicle condition and
pit-estimate endpoints are checked at most once per second; setup, session
settings and forecasts at most once per minute. Native frames never await
network requests.
Rejected response bodies are canceled before request timeout/controller
ownership is released. Aero condition must be a finite nonnegative scalar;
brake/suspension condition must contain exactly four finite nonnegative values.

REST snapshots retain acquisition and original observation times separately.
An unchanged response does not create a source update. Failures expose error
state without refreshing the last successful acquisition time. Capacity,
localized refill selection and pit/repair time estimates remain explicitly
unavailable until their physical units/formats are verified. Reported condition
values have unverified scaling and are not shown as damage/wear percentages.

Player/slot/session changes, rewind, garage return and pause invalidate
incompatible context. Missing or unchanged native snapshots expire after one
second measured by a monotonic clock, independent of system-clock changes;
a transient rejected read does not create another session. New
generations reject late REST completions. Live and historical player panels
show observation state and source age, not an inferred measurement.

Recorder acquisition generations scope opponent identity and REST freshness;
they are not separate player sessions. Player session identity uses native
simulator event/session, car, track and player vehicle ID. Imports retain the
original acquisition keys, observation times and coverage gaps while publishing
each saved player lap with its matching physical chunk and database reference.

### LMU multiplayer opponent recordings

Opponent capture is enabled by default for live LMU sessions. Changing the
setting affects the next live session only; it does not change a session
already in progress or add opponent data to existing imports. Player telemetry
remains in the primary recording; captured opponents are stored separately in
the removable companion recording.

On **Sessions**, expand a saved LMU session and use **Recorded opponent sessions**.
Recorded opponents load automatically as collapsed driver rows, with each
driver's fastest recorded lap and that lap's sector splits. Missing splits show
as unavailable rather than substituting another lap's sectors. Expand a driver's
row, then select **Replay** or **Compare** beside an individual recorded lap.
Replay and Compare use the first ready player lap in the session as their
recording reference; no player-lap selection is needed to browse opponents.
The opponent list uses the session's child-table styling, with contained vertical
scrolling and horizontal scrolling on narrow screens.
Driver, car, class and native vehicle/incarnation identity distinguish records,
including duplicate names. These source-backed records do not create
duplicate player sessions or recording files. Expand the info indicator beside a
lap to inspect coverage, validity and channel limitations without repeated warning
sentences in the table. Partial coverage and unknown validity do not prevent
comparison when evidence is available.

Open Compare with a player lap, choose **Opponents**, filter by class or
driver/car, and preview a recorded lap. **Lap compare** commits that exact
reference; **Cancel** preserves the previous reference. Partial or uncertain
laps remain labeled; laps without comparable evidence cannot be selected.
The shared Replay workspace uses recorded scoring kinematics and source
clocks, not invented remote inputs. Missing clock/pose coverage does not
produce continuous playback.

**Export** includes the selected opponent's full recorded interval, even when
it crosses the player's lap boundaries. Storage settings can preview and
irreversibly remove opponents across every lap in one or more sessions.
Player recordings remain usable; earlier exported copies are unchanged.
New partitioned primaries are not rewritten. Legacy native v2/v3 captures
require a staged player-preserving rewrite before the old source is removed.

History distinguishes **not recorded** (capture disabled or no opponent source),
**removed** (intentional deletion), **missing** (referenced companion absent),
**corrupt** (integrity failure), and **incomplete** (only a committed prefix or
failed opponent capture). Lap coverage is separate from companion integrity.
Remote-input channels remain restricted or unverified and must not appear as
observed measurements. Controlled fixtures do not establish real-game
compatibility: fresh Windows LMU multiplayer source acceptance remains unrun.

The recording-backed regression fixture
`packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-2026-10-22.bin.gz` contains 330 exact
native v3 frames sampled from the supplied Windows multiplayer capture.
Its adjacent provenance file records source/frame hashes, original clocks,
identity and sampling gaps. Reproduce with
`bun packages/game-lmu/test/support/derive-opponents-fixture.ts` while the original dump is
available. Sampled sequence gaps remain partial; the fixture is not evidence
of continuous physics or verified opponent fuel/energy.

The paired `lmu-real-opponents-grid-2026-10-22.bin.gz` fixture retains 51
original early-grid frames with all 15 opponent identities. The browser suite
checks their separate records and excludes the player; the stable-tail fixture
checks actual lap comparison and replay across native scoring-counter resets.

LMU-specific integration, unit, recording E2E and browser tests live in
`packages/game-lmu/test/`; generic multi-game cases remain with their framework
owners. The live-ingress regression in `session-capture/opponent-recording-policy.test.ts`
feeds unchanged grid frames through the production parser and
`LiveTelemetryPipeline.processPacket`, inspects physical primary/companion
files, and checks exact native bytes, timestamps and all 15 opponent identities.
This file replay does not exercise Windows shared-memory acquisition.

The complete recording is also registered as one multipart default seed.
Its adjacent package-owned fixture provenance records compressed/source hashes,
part sizes and the 30,957-frame source. Byte-part packaging is independent of
the recorder's player/opponent separation.


Schema and unit references are recorded in the
[LMU contract](../plans/lmu-competitor-data-contract.md). Controlled native,
HTTP and capture tests are not a substitute for the required Windows LMU
player smoke. Runtime game-version/mode coverage is not claimed without it.

## Work with published lap archives

New completed-session splits publish one `capture.bin.gz` data file and a manifest v4 JSON index in an immutable attempt directory. The gzip file contains independent members, not one solid compressed session. Use the production artifact resolver and `SessionCaptureSource.artifact` to replay or export one lap; do not gunzip the whole data file, extract members to a cache, invent entry filesystem paths, or silently use the retained source when a published layout is invalid.

Keep physical member offsets and compressed sizes separate from decoded capture offsets and detector-owned source ranges. Preserve native frame bytes, ordering, timestamps, missing timestamps, zero-based detector lap numbers, parser bootstraps, and explicit completion context. A checksum proves integrity, not semantic source conservation. New splits must pass the package's closed-archive verification before fenced publication.

Legacy manifest v3 directory bundles remain readable without reinterpretation or in-place rewriting. Archive layout 2 uses separate DB manifest and archive paths; null-layout source reads remain unchanged. Cleanup and relocation must account for both paths, protect active staging and shared references, invalidate metadata/telemetry caches, and count shared archive bytes once. Never recompress the indexed archive as a whole-session stream.

Retained monolithic recordings follow existing policy. Measure archive storage against identical plain and already-gzipped member payloads, with logical and allocated bytes distinguished. Report retained-source storage separately; aggregation alone does not prove compression savings. Label synthetic windows, synthetic acquisition timestamps, application-cold reads, OS cache assumptions, and memory high-water scope explicitly. See [recording architecture](../architecture/telemetry-recording.md#indexed-completed-session-lap-archives) and the [archive implementation plan](../plans/indexed-session-lap-archive.md).

## Verify incremental live capture

Incremental live derivation is release-gated: `configureLiveCaptureRuntime()` exists but is not registered in production boot. Do not enable it merely because a behavioral smoke or compiler check passes. Live means telemetry is currently being produced; offline means existing recordings, import, reprocessing, or restart recovery—not network connectivity.

Run real-game conservation, independent offline detector, semantic replay, early-reader, and close checks:

```sh
bun apps/backend/test/benchmarks/live-lossless-release.bench.ts --trials=1 --rate-scale=1 --output=.omp/evidence/live-lossless/behavioral.json
bun test apps/backend/test/session-capture/live-worker-catchup.test.ts apps/backend/test/session-capture/live-recovery.test.ts apps/backend/test/session-capture/live-source-reader.test.ts
```

Prepared handover has separate deterministic file-backed coverage:

```sh
bun test packages/capture-splitting/test/prepared-host.test.ts packages/capture-splitting/test/prepared-handover.test.ts packages/capture-splitting/test/live-scenarios.test.ts --timeout 60000
```

The host tests exercise pre-opened spare files/journals and terminal cleanup. Handover tests hold finalization behind explicit gates: the next member must accept records before the previous gate is released, another boundary must respect the one-finalizer capacity, and close/failure must settle outstanding work without publishing an unverified member. These are ordering and losslessness assertions, not wall-clock speed thresholds; the production parser/detector smoke above remains the integration check.

The catch-up regression uses a real shared source/derivation worker, delayed authoritative controls, and concurrent bounded input after a canonical-cache miss. It covers both an original candidate and a selected, trimmed preparation window. Its optional long-input probe retains only a small native fixture and bounded RSS observations; `RACEIQ_LIVE_STRESS_OUTPUT` writes separate `-trim-0.json` and `-trim-1.json` reports rather than overwriting either scenario:

```sh
RACEIQ_LIVE_STRESS_RECORDS=100000 RACEIQ_LIVE_STRESS_OUTPUT=.omp/evidence/live-lossless/long-source-catchup.json bun test apps/backend/test/session-capture/live-worker-catchup.test.ts
bun apps/backend/test/benchmarks/live-lossless-performance.bench.ts --trials=3 --rate-scale=1 --output=.omp/evidence/live-lossless/matched-release.json
```

The matched runner declares and enforces numeric capture budgets before measurements. It requires all six fixtures, at least three trials, and sustained rate scale 1 for release coverage; subsets or faster replay exit nonzero without release approval. Timed legacy and incremental variants both exclude user replay/cache work. Native member verification, independent parser replay, publication, readiness, and sealing remain enabled. Early-reader, full replay/export, and reconnect proof are separate mandatory behavioral/UI gates, not optional replacements for capture measurements. CPU includes worker threads; OS-attributed physical I/O and page-cache effects must be distinguished from logical archive/source bytes. Fixture pacing uses the reported acquisition or game-clock domain and preserves missing timestamps rather than fabricating them.

Both variants start with an empty replay cache and a full GC. RSS sampling includes ingress and close; the legacy baseline also samples after offline splitting, so its allocation cost is not omitted. These sampled deltas are not an OS lifetime high-water mark or a cold-machine claim. Behavioral smoke reports also measure full consumer replay; do not compare their replay-cache growth to a capture-only baseline.

The 500 ms close budget applies at sustained game rate (scale 1). Accelerated or unpaced stress still requires bounded queues, native conservation, parser verification, publication, and complete drain; its measured backlog close latency is reported without that cap. Other numeric budgets remain enforced. This is not a constant-time close guarantee when unverified work remains.

The long-input probe is synthetic repeated native input, not game-rate or disk-latency evidence. Its late-half RSS-span budget is 64 MiB; inspect its bounded observations and worker queue/cache limits rather than treating the final zero backlog as a peak. Verify recording/finalizing/sealed/failure states, reconnect, actual playback, and raw export in the application on desktop and mobile. Retain source and committed prefixes on failure; do not weaken v4 EOF validation or mark an uncommitted member ready.

### Diagnose source-recorder memory and worker handoff

Run the diagnostic benchmark independently of the all-game release gate:

```sh
bun apps/backend/test/benchmarks/recorder-handoff.bench.ts --seconds=30 --fps=240 --trials=3 --output=.omp/evidence/live-lossless/recorder-handoff.json
```

Each baseline/worker trial runs in a fresh process with the same bounded working set of 512 real FM frames. Input repeats with synthetic missing, zero, and UTC timestamps; `--fps` controls offered load, not a claim about observed game rates. Increase `--seconds` for memory-plateau observations or `--fps` for burst pressure. Admission failure fails the command rather than silently reducing load. Trials alternate variant order, and temporary capture files are removed.

The report separates enqueue cost, enqueue-to-worker receipt (including batching), write acknowledgement, and durable acknowledgement latency, with p50/p95/p99 and sample counts. Receipt is timestamped inside the real filesystem worker before queued I/O runs; acknowledgements include return-message delay. It also reports transferred buffer bytes, batch sizes, sampled RSS peaks and twelve bounded memory windows, process lifetime peak RSS before verification, and source queue high-water marks. Transferred bytes are not copy/allocation counts. One extra diagnostic message per batch and bounded timestamp bookkeeping add measurement overhead.

Both variants must reproduce every native frame, its order, and timestamp presence/value through the production sparse reader after durable close. Baseline close includes an explicit final file sync; unlike the worker, it has no periodic sync. RSS includes fixture/runtime/diagnostic state and worker memory. Final verification is excluded from capture samples; lifetime peaks still include fixture preparation. OS caches are uncontrolled. This isolates source recording, not parser/detector work, lap-ready latency, or full derivation. Results have no arbitrary speed thresholds and do not authorize production activation.


## Commit a regression fixture

Raw `.bin` files are gitignored. Keep each original raw `.bin` locally for replay.
Gzip selected fixtures; every committed recording file, including each split
part, MUST be strictly smaller than 100,000,000 bytes. Do not use Git LFS.
Never stage raw `.bin` files or oversized gzip files.

```sh
bun run gzip:recording packages/game-lmu/test/fixtures/laps/lmu-example.bin
gzip -t packages/game-lmu/test/fixtures/laps/lmu-example.bin.gz
wc -c < packages/game-lmu/test/fixtures/laps/lmu-example.bin.gz
```

If gzip is 100,000,000 bytes or larger, run the existing recording-splitting
utility. Confirm every ordered part is strictly below 100,000,000 bytes and
retains the game identifier; stage only the parts, not the oversized original.
Do not write a new splitter or use Git LFS.

Use `combineRecordingParts()` in
`server/session-capture/combine-recording-parts.ts` to reassemble consecutive
`.part1`, `.part2`, … files in numeric order. Verify byte-for-byte integrity
against the original and gzip integrity before replay. Keep oversized original
and assembled files local and unstaged.

For an unsplit gzip below the limit, stage the `.bin.gz` file instead:

```sh
git add packages/game-lmu/test/fixtures/laps/lmu-example.bin.gz
```

Reassemble a committed split fixture locally before replay; individual part
files are not standalone recordings. Recording support accepts `.bin.gz`.

For LMU, use matching game support and retain the game identifier in the
assembled filename:

```ts
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { lmuRecordingSupport } from "@raceiq/game-lmu/test-support/recordings";

const result = await parseDump(
  lmuRecordingSupport,
  "packages/game-lmu/test/fixtures/laps/lmu-<timestamp>-assembled.bin.gz",
);
```

For new-game implementation, human capture steps, and fixture requirements, follow
[Adding new game support](adding-new-game-support.md).

For example, preserve the game's support module in parser tests:
```ts
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { fmRecordingSupport } from "../support/recordings";

const result = await parseDump(
  fmRecordingSupport,
  "test/artifacts/sessions/fm-2023-<timestamp>.bin.gz",
);
```

Prefer a small fixture that demonstrates one observable regression. Document
the expected lap or parser behavior in the test that consumes it.

## Capture hygiene

- Stop with `Ctrl+C` when possible. A hard kill can truncate the final frame.
- Do not rename fixtures after capture without preserving the game identifier.
- Stage developer-only recordings under `test/artifacts/`, not production
  session storage.

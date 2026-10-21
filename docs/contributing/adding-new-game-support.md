# Adding new game support

This guide covers implementation, recording fixtures, fixture preparation, and verification in one place. Only recording a real fixture is marked **human required**.

## Implementation steps

### Add and register the game

- Add the stable game ID in `shared/games/ids.ts`.
- Add `packages/game-<id>/` for the telemetry source, parser, backend adapter, lap detector, and recording/replay support. Implement `ServerGameAdapter` from `server/games/types.ts`, including full parsing, lap-index parsing, and parser-state priming.
- Add `packages/game-<id>-metadata/` for the browser-safe `GameAdapter` from `shared/games/types.ts`, car/track metadata, coordinate conventions, and telemetry capabilities. Keep Node catalog leaves separate from browser-safe exports.
- Register metadata in `packages/game-catalogs/src/games/init.ts` and the backend adapter in `apps/backend/src/games/init.ts`; wire workspace dependencies/exports using existing game packages as examples. Respect release flags when registering or exposing the game.
- Wire native sources in `apps/backend/src/runtime/native-sources.ts` and `apps/backend/src/runtime/live-readers.ts`. For UDP sources, integrate with `apps/backend/src/runtime/udp-listener.ts` and registered parser dispatch in `server/games/packet-dispatch.ts`.
- Connect the source to the existing live pipeline in `server/telemetry/live-pipeline.ts`. Keep game-specific behavior in the adapter; do not add another game's fallback.

### Extract and map telemetry

- Document UDP/shared-memory/SDK setup, supported platforms, protocol version, packet layouts, units, and source update rates.
- Commit the telemetry documentation used to implement the integration under `docs/reference/external/<game-id>/` in the same PR: protocol specifications, SDK field/layout definitions, and relevant units, timing, validity, and sector semantics. Record the source URL, document/SDK version, and applicable game build; link these references from the game's documentation. Preserve attribution and confirm redistribution permission before committing vendor materials.
- Preserve original source frames before parsing. Capture acquisition UTC as `frameTimeMs` at source receipt/poll, before parsing or queuing; keep simulator time separate.
- Extract session identity/state, car/track IDs, lap number, lap progress/distance, valid-lap channel, pit state, sector index/splits, current/previous/best lap times, and delta to best lap. Document native versus derived values and delta sign/reference semantics.
- Extract available driving/analysis channels: position, speed, throttle, brake, steering, gear, RPM, fuel, tyre, suspension, and other supported measurements. Map into `shared/telemetry/types.ts` and the semantic catalog; use correct units, coordinates, availability, and freshness. Missing channels/features remain explicitly unavailable, not valid zeroes.
- Resolve car/track names and configure lap/session transitions, validity, sectors, and pits through the adapter and existing pipeline.

### Map game tracks to common names in `tracks.csv`

`commonTrackName` links each game's track identity to a shared circuit identity so **track facts and guides can be shared across games**, rather than duplicated for each game's naming convention. Geometry and layout alignment remain game-specific.

- Add the game's track catalog at `packages/game-<id>-metadata/src/tracks.csv`, following the appropriate existing catalog schema. Map each game-specific track ID/name/layout to the shared canonical slug in `commonTrackName`; this is not the display name or setup-folder key.
- Reuse an existing common slug for the same circuit, even when the game uses another name. For example, ACC maps `Barcelona` to `catalunya` and `Spa-Francorchamps` to `spa`. Check existing `shared/data/tracks/meta/<slug>.json` entries before introducing a new common name; coordinate new names with the maintainer.
- Preserve game-specific IDs and layout/variant distinctions. Different game IDs may share a common circuit name, but must still resolve to the correct layout geometry.
- Wire the catalog's `commonTrackName` through the adapter's `getSharedTrackName()` resolver. Existing ACC implementation: `packages/game-acc-metadata/src/racing/tracks/catalogs/acc.ts`. Keep unknown mappings explicit rather than substituting another circuit.
- Use the resolved common slug to look up shared track facts, guides, and metadata. For example, games mapping their Barcelona circuit to `catalunya` share the same circuit facts and guides. Resolve SVG geometry separately for the correct game and layout; a common name does not make different games' geometry interchangeable.

Example from ACC's `tracks.csv` (other game catalogs can have different columns):

```csv
id,name,variant,commonTrackName,setupFolder
6,Spa-Francorchamps,GP,spa,spa
8,Barcelona,GP,catalunya,barcelona
```

### Extract track edges for every track type/layout

- Contact the maintainer to obtain access to the private track-extraction repository, tooling, and SVG pattern instructions. Use its prescribed workflow; do not invent a replacement extractor or assume access is available.
- Extract left and right track edges for **each track type/layout** supported by the new game. Save each output using the naming pattern `packages/game-<id>/assets/tracks/<slug>.track.svg`, following the existing ACC assets as a reference. Give distinct layouts distinct slugs.
- Register the SVG assets with the game's track metadata/geometry lookup. Verify both edges align with the game's coordinates and the correct track/layout; follow [track curation and verification](track-curation.md).

### Catalog data and generated outputs

Update catalog source inputs and discovery/mappings in `packages/tooling-catalog/src/catalog/`, including the explicit game list in `model.ts` and per-game inventories in `builder.ts`. Never hand-edit outputs under `shared/telemetry/catalog/generated/`.

```sh
bun run telemetry:catalog
bun run telemetry:catalog:check
```

### Reuse sparse recording

- Use the existing `SparseSessionRecorderAdapter` in `server/telemetry/pipeline-ports.ts` and `SparseSessionRecorder`/`SparseCaptureEncoder` in `server/session-capture/sparse-recorder.ts`; do not introduce a parallel recording format.
- Extend sparse dispatch and source-frame identity for the new game. Reuse the existing generic `RQSD` codec in `server/session-capture/generic-sparse.ts` where appropriate. Merely selecting the sparse recorder is insufficient: unrecognized games currently fall back to raw frames.
- Preserve stable frame identity/version/length checks, full checkpoints at session/context boundaries and at most every 128 frames, and raw-frame fallback when a delta is not smaller. Sparse encoding must restore source bytes exactly; do not discard unparsed fields or downsample to reduce storage.
- Integrate recording readers, import/reprocess, lap-offset seeks, and standalone lap export with existing sparse decoding. Verify byte-for-byte frame restoration and preservation of acquisition timestamps, including seeks and exported lap windows.
- Provide a game-specific raw-dump command in root `package.json`, following existing `dev:dump:*` commands and the backend's `--record=<game-id>` wiring. Document the command and output directory. Implement session saving, `.bin.gz` import, and replay. Development dump containers and production canonical recordings are distinct; use the matching reader rather than decoding either ad hoc.
- For AMS2 support, add `dev:dump:ams2` in root `package.json`, following `dev:dump:lmu` with `--record=ams2`. The PR must implement the corresponding raw source recorder and reader; adding a command without working capture support is insufficient.

## Record a fixture — human required

**Use dump mode to record this fixture—not normal RaceIQ session recording.** Start the game's `bun run dev:dump:<suffix>` command before entering a session, drive the required laps, and leave the session before stopping the dump recorder. This captures the raw source transitions needed to test session detection and finalisation. Replay alone does not prove real source acquisition.

1. Enable game telemetry and configure the UDP destination or native source permissions required by the integration.
2. Start RaceIQ in **dump mode before starting the game session**, using the new game's documented `bun run dev:dump:<suffix>` command, which launches the backend with `--record=<game-id>`. Use the actual script name registered in root `package.json` (`bun run dev:dump:ams2` for AMS2 once implemented). Confirm the dump recorder starts before session entry and writes to the documented output directory. Ordinary `bun run dev` session recordings are not acceptable substitutes: fixture capture must include the source frames preceding session detection.
3. Record **no more than 6 laps total**, including **at least one inlap, one outlap, one unclean lap, and one clean lap**. Start from the pits with an outlap if possible. If the session starts on track and cannot start from the pits, pit at the first opportunity to capture an inlap, then exit the pits to capture the following outlap. **The final lap does not need to be an inlap.**
4. Supply the raw dump and capture notes: game build/settings, car/track, lap numbers, validity, sector splits, lap times, and delta-to-best values observed in the game. These are the independent expected values for fixture tests.
5. End or leave the game session while dump mode remains running. Capture the source's session-end/menu transition and final timing updates before stopping with `Ctrl+C` so the dump recorder flushes. Supply notes identifying session start and end. This fixture must prove session detection and finalisation from real source transitions, not only forced finalisation when a replay reader reaches EOF.

## Fixture preparation

Store recorded fixtures under `test/artifacts/sessions/`, the destination for new committed fixtures. Include game ID and scenario in filenames, for example `game-id-lap-coverage.bin`. Existing LMU capture defaults to `test/artifacts/laps/`; preserve the game ID if moving a capture. Keep capture notes with the fixture's consuming tests.

### Gzip and size limit

**Gzip every recording. Each committed file must be strictly under 100 MB (`< 100,000,000 bytes`). No Git LFS.** Raw `.bin` files stay local and are gitignored. The compression command keeps the original raw file and does not enforce the size limit.

Replace the example path below with the actual game ID and capture filename:

```sh
capture=test/artifacts/sessions/game-id-lap-coverage.bin.gz
bun run gzip:recording "${capture%.gz}"
gzip -t "$capture"
wc -c < "$capture"
```

If the gzip is below the limit, stage it:

```sh
git add "$capture"
```

### Split and reassemble larger recordings

If gzip is 100,000,000 bytes or larger, run the existing recording-splitting utility rather than writing a new splitter. Confirm every output part is **strictly below 100,000,000 bytes**, retains the game's identifier, and has an unambiguous order. Stage only the parts, not the oversized original.

Use the existing `combineRecordingParts()` in `server/session-capture/combine-recording-parts.ts` for reassembly of consecutive `.part1`, `.part2`, … files; it sorts numerically. Verify the reassembled recording matches the original and passes gzip integrity checks before replay.

Keep oversized original and assembled gzip files local; never stage them. Parts are chunks of one gzip stream, not independent gzip files. Preserve the game ID in the assembled filename. **No Git LFS.**

## Import, tests, and completion

### Import and replay

Use the new game's recording support to replay fixtures through production parsing and lap detection. Reassemble split recordings first and retain the game ID in the filename. Check game, packet count, car, track, and saved laps against capture notes; verify reprocessing through the same integration.

Fixture tests can use `parseDump` from `@raceiq/backend-core/test-support/recordings/parse-dump` with the new game's `RecordingGameSupport`; implement its reader for the new dump format and gzip inputs.

### Correctness and completion

- Add fixture-backed tests beside the game workspace verifying **lap numbers, valid-lap channel, sector splits, lap time, and delta to best lap correctness** against expected values recorded with the capture, including clean/unclean laps and pit transitions.
- Run relevant tests/checks and confirm sparse restoration, timestamps, import/replay, and live-verification results. Replay does not replace real fixture capture or source-acquisition verification.
- Update supported-games docs, telemetry setup/platform requirements, limitations, and changelog.

## PR checklist

### Integration

- [ ] Maintainer contacted and private track-extraction repository access, tooling, and SVG pattern instructions obtained.
- [ ] Game packages, ID, adapters, source wiring, and registration implemented; platform and telemetry setup documented.
- [ ] Telemetry documentation used for implementation committed under `docs/reference/external/<game-id>/`, with source, version/game build, attribution, and links recorded; redistribution permission confirmed.
- [ ] Required telemetry extracted with correct units, coordinates, timestamps, availability, and freshness; catalog generated and checked.
- [ ] `tracks.csv` maps game tracks through `commonTrackName` to shared **track facts and guides**, preserving layout distinctions.
- [ ] **Tracks page** populated with the new game's correct track names, IDs, and layouts; each track resolves to its intended geometry and shared **facts and guides** through `commonTrackName`. No missing, duplicate, or incorrectly mapped entries.
- [ ] **Cars page** populated with the new game's correct car names, IDs, and available metadata; entries resolve to the intended cars without another game's fallback data.
- [ ] Track edges extracted for every supported track type/layout using the private tooling's SVG pattern, saved as `<slug>.track.svg`, registered, and alignment verified.
- [ ] Existing lossless sparse recording integrated; source bytes, checkpoints, timestamps, lap seeks, and exports verified.
- [ ] Real fixtures gzip-compressed; each committed file or ordered split part **strictly below 100,000,000 bytes**. Reassembly and gzip integrity verified. **No Git LFS.**
- [ ] Import/replay produces expected game, car, track, and laps.
- [ ] Fixture-backed tests verify **lap numbers, valid-lap channel, sector splits, lap time, and delta to best lap correctness** against expected values recorded with the capture; relevant checks pass.
- [ ] Supported-games docs, setup instructions, limitations, and changelog updated.

### Unit tests

- [ ] Parser tests cover supported source versions/types, field offsets, units, coordinates, timestamps, and missing/unavailable channels; malformed or truncated frames fail according to the source contract.
- [ ] Stateful parsers correctly assemble multi-frame data, prime context, and reset on session/source boundaries without leaking prior car/track or timing state.
- [ ] Lap/sector tests cover physical lap transitions, elapsed-time reset, delayed native timing, validity changes, pit entry/exit, incomplete laps, actual sector counts, and best-lap/delta reference behavior where supported.
- [ ] Metadata tests verify game IDs resolve to the correct cars/tracks/layouts and common names; unknown IDs do not borrow unrelated metadata.
- [ ] Recording tests prove exact source-byte and timestamp restoration across sparse checkpoints, identity/size changes, boundaries, raw fallback, lap-offset seeks, and independent exports. Reuse existing shared codec coverage; add game-specific cases rather than duplicating it.
- [ ] Tests live beside workspace owners and are included in applicable suite manifests/package tasks. Tests are deterministic, isolated, and assert observable behavior—not wiring, source text, or mock echoes.

### End-to-end tests

- [ ] Include fixture tests in the PR under `packages/game-<id>/test/e2e/`, using real raw dumps captured in **dump mode before session start through session end**, not recordings saved by normal RaceIQ operation. Register tests in the owning package's E2E manifest/task. Required missing fixtures fail rather than silently skip.
- [ ] Replay the capture through production parser, pipeline, lap detector, and persistence; verify the lap/timing/validity/pit/sector/delta outcomes listed in the recording fixture checklist below.
- [ ] **Session lifecycle:** replay pre-session, session-entry, driving, and session-end frames through production parsing and pipeline processing. Assert the session starts at the correct source transition, laps belong to that session, and the end transition finalises it with correct final lap/timing results and no duplicate saves. Verify finalisation before replay EOF or forced test cleanup; an explicit EOF flush alone does not prove session-end detection.
- [ ] Verify recording import/reprocessing and exported-lap replay preserve identity, source bytes, timestamps, and saved lap results.
- [ ] Add browser coverage through the existing `playwright/` suite for game selection, populated Tracks/Cars pages, correctly mapped facts/guides, saved sessions, Analyse, Compare, and supported live telemetry. Use comparable fixture laps; unavailable data is not proof a feature is unsupported.
- [ ] **Page reachability:** navigate to the new game's pages through application links and open their URLs directly, then reload. Cover game landing, Tracks, Cars, saved sessions, and fixture-backed lap/detail, Analyse, and Compare routes where supported. Verify the intended game/content loads—not a 404, error screen, redirect to another game, or empty shell.
- [ ] **Export/import round trip:** use supported user-facing export controls to download a real fixture-backed lap and complete session where available, then import the downloaded files through the corresponding supported import flow in isolated state. Verify imported content appears on the new game's pages and preserves game, car/track, lap numbers, validity, sector/lap times, and available telemetry/source timestamps. Cover supported export formats; backend-only replay or a successful download without inspecting imported results is insufficient.
- [ ] Check capability-dependent UI for supported versus unavailable channels/features and exercise relevant source disconnect/reconnect transitions. Verify real native acquisition separately from replay.
- [ ] Run owner-scoped suites and affected browser projects using repository tasks; recording coverage uses `bun run test:e2e:recordings`. See [E2E testing](e2e-testing.md) for browser setup and project selection.

### Live telemetry dashboard

Every newly supported game must provide a working live telemetry dashboard. Follow existing telemetry dashboards' design and interaction patterns; do not ship a placeholder dashboard or copy unsupported widgets from another game.

- [ ] **Reachability:** expose the dashboard through the game's navigation and a working direct URL. Navigation, direct loading, and reload select the correct game without cross-game fallback.
- [ ] **Live source:** display actual incoming game telemetry through the existing shared telemetry store and WebSocket flow. Verify values update while driving and game/car/track identity matches the source; static fixtures, canned values, and replay alone do not prove live support.
- [ ] **Working elements only:** inventory every visible widget, chart, indicator, control, and navigation action. Verify each uses supported data or performs its stated action. Omit elements for unsupported channels/features entirely; no dead buttons, permanently empty panels, fabricated values, or another game's fallback data.
- [ ] **Temporary unavailability:** supported elements distinguish waiting, stale/disconnected, and unavailable current-session data from valid zero values. Clear or mark stale values on disconnect, game/car/track changes, and session resets; reconnect resumes correct updates without duplicating subscriptions.
- [ ] **Telemetry correctness:** verify displayed units, coordinate-dependent visuals, lap/sector timing, validity, and other supported metrics against source observations. Use authoritative server results rather than recalculating domain telemetry in UI components.
- [ ] **Design consistency:** reuse existing dashboard layouts, shared widgets, UI primitives, semantic variants, typography, spacing, colors, chart conventions, and interaction states. Game-specific composition may differ only to reflect actual capabilities; no separate visual system or copied one-off styles.
- [ ] **Usability:** preserve existing responsive layout, keyboard/focus behavior, accessible control labels, localization, and readable units. Check supported viewport sizes for clipped content, overlapping widgets, and unreachable controls.
- [ ] **Performance:** live rendering remains responsive at the supported publication cadence without growing retained UI state or duplicating listeners. Dashboard refresh rate follows existing WebSocket publication cadence, not the separate 100 Hz recording target.
- [ ] **Verification:** add browser E2E coverage for dashboard reachability, changing telemetry, every visible action, capability-based omissions, and disconnect/reconnect/reset states. Inspect rendered dashboard alongside existing dashboards and verify real-game acquisition separately.

Follow [frontend state, shared UI, and routing conventions](frontend.md).

### Optional extension: car setup support

Setup import/export, editing, file generation, and experiments integration are **not required for core game support**. When extending a game with setup support, follow the separate [Adding game setup support checklist](adding-game-setup-support.md).

### Benchmarks with Mitata

- [ ] Add the new game's real fixture and adapter setup to existing Mitata harnesses in `apps/backend/test/benchmarks/`, including `pipeline.bench.ts` and `pipeline-stages.bench.ts`; update explicit game/fixture lists where required.

Existing benchmark scopes: `pipeline.bench.ts` awaits packet processing with null DB/WebSocket/recorder adapters and periodically flushes synthetic lap state. `pipeline-stages.bench.ts` measures full parse and pipeline workloads separately via Mitata `measure()`, with one excluded warmup and fixed `--trials` samples. Its pipeline uses null adapters and at-most-500-packet chunks; reported stage quantiles are workload timings, not individual-update p95 latency. Memory profiling runs independently and excludes prepared fixtures/inputs. Production `LiveTelemetryPipeline.processPacket()` keeps capture/tracking full-rate while WebSocket publication has its own cadence. Use a real-recorder scenario for the sustained recording acceptance criteria below.

- [ ] Measure full source-frame parsing and processing of pre-parsed packets separately. Include stateful accumulation and lap/sector work exercised by the fixture, not an empty or rejected-packet workload.
- [ ] Measure sparse encoding/restoration and recording/import/replay costs for the new game's format using existing benchmark scenarios where applicable. Keep disk/gzip/database work separate from parser-only measurements and label each measured scope.
- [ ] Prepare fixtures, decompression, and initial state outside parser/pipeline timers; reset mutable state for equivalent iterations and consume results so measured work cannot be optimized away. Let Mitata own warmup/sampling.
- [ ] Validate packet/lap outcomes before comparing performance. Record fixture/workload identity, Bun/Mitata versions, timing statistics, and processing counts; compare identical inputs and scopes.
- [ ] Run retained-memory/resource measurements separately from throughput; do not report retained heap as total allocations or process memory.
- [ ] Run `bun run bench` and a focused `bun run bench:pipeline-stages` scenario after adding game support to the harness. Keep benchmarks outside ordinary tests, attach results to the PR, and satisfy the acceptance criteria below.

#### Benchmark acceptance criteria

- [ ] **100 Hz processing capacity:** sustain at least **100 complete telemetry updates per second** on documented reference hardware, including parsing, lap/sector processing, sparse encoding, and recording writes. A complete update may require multiple source packets; 100 datagrams per second alone is not proof.
- [ ] **10 ms update budget:** combined processing/recording service time averages below **10 ms per update**, with p95 below **10 ms** after warmup. Report tail latency separately; queues must not grow continuously or hide a slower consumer behind asynchronous writes.
- [ ] **Sustained recording:** replay representative source frames at 100 Hz for the complete fixture, including lap and pit transitions. Flush pending work and validate the stored capture: no recorder-induced drops, missing/duplicate accepted frames, corrupted sparse references, or timestamp changes. Source filtering must remain explicit and must not be used to claim a higher recording rate.
- [ ] **Source-rate honesty:** preserve the actual game's supported acquisition cadence. If the source supplies fewer than 100 complete updates per second, prove 100 Hz pipeline capacity with paced replay and report the real acquisition rate separately; do not fabricate samples or claim native 100 Hz capture.
- [ ] **Low, bounded memory:** stream recording/replay and keep buffers, parser state, and write queues bounded rather than retaining an entire recording. After warmup, retained memory must settle instead of growing with recorded frames or completed laps; repeating equivalent workloads must not accumulate leaked state.
- [ ] **Explicit memory budget:** report additional retained heap and sampled peak process RSS separately, including runtime/input exclusions. Record maintainer-approved byte limits for the reference workload/hardware and demonstrate both measurements remain within those limits; “low memory” without measurements and a budget is not acceptance.
- [ ] **Evidence:** attach Mitata stage results plus sustained recording/resource results, hardware/OS/Bun versions, fixture identity, actual rate, latency statistics, queue behavior, memory measurements, and decoded packet/lap outcomes. Parser-only benchmarks or null-recorder pipeline runs do not prove 100 Hz persisted recording.

Benchmark setup, scopes, and smoke commands: [performance benchmarks](performance-benchmarks.md).

### Recording fixture and verification

- [ ] **Human required:** real raw dump captured with **no more than 6 laps total**, covering **inlap, outlap, unclean lap, and clean lap**. Start from pits when possible; otherwise pit at the first opportunity, then capture the following outlap. Final lap need not be inlap.
  - **Identity and session:** record expected game, car, track/layout, and session association; laps from one uninterrupted session must not split into unrelated sessions.
  - **Session lifecycle:** retain pre-session and post-session source frames in the dump; document observed entry/end transitions and verify detection and finalisation without relying solely on EOF cleanup.
  - **Lap boundaries and numbering:** record expected lap count and number sequence; test no duplicate or invented completed laps and no duplicate lap-saved events.
  - **Validity and pit transitions:** test the valid-lap channel and saved classification for clean, unclean, inlap, and outlap; distinguish pit-only opening segments and incomplete tails when present. Do not save a partial final lap as a valid completed lap.
  - **Lap timing:** compare saved times with observed/native times using documented precision; elapsed time resets at the physical lap boundary. Delayed previous-lap timing must attach to the correct lap, not the next one.
  - **Sectors:** record the layout's actual sector count and expected split times; test positive completed splits, correct lap association, and sector sums matching lap time within source precision. Missing or incomplete sector data must not become fabricated complete splits.
  - **Best lap and delta:** capture a clean reference lap and a following comparison lap at a different pace. Test the expected best-lap reference, delta sign/value at several comparable positions (for example 25%, 50%, and 75% lap progress), and estimated lap time where supported; finish estimate should agree with the completed lap time within documented tolerance.
  - **Driving telemetry and replay:** capture meaningful speed, position, throttle/brake, RPM, and gear changes; include tyre channels where supported. Test units/ranges and retained variation through production parsing and Analyse replay, not merely non-empty packets.
  - Capture expected values independently from the game's display/source contract; note unsupported channels and tolerances. Keep all coverage within the **6-lap maximum**, including partial laps.

  Existing fixture examples: [LMU pit-cycle/lap/sector coverage](../../packages/game-lmu/test/e2e/lmu-multi-lap-dump.test.ts), [ACC lap numbering and duplicate-save coverage](../../packages/game-acc/test/e2e/acc-2026-04-12T21-16-07-841Z.test.ts), [iRacing delayed timing and native sectors](../../packages/game-iracing/test/e2e/iracing-recording-fixture.test.ts), [ACC delta checkpoints and estimates](../../packages/game-acc/test/e2e/acc-lap-estimation.test.ts), and [AC Evo driving channels](../../packages/game-ac-evo/test/e2e/ac-evo-recording.test.ts). Reuse behavior coverage, not fixture-specific lap counts or skip-on-missing-fixture patterns.
- [ ] Game build/settings, car/track, and expected lap numbers, validity, sectors, times, and deltas supplied with capture.
- [ ] Car/track identification, live telemetry, session saving, and affected UI verified against the running game—not replay alone.
- [ ] Inspect the new game's **Tracks and Cars pages** against its actual catalogs; confirm displayed entries and available details are correct, and each track's facts and guides belong to the mapped circuit.

Architecture details: [overview](../architecture/overview.md) and [recording contracts](../architecture/telemetry-recording.md). Existing-game capture commands: [recording and importing telemetry](telemetry-recordings.md).

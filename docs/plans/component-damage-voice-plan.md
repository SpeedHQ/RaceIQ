# Component-specific damage voice

## Approved scope

User approved native capture additions and damage/fault announcements only. No consumable-wear alerts, no speculative part diagnosis, no Forza damage fallback, and no decoding undocumented AC Evo damage-state storage. Reuse pinned Qwen model, clone reference, and generation settings documented in `../architecture/live-voice-engine.md`.

## Source boundary and owners

- F1 capture owner: preserve native engine-blown/seized bytes (offsets 44/45 in 46-byte v3 records) as optional boolean packet fields `f1.engineBlown` / `f1.engineSeized`. Existing component damage, faults, tyre/brake arrays remain authoritative. Expected semantic IDs follow existing discovery: `engine.engine-blown`, `engine.engine-seized`.
- iRacing capture owner: select and preserve `EngineWarnings`, `PitRepairLeft`, `PitOptRepairLeft`. Expected IDs already cataloged: `engine.engine-warnings`, `race.pit-service.mandatory-repair-time-remaining`, `race.pit-service.optional-repair-time-remaining`. Warning masks must follow documented SDK enum, not invent an engine-damage bit.
- LMU capture owner: preserve per-wheel native flat/detached bytes as numeric tuples `lmu.wheelFlat`, `lmu.wheelDetached`, ordered FL/FR/RL/RR. Only `0/1` are known flag states; other markers remain raw and unknown to the detector, preserving valid neighboring corners without changing the resolver's complete-collection contract. Expected IDs: `tires.wheel-flat`, `tires.wheel-detached`.
- Main owner: authoritative shared damage vocabulary/signal definitions, detector, renderer, semantic selection/catalog, damage-only LMU gate, audio specification/generation, docs and final integration.

Independent capture slices proceed in parallel; main integrates after actual fields exist. No UI changes. New JSON vocabulary is consumed by renderer and generator so spoken text and captions cannot diverge.

## Acceptance

- C1: F1 names each aero part, engine, gearbox, tyre/brake corner, DRS/ERS fault and engine failure instead of merging regions. Percent damage retains existing >5/30 severity policy and three-second debounce; no wear alerts.
- C2: ACC/Evo name only measured bodywork region. Unverified raw scale must not produce percentage or heavy-severity claims; centre never implies floor, suspension or engine.
- C3: iRacing SDK capture reaches repair and documented warning announcements. Timers are service seconds, not component damage. Pit/rev limiter bits are never faults; unknown bits and negative/unavailable timers remain silent.
- C4: LMU flat/detached flags reach corner-specific lines; only damage reporting is enabled by this change, not unrelated LMU engineer families. Forza and unsupported/unverified channels remain silent.
- C5: each signal debounces independently; missing/stale/invalid one channel cannot suppress valid siblings or mature its timer. Repairs clear/rearm; unchanged readings do not repeat; session/source reset cannot retain stale state. Named explicit failure takes precedence over a redundant generic warning for same component.
- C6: all reachable lines have newly generated packaged Qwen clips matching vocabulary, valid hashes and PCM data; captions match audio catalog. Obsolete vague zonal clips are removed from production catalog and generator.

## Edge handling

Percent values outside 0..100, non-finite values, malformed wheel arrays, unknown flags, negatives and unavailable fields produce no warning for that channel and restart its pending debounce (C1/C3/C4/C5). Initial sustained real damage can report after debounce. Raw Kunos zones remain raw observations; no percent conversion (C2). Detached wheel suppresses a simultaneous flat-tyre line for that wheel; engine failure suppresses generic engine-damage line (C5). Multiple mature channels are reported one at a time in severity order without losing remaining candidates (C5). Existing per-event runtime cooldown must not hide independently debounced new damage. Old recordings without new native fields remain usable; only absent channels are silent (C5).

## E2E execution

E1: extend existing native parser/source-frame fixtures to exercise real decoder/normalizer -> semantic resolver/projector -> trigger catalog -> voice engine. Assert exact component text/segment IDs across all supported games and unsupported Forza; no mock detector or renderer. Setup controlled input records, transition healthy -> damaged -> sustained -> unchanged -> repair -> damage; include missing/stale siblings, threshold boundaries, malformed arrays, fault bit combinations, session reset and old recordings. Covers C1–C5.

E2: existing captured F1 replay plus synthetic native field fixtures validate retained fields and real resolver/source availability. Confirm LMU non-damage systems remain unavailable and iRacing unselected fields are now captured, not merely cataloged (C3/C4/C5).

E3: run actual Qwen generator, full catalog checks, and production browser audio player against all new component clips; check decoded waveform/hashes and completion. Cover C6; listening approval remains separate from automated playback. Regenerate/check telemetry artifacts after capture changes. Execute focused suites and diagnostics after parallel implementation; record unavailable checks and known Windows/toolchain failures rather than suppressing them.

## Execution evidence

Final focused run: **143 passed, 0 failed, no filters** across 14 native, trigger, audio-catalog, replay, voice-engine, semantic-projector, and release-gate suites. The previously filtered LMU recording durability case now passes with real write/close/replay, alongside invalid-directory error propagation. All checks use the repository-pinned Bun 1.4.3.

| Acceptance | Passing evidence |
| --- | --- |
| C1 | F1 native decoder -> projector -> catalog -> voice delivery; component/corner thresholds, escalation, fault precedence, and all vocabulary transcripts verified by native contract, car-health, and audio-catalog suites. Invalid failure bytes `2/255` remain unavailable rather than becoming failures. |
| C2 | ACC/Evo bodywork cases emit only measured-region wording; large raw values never request heavy or percentage wording. |
| C3 | Synthetic IBT records traverse the real reader, selected-variable source encoder/decoder, normalizer, projector, detector, and voice engine. Oil-pressure and mandatory-repair clips deliver on successive frames; limiter/unknown bits and invalid timers stay silent. Old field selections remain readable. |
| C4 | Native LMU shared-memory fixtures deliver detached-wheel and flat-tyre clips. An unsupported front-left marker `2` does not hide a valid rear-left flat tyre. Capability/release regressions preserve damage-only LMU enablement and Forza damage silence. |
| C5 | Independent debounce, stale/invalid isolation, repair rearming, unchanged suppression, source/session reset, and explicit-failure precedence pass. F1 checkpoint round-trip and reconstructed older checkpoint without new fields preserve compatibility. |
| C6 | Qwen generation and full audio validation pass: 1,020 catalog clips / 21 full lines, including all 56 component/severity clips. Production browser player completes all 56 with no error after hash verification and decoding. All 964 unrelated baseline clip hashes remain unchanged; obsolete damage clips are removed. |

E1 uses the existing native fixtures and actual production integration classes, not mocked detectors/renderers. Native tests are in `packages/game-f1-2025/test/f1-telemetry-contract.test.ts`, `packages/game-iracing/test/iracing-ibt-reader.test.ts`, and `packages/game-lmu/test/lmu-adapter.test.ts`; detector/voice behavior lives in the existing backend live-strategy suites.

E2 additionally replays a retained F1 capture prefix from `data/sessions/f1-2025/2026-09-20T02-42-01-284Z.bin.gz` through production framing, native parser, and `runLiveEngineerSessionReplay`: **2,167 native frames -> 2,000 replay frames**, all 2,000 containing explicit engine-failure facts; DamageReporting transitions `baseline -> ready`. This is a read-only capture-prefix smoke, not a claim of a newly connected simulator session.

E3 emits `DAMAGE_COMPONENTS_READY: 56 component/severity voice deliveries passed` from the runnable voice pipeline and `PASS: 56 component damage clips played` from the production `LiveEngineerAudioPlayer`. Browser volume is zero; automated playback is not human listening approval. The original pinned Qwen model/reference/settings were reused, including a final selective regeneration of the two sidepod lines to avoid implying both sides were damaged.

Final catalog gates: `bun run voice:check`, `bun run telemetry:catalog:check`, and `bun run test:shards` pass. Telemetry artifacts contain 819 semantic variables / 2,086 parser/source links; all 428 ordinary test files are assigned exactly once. Focused LSP diagnostics pass for changed native capture/parser tests, LMU projection, trigger catalog/detector, renderer, and catalog metadata/definitions.

All seven configured pre-commit gates pass under Bun 1.4.3: locale keys, typecheck, shard coverage, unit tests, tooling tests, lint, and telemetry catalog. Typecheck/lint cover all 33 workspaces. Workspace lint scripts invoke the published Oxlint JavaScript CLI directly, preserving each working directory while avoiding Windows relative executable-shim metadata failure. IBT fixture types preserve brake-line-pressure input; the test runner passes validated repository-relative paths to avoid Windows command-line length limits, with a real 240-file child-process regression.

The complete `bun run test:integration` gate passes all 13 workspace tasks. Backend result: **3,056 passed, 0 failed, 3 pre-existing skips** (external LM Studio, GitHub release bodies, corrupt legacy ACC fixture). No new whole-test skips were added. Actual recording, direct manifest/seal/recovery, relocation, migration collision/resume, and ACC Broadcast replay/export/reimport paths pass.

Windows directory fsync is unsupported through portable Node APIs: real file flushes and path/access failures remain enforced, POSIX directory syncing remains intact, and Windows namespace persistence is explicitly OS-managed. Journal read/save/removal serialization prevents progress polling from racing atomic replacement; isolated real API smoke reaches successful mixed-ownership cutover under continuous polling. Windows security fixtures exercise native junction traversal without changing machine privileges; POSIX direct file-symlink coverage remains, but unprivileged Windows direct file-symlink creation is unavailable. Global Bun installation was left unchanged; verification used an isolated, official SHA-verified pinned runtime.

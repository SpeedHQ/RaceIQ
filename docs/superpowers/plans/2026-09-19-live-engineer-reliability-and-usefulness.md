# Live Engineer Reliability and Usefulness Plan

## Goal

Make the ACC live engineer trustworthy under missing telemetry, concurrent warnings, delayed audio, and session changes. Then improve the usefulness of existing announcements before adding event families or games.

**Architecture retained:** source-backed semantic telemetry → stateful server detectors → server delivery policy → deterministic text/audio rendering → browser playback and acknowledgements.

**Scope:** detection, delivery, existing announcement content, capability reporting, and focused verification. No LLM in the live decision path, new speech provider, generic rules engine, broad CrewChief parity project, or new game release enablement.

**Completion:** all reliability gates below pass on the actual browser playback surface and an ACC session; supported capabilities and limitations match documentation. A unit-test pass alone is not release evidence.

## Evidence and baseline

The preceding evaluation found:

- Lost ACC opponent updates can become a spoken side-clear instruction.
- Stale fuel semantics can emit a critical warning; missing initial tyre/lap semantics can prevent subsequent tyre warnings indefinitely. Both were reproduced with executable smoke scenarios.
- Missing or skipped player-lap observations can pair an old lap number with a newer last-lap time.
- Server selection follows telemetry frequency instead of playback availability; the browser rejects concurrent messages, including subsequent spotter transitions.
- Asynchronous audio preparation can survive cancellation and start after expiry.
- Non-pace text callouts can occupy an invisible current slot indefinitely.
- Historical race pace has no explicit age or active-roster policy.
- Architecture documentation overstates game availability and understates implemented speech families.

The focused evaluation run reported **87 passed, 2 failed across 16 files**. The failures concern tyre fixtures using `tire.temperature.average` instead of `.core`, and damage fixtures providing two regions while the detector requires five. These are baseline contract mismatches; do not weaken production requirements merely to turn tests green.

## Decisions and invariants

1. **Unknown is not clear, safe, valid, or zero.** A detector must distinguish unavailable evidence from an observed state transition.
2. **Server owns semantic eligibility and pending speech selection.** Keep the existing runtime as the authoritative pending queue. Browser owns enablement, audio readiness, cancellation, and the single active playback operation; do not add a competing FIFO there.
3. **Spotter reports current occupancy, not historical event backlog.** Retain at most the latest relevant pending occupancy state. Combine simultaneous left/right occupancy into an accurate message; never lose one side through first-message-wins behavior.
4. **One automatic speaker.** Select an audio-ready, radio-enabled client, not simply the first connected socket. Only the assigned client may acknowledge its delivery. Exact responses remain requester-only and must not overlap that client's automatic speech.
5. **Priority expresses driver urgency.** Spotter occupancy and immediate hazards outrank routine pace/lap information. A fastest-lap compliment must not inherit hazard preemption merely because both previously used `high`.
6. **Time domains are explicit.** Do not compare session-clock milliseconds with `Date.now()`. Preserve source time for semantic validity and use an explicit bounded delivery lifetime for transport/playback.
7. **No old speech after cancellation or discontinuity.** Session/stream/epoch changes, disconnect, speaker transfer, and radio disable invalidate pending asynchronous playback work.
8. **Preserve source provenance.** Do not introduce fabricated values or mark conservative/derived evidence as native validity.
9. **Small, coherent changes.** Reuse existing runtime, semantic frame, playback session, release flags, and diagnostics. Any required wire-contract change updates validators and all producers/consumers together; no permanent compatibility aliases.

## Phase 1 — Trustworthy detection

### Task 1: Separate unavailable occupancy from confirmed clearance

**Primary files:** `server/games/acc/broadcast-state.ts`, `server/live-strategy/live-engineer-voice-engine.ts`, `server/live-strategy/spotter-tracker.ts`, relevant spotter contracts and tests.

- [ ] Carry source availability and per-opponent freshness through the existing semantic boundary. Do not discard the only evidence that a previously overlapping car is now unknown.
- [ ] Suppress clearance when overlap evidence disappears because of timeout, malformed arrays, or unavailable player geometry.
- [ ] Recover from unknown occupancy using fresh authoritative observations. Apply existing hysteresis to confirmed transitions, not to source-loss artifacts.
- [ ] Distinguish actual departure/disconnection from uncertain source loss only where the adapter provides authoritative evidence.

**Acceptance:** overlap → stale competitor emits no clear; overlap → fresh non-overlap emits one clear after hysteresis; source recovery does not replay obsolete warnings; simultaneous left/right occupancy remains represented.

### Task 2: Standardize freshness, initialization, and lap continuity

**Primary files:** `server/live-strategy/crewchief-triggers/{catalog,frame,car-health-triggers,strategy-triggers,timing-opponent-triggers}.ts`, `live-engineer-semantic-input.ts`, `live-engineer-voice-engine.ts`.

- [ ] Declare the actual mandatory inputs for each implemented trigger, including all damage regions currently required by its calculation. Separate optional evidence explicitly.
- [ ] Make fresh required evidence a condition for detection. `partial` capability must not imply permission to consume stale required values.
- [ ] Arm transition detectors only after a usable baseline exists; recover when data appears late or disappears temporarily.
- [ ] Define startup behavior by event type: occupancy establishes current overlap, persistent critical conditions remain reportable after qualification, and informational transitions do not replay session history.
- [ ] Rearm/invalidate player-lap tracking after missing observations or nonconsecutive lap transitions. Never reuse old validity with a newer last-lap time.
- [ ] Keep pit, caution, formation, spectating, and session-active policies explicit per family. Avoid blanket suppression that hides important damage/fuel warnings.
- [ ] Correct the existing tyre/damage fixtures to the intended source contract while retaining missing/partial-input cases.

**Acceptance:** stale fuel cannot issue advice; late tyre data recovers; missing lap state cannot produce a falsely attributed valid lap; persistent hazards are not silently latched before delivery eligibility; complete damage evidence emits, incomplete evidence remains unavailable without crashing.

**Phase gate:** focused detection regressions pass. Preserve executable reproductions for the confirmed bugs. No additional voice families until this gate passes.

## Phase 2 — Reliable end-to-end delivery

### Task 3: Define delivery lifecycle, clock mapping, and speaker ownership

**Primary files:** `shared/racing/live/engineer-contracts.ts`, `server/runtime/websocket-manager.ts`, `server/live-strategy/live-engineer-voice-engine.ts`, client WebSocket handling and playback session.

- [ ] Define candidate → pending → assigned/preparing → started → terminal transitions. Terminal outcomes include completed, expired, muted, preempted, failed, and invalidated as appropriate to the existing contract.
- [ ] Bind acknowledgements to delivery ID, assigned connection, and session/epoch. Ignore duplicate, late, or foreign-client status without advancing unrelated work.
- [ ] Extend the existing WebSocket control path with the minimum audio-readiness/settings information needed to choose one speaker. Revoke assignment on disconnect, disablement, or readiness loss.
- [ ] Keep source timestamps and delivery deadlines distinct. Carry sufficient source-clock/epoch information for client validation; map a bounded remaining lifetime to a monotonic browser deadline. Account for transport delay and stale telemetry rather than granting a new full lifetime at each hop.
- [ ] Revalidate both deadline and timeline at receipt, selection, and immediately before audio scheduling. Pauses and suspended audio contexts must not extend a spotter warning's real-time usefulness.
- [ ] Bound preparation/acknowledgement waits. Timeout releases the runtime without replaying stale speech; ownership transfer must not duplicate already-started automatic speech.

**Acceptance:** equivalent wall-clock and session-clock inputs have equivalent expiry behavior; stale/foreign acknowledgements cannot drain the queue; a muted first-connected tab does not capture all speech; disconnect cannot wedge delivery; exact-response routing remains requester-only.

### Task 4: Make arbitration follow playback, not frame rate

**Primary files:** `server/live-strategy/live-engineer-runtime.ts`, `live-engineer-voice-engine.ts`, `client/src/stores/live-engineer.ts`, radio playback controller.

- [ ] Track the in-flight automatic delivery. Select subsequent routine speech only after a terminal acknowledgement or bounded timeout.
- [ ] Define urgency ordering and permitted interrupts explicitly. Spotter may interrupt routine engineer speech; critical engineer hazards may interrupt routine speech; routine pace cannot interrupt a hazard.
- [ ] Coalesce obsolete pending events and revalidate conditions at selection. Expired or contradicted warnings must not survive merely because they entered the queue first.
- [ ] Maintain the latest pending spotter occupancy while another spotter line is active; allow urgent state corrections and deliver relevant clearance without FIFO replay.
- [ ] Apply family enablement before preemption. Disabled spotter events must not cancel enabled engineer speech.
- [ ] Separate candidate dedupe from audible-delivery cooldown. Failed, muted, or queue-dropped messages must not be recorded as heard; do not automatically retry transient information after it becomes irrelevant.
- [ ] Preserve bounded queue/state sizes and diagnostics for each rejection/coalescing decision.

**Acceptance:** simultaneous fuel/flag/lap candidates follow policy rather than disappearing on adjacent frames; a critical hazard can interrupt routine speech; two-sided occupancy is not reduced to one side; quick overlap → clear remains coherent; disabled spotter does not interrupt; terminal acknowledgement drains exactly one next eligible item.

### Task 5: Make audio preparation cancellable and truthful

**Primary files:** `client/src/lib/live-engineer-audio.ts`, `live-engineer-playback-session.ts`, radio playback controller and audio tests.

- [ ] Capture a per-play generation before the first asynchronous operation. Invalidate it on stop/reset and check it after manifest load, resume, download, hashing, decoding, and before scheduling sources.
- [ ] Ensure old work cannot stop or complete a newer playback operation. Share immutable asset buffers only, not playback ownership.
- [ ] Enforce the current delivery deadline immediately before scheduling sound; report `started` at actual playback start rather than before preparation.
- [ ] Clear active/preparing playback on session/epoch change, disconnect, speaker revocation, and radio disable.
- [ ] Expose blocked-audio readiness and provide a user-gesture recovery path. Preserve typed asset/hash/decode errors; allow explicit retry after transient load failures without an unbounded automatic retry loop.

**Acceptance:** cancelling during every asynchronous boundary produces no later audio; newer spotter speech cannot be displaced by older downloads; delayed preparation cannot play expired warnings; reset/disable produces no ghost audio; browser gesture recovery works on the actual surface.

### Task 6: Restore text fallback and lifecycle visibility

**Primary files:** `client/src/components/live-engineer/LiveEngineerOverlay.tsx`, `client/src/stores/live-engineer.ts`, existing radio settings/control surface.

- [ ] Render every accepted callout family using deterministic server semantics, including speech-disabled and audio-failed cases.
- [ ] Expire and advance cards automatically; ensure hidden/unsupported cards cannot pin current state.
- [ ] Clear current/pending callouts on timeline changes while keeping only intentionally retained, bounded history.
- [ ] Surface radio readiness, muted state, and meaningful playback failure without exposing raw internal exceptions to the driver.

**Acceptance:** first message may be spotter, flag, or fuel without blocking later pace cards; text remains usable with audio disabled; expired and previous-session cards do not remain current.

**Phase gate:** execute burst, delayed-audio, mute/preemption, two-client, disconnect/reconnect, and reset scenarios in the browser. Confirm actual sound ordering/cancellation as well as status messages. No release-readiness claim based solely on mocks.

## Phase 3 — Useful, calibrated advice

### Task 7: Define a trustworthy race benchmark

**Primary files:** `server/live-strategy/opponent-pace-tracker.ts`, `live-engineer-voice-engine.ts`, existing opponent-pace tests.

- [ ] Separate qualifying/session-best history from current race-pace samples.
- [ ] Restrict race references to eligible active opponents and a documented age window scaled to lap duration. Require enough recent valid laps; otherwise withhold the claim.
- [ ] Evaluate robust filtering within recent comparable samples before selecting the class reference. Do not use full-session class-wide statistics to erase genuine changes in conditions or a legitimately fast driver.
- [ ] Preserve reference participant, sample count, age, and evidence quality for explanation and diagnostics.
- [ ] Bound stored race history to the required policy window; keep only the compact history needed for qualifying/session-best behavior.

**Acceptance:** a retired fast opponent ages out; old dry laps cannot indefinitely define wet-race pace; fresh valid reference laps still produce stable comparisons; insufficient evidence produces silence, not false precision.

### Task 8: Improve existing speech and health decisions

**Primary files:** existing CrewChief trigger modules, `live-engineer-renderer.ts`, current audio generator/catalog, game/car threshold sources.

- [ ] Replace generic position announcements with an unambiguous overall/class position where supported.
- [ ] Restrict opponent notifications to a useful relationship such as relevant class rival or adjacent competitor. Do not announce every competitor lap merely because it changed.
- [ ] Include actionable fuel estimates when evidence supports them. Include penalty details only when the source provides those details; do not invent the sanction.
- [ ] Correct directional wording: a proximity-only multiclass detector cannot claim traffic is ahead. Add source-backed direction or use accurate nondirectional wording.
- [ ] Reuse existing car/compound threshold sources where appropriate. Validate tyre core versus surface semantics, corner/axle aggregation, sustained temperature qualification, hysteresis, and severe-condition handling. Avoid hiding one overheating corner in a four-corner average.
- [ ] Calibrate fixed coolant thresholds and warm-up delays against supported sources. Unavailable ACC coolant data must remain unavailable, not appear as a validated warning family.
- [ ] Generate only audio segments needed for these changed messages through the existing pipeline. Validate manifest hashes and listen to complete composed phrases, not only isolated clips.

**Acceptance:** each changed line communicates a supported fact or action; critical corner conditions are not averaged away; threshold noise does not cause chatter; phrases remain understandable at normal driving volume.

**Phase gate:** compare before/after callout logs on representative sessions. Record false calls, missed events, emission-to-audio latency, expired/preempted outcomes, and routine speech frequency. Tune policy from observed cases, not an event-count target.

## Phase 4 — Capability truth and release proof

### Task 9: Align capability reporting, tests, and documentation

**Primary files:** `server/live-strategy/crewchief-triggers/catalog.ts`, `shared/telemetry/live/semantics.ts`, `shared/platform/runtime/release-feature-flags.ts`, `docs/architecture/live-voice-engine.md`, `server/live-strategy/README.md`, relevant test suites.

- [ ] Distinguish source availability, implemented detector, render/audio availability, validation evidence, and release enablement. Extend existing capability reporting only as needed; do not build a new monitoring service.
- [ ] Fix required-semantic declarations and report runtime unavailability with a concrete reason.
- [ ] Document actual enabled games and implemented families. Correct side-clear audio descriptions and remove unsupported production-availability claims.
- [ ] Audit existing contract/playback tests for outdated protocol versions, removed store fields, ignored clock arguments, and misleading coverage names. Keep behavioral assertions; remove implementation/wording-only assertions rather than re-pinning them.
- [ ] After runtime proof, update Unreleased release notes and nearby architecture documentation, then remove temporary verification scripts. Do not delete recorded evidence needed to reproduce failures.

### Task 10: Run the release acceptance matrix

Use existing focused tests and replay/dev tooling. ACC UDP competitor snapshots are runtime-only and are not preserved in existing ACCP recordings; a plain recording replay is insufficient proof of spotter/opponent behavior. Use deterministic broadcast fixtures alongside shared-memory frames, then complete a real ACC broadcast session. Add a minimal fixture seam only if existing tooling cannot supply both sources.

| Scenario | Required outcome |
|---|---|
| Fresh overlap, confirmed clear, bilateral overlap | Accurate, ordered spotter state with no lost side |
| Competitor timeout or malformed geometry | No invented clearance |
| Missing initial telemetry, dropout and recovery | Detectors recover without fabricated transitions |
| Lap-number jump, invalid lap, pit/caution context | No misattributed pace or context-invalid advice |
| Fuel/flag/lap burst | Urgency policy respected; no silent queue loss |
| Slow manifest/download/decode or suspended context | No cancelled or expired audio starts |
| Spotter disabled during engineer speech | Engineer speech continues |
| Session reset, reconnect, replay seek | Old work is cancelled; no old-epoch audio/cards |
| Two clients, muted first client, speaker disconnect | One eligible speaker; bounded recovery; valid ACK ownership |
| Audio blocked, missing asset, hash mismatch | Typed failure and usable text/recovery path |
| Retired opponent or changed track conditions | Current-race benchmark stays relevant or is withheld |
| Sustained corner heat versus transient noise | Calibrated warning without average masking or chatter |

- [ ] Run focused server, client, contract, audio, and WebSocket checks using each suite's configured runner. Confirm intended client tests were actually collected, not just named on a command line.
- [ ] Run applicable typechecking/linting once after each coherent integrated change, not concurrently with edits.
- [ ] Inspect the actual overlay/settings surface and exercise real browser audio. Record browser autoplay prerequisites and observed playback ordering.
- [ ] Run an ACC session with shared memory plus broadcast feed, including controlled source interruption and two-client ownership transfer.
- [ ] Record scenario inputs, expected and observed outcomes, remaining limitations, and release-flag state. Do not claim unavailable live/audio verification passed.

**Release gate:** no false clearance, stale/old-session speech, dropped urgent transition, invisible queue blocker, or permanently unarmed detector in the acceptance matrix. No new game enablement in this plan. Keep the feature gated if any reliability gate is unresolved.

## Sequencing and execution boundaries

- Establish the shared lifecycle/time/ownership contract before editing server and client delivery consumers independently.
- Detection fixes and delivery implementation may proceed in parallel after that contract is agreed; serialize overlapping edits to `live-engineer-voice-engine.ts` through one integration owner.
- Finish Phases 1–2 before changing advice policy or expanding generated audio. Phase 3 depends on reliable detection and delivery so content evaluation measures actual speech, not dropped candidates.
- Each implementation task ends with its observable acceptance evidence; do not manufacture tests solely to cover forwarding or field-copy plumbing.
- Make independently releasable commits where possible. Use existing feature flags as the release gate; do not add legacy codepaths as rollback shims.

## Deferred work

Additional CrewChief families, F1/iRacing release enablement, conversational voice commands, and broader strategy coaching are outside this plan. Reconsider only after the reliability matrix passes and the specific game's source-backed inputs, clock semantics, and live acceptance evidence exist.

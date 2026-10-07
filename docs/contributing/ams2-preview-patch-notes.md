# RaceIQ AMS2 preview: running patch notes

This is a local, AI-assisted extension of SpeedHQ/RaceIQ, developed at Shawn's request. It is not an official RaceIQ release and has not been accepted upstream. Changes were implemented with Codex; Shawn supplied requirements, Windows build results and in-game testing. Maintainers can review or select individual changes without adopting the whole preview.

## Source and patch order

- Upstream starting point: RaceIQ 0.19.1, commit `c774b30560a20c30c4ff6716de87d5c59518d4c6`.
- Apply native AMS2 preview, then the ABI 14 compatibility fix, then UI fixes, then Live fixes.
- The preview has now been merged with release v0.19.2 (`8743070f`) and current main (`31984af2`). The compatibility package includes patches against that main revision and upgrades from the earlier preview.
- Earlier entries below are reconstructed from the delivered patches and testing record. Future entries should be appended with their actual validation results.

## Native AMS2 preview and ABI correction (before 2026-10-04)

- Register AMS2 as a game and start a native Windows Project CARS 2 shared-memory reader when AMS2 is detected.
- Normalize supported readings into RaceIQ telemetry and preserve AMS2 car, circuit, track length and lap position.
- Connect recording and session metadata to the game's car and track identity.
- Accept shared-memory ABI 14; retain validation of incompatible snapshots and active participants.
- Read shared memory directly; no SimHub or Simulator Controller process is needed.

Known limits: native reading needs Windows and AMS2's Shared Memory setting set to Project CARS 2. This does not capture a complete editable car setup. Unsupported telemetry fields remain unavailable.

## UI fixes (delivered before this Live patch)

- Add AMS2 branding and game navigation, restore Live child routes and production Raw Data updates.
- Enable game-scoped Driver profiles for AMS2 and iRacing, and respect telemetry capabilities in analysis.
- Add a saved UI scale setting for readability on large screens.
- Make date controls visibly interactive with underline and chevron cues.
- Improve AMS2 car/track metadata and recorded track-outline discovery.
- Gate normalized-suspension checks where only physical travel is available.
- Include affected messages in all 12 supported locales.

Validation recorded at delivery: focused tests, full typecheck and Linux production build passed. Shawn subsequently confirmed UI scaling, date controls and remote HUD access on Windows. A cached backend TypeScript build-info file caused TS2589 during one Windows check; clearing that generated file resolved it. Hard refresh was needed to show rebuilt UI assets.

## 2026-10-04 — Live fixes

### Problems and resulting behavior

- AMS2 Live remained in S1 when the circuit had no recorded outline. Use the game's authoritative track length and per-lap position, including when connecting mid-lap or crossing into the next lap. Preserve existing sector fractions. Mid-sector connections leave unknown split times at zero instead of inventing completed splits.
- AMS2 live delta references now use the game's per-lap position, aligning live and reference distances.
- Tire pressures were available in telemetry but absent from the Live wheel data passed to the tire grid. Forward each available pressure reading in psi.
- Replay pedal charts displayed canonical 0–255 readings under percentage labels. Convert the display series to 0–100 percent, preserving missing readings and leaving source telemetry unchanged.
- The recorded-lap list treated invalid laps as PB and sector-best candidates. Use positive finite valid laps only; invalid laps show no PB or comparison delta.
- HUD QR codes selected the first adapter, including `169.254.83.107`. Filter APIPA, loopback, unspecified, multicast and malformed addresses; prefer physical private LAN interfaces over virtual/VPN interfaces; deduplicate results.
- Prefer the current browser's LAN host when it is an eligible address. Offer an address selector when multiple eligible interfaces exist. Use typed network RPC and localize its label in all 12 locales.
- Keep game links under Home on Live pages, matching the Home game list and respecting hidden-game preferences.

### Remaining limits and review considerations

- AMS2 sectors are distance-derived from configured fractions (fallback approximately thirds), not official game timing-line sector splits. This patch does not claim native sector-boundary support.
- Address ranking cannot establish which of several physical networks a phone is using; the selector provides a manual override. QR access still requires both devices to be able to reach the selected address.
- Automated checks run on Linux with simulated AMS2 packets. Native Windows shared-memory access and actual phone connectivity need in-game testing after installation.
- No PMR or original Assetto Corsa adapter is added by this patch.

### Contribution-guide review

Checked upstream `CONTRIBUTING.md` on 2026-10-04, plus the frontend and track-curation guides. This patch adds an Unreleased changelog entry, uses typed RPC and the existing SearchSelect control, keeps telemetry timing on the server, preserves existing sector fractions, and adds tests for the changed readings and address selection. The Portable route delegates rendering to its dashboard feature component. No database schema is changed.

The test shard check also exposed a missing suite assignment for the earlier native AMS2 test; this patch registers that existing test. Two existing analysis UI assertions still expected pressure units beside every value even though the existing UI labels them once per row; updated those assertions to check the value and unit separately.

### Validation

See the accompanying validation log for the final checks and results of this patch.

### Suggested Windows acceptance check

1. Start AMS2, enable Project CARS 2 shared memory, and enter a driving session.
2. Watch the Live sector indicator progress through S1, S2 and S3 over two laps.
3. Confirm available tire pressures appear and an invalid lap is not tagged PB.
4. Check the replay pedal chart reaches 100% for full input.
5. Open Portable: on Shawn's current LAN, verify the selected host is `10.0.0.203`, then scan the QR code on the phone.
6. Confirm Live still has the game links below Home.


## 2026-10-04 — RaceIQ 0.19.2 compatibility

- Recover the previously delivered combined preview exactly on its documented 0.19.1 base, then merge official release v0.19.2 (8743070f9650c08ac4770f1e9491005a4f0a09fe). The release merge completed without source conflicts.
- Also merge current main (31984af2; includes the 0.19.2 version bump and release CI change), so the app reports the updated version and the review patch targets current upstream.
- Preserve upstream track-catalog/API and build fixes, including bundled offline iRacing maps. Official additions already present in the old preview are excluded from our patch against current main.
- Resolve release-note overlap by retaining the official 0.19.2 release history and putting our features/fixes under Unreleased. Regenerate conflicted catalog output from source, including AMS2, rather than selecting stale generated files.
- Keep the native AMS2 connector, ABI 14 handling, game-scoped Driver profiles, UI scaling, date affordances, Live game links, pressure forwarding, derived sectors, pedal units, valid PB selection and LAN QR selection.
- Broader catalog tests exposed incomplete AMS2 source metadata from the earlier preview. Replace generic session UID parser-state provenance with its actual inputs, specify extension data types, include extensions in coverage counts, and document pressure/pedal/fuel conversions and car/track ordinal hashing.
- Describe available AMS2 fuel litres and percentage projections from normalized fuel and capacity. Unsupported channels stay unavailable; validation is retained.
- No new game adapter is introduced by this compatibility update.

Validation: see VALIDATION.txt and logs in the 0.19.2 compatibility package. The final merged state is tested; no standalone clean-release baseline benchmark or full browser E2E suite is claimed. Windows driving and phone connectivity remain acceptance checks for Shawn.


## 2026-10-04 — AMS2 waiting-screen instructions

- Fix the empty expanded AMS2 section on the Waiting for telemetry screen. The earlier preview registered AMS2 in the game list but did not provide its guide body.
- Show same-PC Windows instructions, AMS2 Options → System → Shared Memory → Project CARS 2, and the need to enter the car and drive in a practice/race session.
- Explain that the native connection does not require SimHub or a separate telemetry tool.
- Add the guide text in all 12 client locales and an Unreleased changelog entry. No connection behavior, telemetry semantics or database schema changes.

Validation: full typecheck and production build, plus a rendered waiting-screen content check. User-side Windows testing remains necessary. No new permanent tests were added for this small instructional UI change.

User verification on 2026-10-04: Shawn confirmed that the remote HUD QR code selected the correct local IP and worked from the remote device.


## 2026-10-04 — Clear stale AMS2 Live data

- Stop publishing menu snapshots that retain the previous AMS2 car and circuit. Paused driving-session snapshots remain supported.
- Expire an AMS2 live frame after five seconds without a new projection, clear live and Raw readings in connected browsers, and return Live to its connection instructions.
- Prevent a refreshed or newly connected browser from receiving the expired frame. Keep the telemetry schema so fresh frames resume without requiring a new schema announcement.
- Clear live readings immediately when the browser loses its server WebSocket connection.
- Leave recorded laps and session storage intact. This change only clears transient live readings; the other games' existing source-silence behavior is preserved.

Validation: 28 focused tests passed across native AMS2 capture, WebSocket publication and client store behavior. Full typecheck and Linux production build passed. Full typecheck required deleting the previously documented generated backend build-info cache after TS2589; no source workaround was introduced. Windows in-game validation remains Shawn's next check: leave the driving session, wait five seconds, then re-enter and confirm readings resume.


## 2026-10-04 — Correct AMS2 test-suite wiring

- Register AMS2's database/native-capture tests as integration tests, matching the existing game packages.
- Replace the bare package-level Bun test command with the repository's owner-scoped runner. It supplies an isolated DATA_DIR and the integration preload, avoiding the real user-data directory.
- The commit hook had blocked Shawn's first commit because the old AMS2 command omitted this setup. A separate Windows tooling failure occurred while probing `node --version`; Node installation/PATH diagnosis is pending, with no hook bypass or tooling-source workaround added.

Validation: all seven AMS2 tests passed through the corrected package integration command, all 88 tooling tests passed locally, shard coverage passed and full typecheck passed. The broader unit run had one unrelated diagnostics test failure because this environment denied OS interface enumeration (`getifaddrs`); the failure is recorded rather than treated as a clean full-suite pass. Shawn's Windows commit checks must be rerun after applying this fix and resolving Node detection.


## 2026-10-04 — Prepare upstream review

- The first uploaded preview commit, 494d8de9, was based on c774b305 and included upstream updates as ordinary file changes. Its direct pull-request comparison therefore included unrelated changes and reported conflicts.
- Resolve the changelog and generated telemetry-catalog conflicts against upstream main 31984af2. Retain upstream release history, bundled offline iRacing maps and release workflows; regenerate the catalog with AMS2 included.
- Prepare the review patch against 31984af2 so a new branch starts from the actual upstream revision and contains only preview changes. The original ams2-native-preview branch remains the Windows-tested checkpoint.
- Scope still includes shared UI/Live/LAN fixes alongside AMS2. Submit as a draft and offer to split these into separate pull requests if the maintainer prefers.

Validation: 57 focused native, WebSocket, LAN, sector, catalog and changelog tests passed; full typecheck and Linux production build passed. The resulting patch requires a fresh branch at upstream 31984af2. No pull request or remote branch was published by Codex during preparation.

## 2026-10-06 — Map and display follow-up

- Prefer completed laps for shared session-map alignment, including completed invalid laps ahead of unfinished tails.
- Fit Overview maps to visible driven positions and keep their size compact on wide screens.
- Correct AMS2 direction arrows, restore the shared Analyse G-force axis, and center the suspension compression-balance display.
- Carry focused alignment, geometry, heading, G-force, and suspension regression coverage. PMR support is excluded from this PR update.
- Validation: 25 AMS2/alignment/changelog tests and 40 client telemetry/geometry tests passed before the repository commit checks.

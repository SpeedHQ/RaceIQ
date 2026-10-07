# Native AMS2 preview for RaceIQ

This source change adds Automobilista 2 directly to RaceIQ on Windows: process detection, PCars2 shared-memory reader, normalizer, native session/lap recording, sparse capture/replay, discovered car/track names, and AMS2 game navigation. It requires no SimHub or Telemetry Tool connection.

Base: SpeedHQ/RaceIQ commit c774b30560a20c30c4ff6716de87d5c59518d4c6, package version 0.19.1. This is not a patch for the older RaceIQ/Telemetry Tool 4.1 project. No upstream repository was changed.

## Apply and build

Use a fresh checkout so existing project work is preserved:

```powershell
git clone https://github.com/SpeedHQ/RaceIQ.git raceiq-ams2-preview
cd raceiq-ams2-preview
git checkout -b ams2-native-preview c774b30560a20c30c4ff6716de87d5c59518d4c6
git apply --check C:/path/to/raceiq-ams2-native.patch
git apply C:/path/to/raceiq-ams2-native.patch
bun install
bun run typecheck
bun test packages/game-ams2/test/ams2.test.ts apps/backend/test/games/shared/release-game-registration.test.ts
bun run build
```

Use Bun 1.4.2 (the repository's pinned version). Run the build on Windows; the normal build includes platform-specific database dependencies. This package contains source changes, not a Windows installer.

## First live test

1. In AMS2's System settings, set **Shared Memory** to **Project CARS 2**. UDP is not required.
2. Start the modified RaceIQ and AMS2. Select AMS2 in RaceIQ, enter a practice session and leave the pits.
3. Verify the log progresses from `[AMS2] Waiting for telemetry` to `[AMS2] Connected to PCars2 shared memory` and `[AMS2] Receiving telemetry: <car> at <track>`.
4. Complete an outlap and two full laps. Check the car/track names, lap times, speed, throttle/brake/steering and saved session. Replay that session after restarting RaceIQ.
5. Check tire pressure against the game display, heading/track orientation and pit transitions. The inherited PCars header labels pressure PSI, while Simulator Controller's AMS2 implementation converts it from kPa. This preview follows the AMS2 implementation and converts kPa to PSI; live confirmation is required.
6. Pause, resume, restart the session and close/reopen AMS2. Confirm stale frames are not recorded as driving and sessions remain separate.

If connection never appears, verify the shared-memory setting and process detection (AMS2AVX.exe or AMS2.exe). Snapshot rejection logs include ABI, game state and participant indices. Frame/persistence failures include their error. Retain RaceIQ's application log when a step fails.

## Validation and limitations

Linux validation covers malformed frames, ABI rejection, pause/replay states, input/fuel/pressure normalization, immutable snapshots, duplicate/odd sequence rejection, exact replay across sparse checkpoints, an outlap followed by two valid synthetic laps, and game registration. The client build and catalog consistency check also run. This does not verify Windows FFI or actual AMS2 telemetry.

Only the stable PCars2 shared-memory prefix is read, accepting ABI versions 8–13. Later fields such as full compound/sector/extended participant data are not decoded. Unsupported analysis channels are marked unavailable. Track names are discovered immediately; outlines depend on existing RaceIQ recording-based track generation and are not prebundled for AMS2. PMR and a UI redesign are outside this preview.

Reference for checked shared-memory layout: Simulator Controller's Sources/Special/AMS2 SHM Connector/AMS2 SHM Connector/SharedMemory.h and AMS2 SHM Connector.cpp (https://github.com/SeriousOldMan/Simulator-Controller).

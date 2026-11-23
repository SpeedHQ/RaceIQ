# Voice-pack gate UI plan

Contract: [shared voice-pack gate](voice-pack-gate-contract.md). Backend can proceed independently using same response shape. Parent owns real integration verification.

## Scope and tasks

Own client query hook, LiveDashboardPage radio reachability (including no telemetry), RadioModal, RadioPlaybackController, localization source messages, focused existing playback tests as needed. Use existing React Query/settings/UI conventions; no automatic installer or remote version discovery. Reuse existing English radio labels and add required localized message keys through project convention. Do not overwrite saved voice preferences while gated.

1. Query authenticated GET status with shared response type, no ready fallback, refresh on Check again/window focus.
2. Radio displays missing/update-required notice with exact required English pack revision and engine compatibility version from shared response, immutable external download and installation guidance; voice switches disabled except ready; text toggle independent. Future language selection is out of scope.
3. Pending/error blocked; show checking or failure with retry. Gate playback before AudioContext construction; report existing asset-missing/catalog-mismatch failures and advance queue for blocked enabled lines; preserve muted behavior for disabled settings. Cancel active playback when ready state lost.
4. Audio manifest loading and voice-line playback consume shared catalog version. Reject mismatched line catalog before AudioContext playback and release delivery with catalog-mismatch.

## Acceptance and edge handling

U1 maps G1/G2: absent, unversioned, older/newer engine or package version, unsupported language, invalid or incomplete packs display contract state; no locally selected version. U2 maps G3: Check again ready transition restores controls without altering saved preferences. U3 maps G4: pending/error never permits audio; retry explicit; text remains independent. U4 maps G4: readiness loss cancels audio, stale async completion cannot revive it, rejected lines advance.

U5/G6: future or legacy catalog lines never start audio; canonical catalog resumes normal playback. Shared E5 exercises actual WebSocket ingress and status gate, supplementing focused playback regression.

## Verification

Reuse shared E1–E5 through real Radio dialog/backend. Isolate DATA_DIR and install actual files; verify gates, links, switch availability and independent settings. E3 uses real ZIP installation. E4 delays real fetch and triggers actual backend I/O failure, then verifies retry/recovery and WebSocket cancellation. E5 rejects incompatible wire catalogs without starting audio and proves canonical playback recovery. Parent records outcomes in shared contract.

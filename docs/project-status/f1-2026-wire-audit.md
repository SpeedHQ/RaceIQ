# F1 25: 2026 Season Pack wire audit

Status: experimental parser foundation, **not** completed DLC support.
Shared backend/UI contract: [macOS goal](macos-desktop.md#shared-telemetry-and-ai-contract).

## Pinned source

Retrieved 2026-10-30 from [EA's specification announcement](https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-2026-season-pack-udp-specification/12187347)
(announcement version 11.0). The implemented structures are the attached
[2026 Season Pack Telemetry Output Structures (1).txt](https://forums.ea.com/t5/s/tghpe58374/attachments/tghpe58374/f1-games-game-info-hub-en/61/8/2026%20Season%20Pack%20Telemetry%20Output%20Structures%20%281%29.txt).

Original attachment SHA-256 (including CRLF line endings):
`4f97867924f5f13f11b7fde6eb84ccb3aefcaf69062424bc077e387090647c72`.
Keep the source external; tests construct synthetic packets, not a copied game
recording or a redistributed specification.

The browser's download control subsequently exposed the current
[Season 8 PDF, version 1.2](https://forums.ea.com/t5/s/tghpe58374/attachments/tghpe58374/f1-games-game-info-hub-en/61/10/Data%20Output%20from%20F1%2025%202026%20Season%20Pack%20%28Season%208%29.pdf).
Retrieved 2026-10-30; SHA-256:
`3f38858c3ca65b2faa55a90a35277dd2767bb9cea2911e741b61b370a39365ae`.
Its 13 implemented structures match the text's ordered field types and array
capacities. Packet sizes match the decoder matrix and all documented packets
remain version 1. Minor source spelling differences (`vehicleFiaFlags` and
`ersHarvestedLimitPerLap`) do not change the packed layout; the PDF also omits
some struct-closing punctuation, so the complete text structures remain useful.

The appendices retain session types 0-18 and introduce distinct 2026 team IDs
above 255 (including Audi/Cadillac) and Madrid track ID 42. Catalog mapping,
geometry availability and season-aware AI/UI interpretation still need work;
confirming the wire layout does not complete those requirements.

## Identity and semantics contract

- Both formats belong to the existing `f1-2025` installed-game adapter and routes.
  No persisted session/car/track IDs are renamed or bulk migrated.
- Select decoding from `PacketHeader.packetFormat`, not the game year, buffer
  length alone, or whichever format last arrived.
- Expose `f1.packetFormat = 2026` on new snapshots. Legacy 2025 snapshot shape
  remains unchanged. Old v1 parser checkpoints still restore with 2025 defaults.
- Wire format is **not** car regulations. `f1.carTelemetry2.regulations2026`
  independently reports whether the selected car follows 2026 regulations.
- Packet 16 is `f1.carTelemetry2`: active-aero mode/availability/distance,
  overtake availability/active/distance, regulations flag and wrong-way status.
  These do not overwrite DRS activation or availability.
- Preserve ERS readings in joules. `ersHarvestLimitPerLap` is distinct from
  deployment and harvested energy; do not substitute a legacy fixed energy cap.
- A session UID, player index or format change clears accumulated caches. A new
  snapshot waits for motion, session, lap and telemetry again. Checkpoints retain
  the wire format and packet-16 state for indexed replay.
- 2026 decoder entry requires the exact known packet size, player index 0–23,
  and packet version 1. Unknown versions/layouts fail closed before state changes.
  Version 1 matches the Season 8 version 1.2 specification; later versions need
  independent specification/capture evidence, not acceptance by size alone.

## Decoder matrix

Lengths include the unchanged 29-byte header. Offsets below are payload-relative.

| Packet | 2026 bytes | Initial implementation |
| --- | ---: | --- |
| Motion (0) | 1325 | 24 × 54-byte cars; signed int16 g-forces / 1000; angles at 42/46/50 |
| Session (1) | 926 | Existing common fields; pit windows 653/654; sector boundaries 716/720 |
| Lap (2) | 1399 | Unchanged 57-byte per-car layout, expanded to 24 cars |
| Event (3) | 45 | Existing start-light/session-start events only |
| Participants (4) | 1470 | 60-byte entries; u16 driver/network/team IDs; names at 10 |
| Setup (5) | 1233 | Existing 50-byte selected-car setup layout |
| Telemetry (6) | 1448 | 59-byte entries; u8 engine temperature; shifted pressures/surfaces; suggested gear after 24 cars and two MFD indices |
| Status (7) | 1445 | 59-byte entries; harvest limit at 50; deployed energy at 54 |
| Final classification (8) | 1134 | Existing 46-byte selected-car result layout |
| Damage (10) | 1133 | Existing 46-byte selected-car damage layout |
| Session history (11) | 1460 | Existing lap/sector history layout |
| MotionEx (13) | 273 | Existing common physics channels; new camber arrays not yet exposed |
| Telemetry 2 (16) | 269 | New 24 × 10-byte active-aero/overtake/regulations entries |

Lobby, tyre sets, time-trial records and lap-position history remain ignored as
before. New session aero/DRS zone arrays and additional event variants are not
exposed yet. The table is a decoder audit, not a promise of complete UI coverage.

## Evidence and remaining gates

`packages/game-f1-2025/test/f1-2026-telemetry.test.ts` uses specification-derived
packets to cover car 24, signed/quantized g-forces, shifted temperatures/pressures,
16-bit identities, grid capacity, separate active aero/overtake, ERS limits,
strategy/sector offsets, checkpoint parity, mixed-format reset, malformed-packet
rejection and lossless sparse storage. It does not replace the committed real
2025 recording tests or the real 2026 recording acceptance gate.
The generated semantic catalog names the new channels explicitly, preserves
metres/joules/booleans and the two-mode active-aero enum, and keeps overtake
distinct from DRS. A catalog contract test prevents heuristic unit/name drift.

Read-only local TrackTitan investigation found no raw recording in its app data,
temporary files or logs. Logs confirm `F12026` telemetry was received. Neither
account storage nor configuration was changed. Subsequent user-authorized SSH
inspection of the Windows SimHub installation found 35 persisted lap traces,
20 under 2026-car folders. The inspected Imola trace is explicitly simplified;
these records are not accepted as original UDP evidence. SimHub's Replays
directory contained only a Gran Turismo 7 recording. Existing recordings and
SimHub settings were not changed by the SSH inspection.

### First real relay capture — 2026-10-31

A private, timestamped raw recording was received on the Mac through the user's
existing SimHub UDP relay on port 20778. It contains 47,789 datagrams and
48,700,688 bytes; SHA-256:
`46fdd19219a50349681b109bb358e6adb037d9aee0b7160faca2a025dabd0bd1`.
The recorder closed cleanly, flushed the file, and its frame count and complete
stream boundaries pass strict capture-framing validation. The original remains
under ignored local `data/`; it has not been uploaded or committed.

All received headers report wire format 2026, packet version 1. The production
parser emitted 45,118 snapshots with no exceptions and no size mismatches among
the observed supported packets. Session identity is Mexico (track 19), Mercedes
2026 (team 476), time trial, formula 13. Active aero switches between modes 0 and
1, the regulations flag is true, and the reported per-lap harvest limit is
6,600,000 J. That observed limit is not replaced by the synthetic fixture's
deliberate 8,000,000 J value.

The native completed-lap reading is 79.588 s, but the first received lap-data
packet is already 1.919 s into lap 2. This proves real wire decoding, not complete
start-to-finish lap capture or UDP-to-dashboard acceptance. A further capture
armed before driving is requested for that gate; no missing samples are invented.

Before marking the milestone done:

1. Apply the verified Season 8 car/track catalogs and remaining ERS/setup
   semantics without rewriting historical 2025 identities.
2. Complete the UI/AI-context half of the shared contract: correct season labels,
   active aero/overtake, ERS mode names/limits, and unavailable states. Do not
   present the current legacy DRS/ERS UI as complete 2026 support.
3. Finish the two-engine **UDP browser** matrix through capture, Replay,
   Compare and export/import. The full 2025 trace and synthetic 2026 re-encoding
   pass Chromium and WebKit with source-time pacing. The combined run's saved
   result is passed with no failed tests; native WKWebView remains a separate gate.
   Synthetic aero/energy values and g-force saturation are explicitly labeled,
   not treated as measurements from a real 2026 car. A high-speed flood exposed
   the existing detector queue's overload/fatal-error behavior; do not describe
   the paced acceptance tests as proving arbitrary burst tolerance.
4. Obtain complete timed laps in real 2026 UDP, review known lap/sector/channel
   values, and pass the same live/capture/import/export/Replay/Compare path on
   both formats. The first real recording above starts partway through a lap.
5. Repeat native WKWebView capture/restart checks with the updated backend.

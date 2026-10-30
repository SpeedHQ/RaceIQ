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

EA also lists a newer **Season 8 PDF**. Its download link was unavailable through
the retrieved page, and direct page retrieval returned HTTP 403. That PDF's
appendices and any revised packet versions remain an explicit cross-check gate;
the announcement revision is **not** a claim that the text matches that PDF.

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
  Version 1 is the conservative initial supported matrix; later versions need
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
account storage nor configuration was changed. A SimHub recording on another PC
requires an explicit mounted/shared path or connection from the user; local LAN
addresses in logs are not authority to inspect that computer.

Before marking the milestone done:

1. Cross-check the latest Season 8 PDF, including packet versions, catalogs,
   session types, and changed ERS/setup meanings.
2. Complete the UI/AI-context half of the shared contract: correct season labels,
   active aero/overtake, ERS mode names/limits, and unavailable states. Do not
   present the current legacy DRS/ERS UI as complete 2026 support.
3. Add specification-derived **UDP browser** tests through capture, Replay and
   Compare. Current new tests are parser/storage tests, not browser acceptance.
4. Find or record real 2026 UDP, review known lap/sector/channel values, and pass
   the same live/capture/import/export/Replay/Compare path on both formats.
5. Repeat native WKWebView capture/restart checks with the updated backend.

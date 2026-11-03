# LMU real-opponent fixture provenance

Derived from supplied `packages/game-lmu/test/fixtures/laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin` (local ignored original).

- Source SHA-256: `c596c1b05bf658488f8fe90f3c412e3de1e1446a79baf75b24f583d669a1d1c7` (16,629,389,274 bytes; LMUQDMP v1; 30,957 frames).
- Selected original record indices: 14,500 through 30,956 range, every 50th record (330 actual selected frames; final selected index 30,950).
- Original selected decoded-frame concatenation SHA-256: `cdec1e517a830a21c28dc9098d4a4ddf1a41de4c05f6d3769f2dad24974b4b10`.
- Native timestamp range: 1,792,706,591,752–1,792,706,777,677 ms. Native capture sequences: 14,515–30,965; 16,121 absent sequence values across selected observations. The sampled records retain their original values; they are not renumbered or retimed.
- Original session key: `5371b669-f97a-4a38-b7ae-78e670d20e43:15`; per-frame identity/context retained. Names observed include `Monsieur PTITRAIN` and `A Cooper#3593`; source player is `A Cooper#3593`, not an opponent. Catalog identity remains keyed by source session generation, vehicle and incarnation, not names.
- Fixture uses production LMU dump decoder per source record, native v3 decoder, and production sparse capture encoder. Gzip fixture size: 3,648,326 bytes.
- Reproduce with `bun packages/game-lmu/test/support/derive-opponents-fixture.ts` while original supplied capture remains at source path. Script verifies complete source framing, source hash, selected native-v3 decoding and reports selected-frame hash before writing fixture.

Limitations: sampling every 50 records yields large sequence gaps and partial/unknown coverage; fixture does not claim continuous data or complete laps. Original capture includes 15 historical identities overall; chosen stable tail captures identities present in its sampled interval only. Source-derived invalid/unknown player lap state is preserved; it is not repaired or synthesized. Native scoring update counters restart while the original session clock advances; replay keeps original counters and emits explicit continuity gaps rather than rewriting this evidence.

## Full-grid fixture

`lmu-real-opponents-grid-2026-10-22.bin.gz` retains original record indices 0–100, every second record: 51 exact native-v3 frames, 1,922,505 compressed bytes. Selected decoded-frame SHA-256 is `a9104d728cf612e3ba17e08216a84a01af8d72ccc7c907a78a7022cf29f85578`; the same derivation command verifies source SHA-256 and sparse decoded conservation for both fixtures.

Source generation `5371b669-f97a-4a38-b7ae-78e670d20e43:1` includes opponent vehicle IDs 16, 17, 18, 20, 22, 24, 30, 32, 34, 35, 37, 47, 50, 51 and 53. Player vehicle 54 (`A Cooper#3593`) is retained in source bytes but excluded from opponent records. This short partial grid verifies all 15 individual identities and lap membership; it is not evidence of full-lap coverage for those drivers. The stable-tail fixture separately exercises recorded player/opponent comparison and source counter resets.

## Complete multipart seed

The entire source recording—not a sampled replacement—is retained as `../laps/lmu-2026-10-22T21-59-41-929Z-f9c5a07c-aa24-42bb-a574-50784313fe93.bin.gz.part01` through `.part11`.

- Parts 01–10: 99,000,000 bytes each; part 11: 86,532,236 bytes. Every part is strictly below 100,000,000 bytes.
- Reassembled gzip: 1,076,532,236 bytes; SHA-256 `3611d954e5ff2db2b97a2a93c20d118eac94513c665a67df4e90b63afce95de8`.
- Streamed decompression verified gzip integrity and exact source SHA-256/16,629,389,274-byte conservation, including all 30,957 frames.
- Default LMU seed registration imports the parts once as one logical recording. Native full-memory seeds use the production direct recorder to separate player data from an opponent companion; explicit legacy-layout seeds retain the offline sparse path.
- Isolated full seed processed 30,957 packets into 15 original session generations and 17 invalid/incomplete player laps. No clocks, sequences or validity states were repaired.
- The lightweight screenshot seed excludes the complete multipart recording; bounded recording-backed tests cover multiplayer browser flows.
- Recording-backed live-ingress regression feeds the 51 unchanged grid frames through `parsePacket` and `LiveTelemetryPipeline.processPacket`, checks actual primary/companion files, and verifies exact native-byte/timestamp restoration and all 15 opponent identities. This does not exercise Windows shared-memory acquisition.
- Repeat full seed was a no-op with unchanged 15 generation rows and 17 lap rows. Normal startup removed one empty generation; the real HTTP opponent catalog returned all 15 opponent identities and excluded player 54.
- Additional CLI proof restored all 51 original grid frames byte-for-byte in both direct primary/companion mode and explicit legacy flat mode. The compact fixture retained 4,309 frames and three laps (one valid).
- Tests belong to nested `@raceiq/game-lmu-tests` workspace: live-ingress regression is `../../e2e/backend/session-capture/opponent-recording-policy.test.ts`; real comparison/grid browser cases are under `../../e2e/browser/compare/`. Fixtures remain at these original package-owned paths; workspace restructuring does not rewrite native bytes.
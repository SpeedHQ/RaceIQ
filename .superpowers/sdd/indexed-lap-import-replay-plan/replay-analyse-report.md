# Replay / Analyse implementation report

## Focused verification

- `bun test test/games/ac-evo/ac-evo-batch-decode.test.ts --timeout 180000` — PASS (1 test, 21 assertions).
- `bun test test/games/f1-2025/f1-indexed-replay.test.ts test/games/ac-evo/ac-evo-batch-decode.test.ts --timeout 180000` — FAIL: F1 recorder fixture `f1-2025-2026-04-22T11-42-43-029Z.bin.gz` has no packets through `parseDump` (`rawPackets.length === 0`); test fixture framing/parser helper still needs repair.

## Changes

- Loaded capture cache now stores decompressed ordered frame index records (`offset`, `length`, `frameIndex`) and offset lookup. Index uses canonical framing helpers and preserves gzip and cache invalidation metadata.
- Raw replay prefix warm-up now uses `primeParserState` over indexed complete records, avoiding `tryParse` materialization for stateful prefixes. Full parse remains limited to requested frames plus trailing completion frame.
- Added `getLapMetaById` export (currently compatibility wrapper; full metadata query split remains incomplete).

## Remaining gaps

- F1 indexed replay test must use fixture-aware framing/parser helper and deterministic timestamp normalization.
- `parseSessionLapsBatched` still consumes streaming capture iterator; indexed cache is used by single-buffer replay prefix path, but batched path needs direct loaded-index traversal to fully satisfy plan.
- `getLapMetaById` must be changed to metadata-only DB query and semantic route must pass already-loaded packets/source to resolver; current wrapper still invokes full loader.
- Comparison batching regression test was already present in existing branch and was not duplicated.

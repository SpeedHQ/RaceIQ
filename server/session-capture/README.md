# Session capture

## Purpose

Owns RaceIQ raw-session persistence: length-prefixed frame recording, gzip storage, capture identity, import replay, session reprocessing, and orphan-file maintenance.

## Structure

- `framing.ts` defines capture framing and gzip helpers. `recorder.ts` appends frames and patches the final frame count.
- `import-capture.ts` detects canonical uploads and feeds them to `import-pipeline.ts`, which captures imported database identities and rolls failed imports back.
- `reprocess.ts` replays stored frames through the current lap detector; `reprocess-quality.ts` merges recomputed packet evidence with preserved source-lifecycle and writer evidence.
- `identity.ts` hashes decompressed capture content so raw and gzip storage represent the same input.
- `compressor.ts` and `cleanup.ts` maintain recorded files after sessions finish.

## Boundaries and invariants

- Capture bytes are an optional 12-byte metadata frame (`0xffffffff`, payload length `4`, frame count), followed by ordered `[uint32 LE length][payload]` records. Strict readers reject malformed framing and nonzero declared counts that differ from consumed records; they do not repair or reorder data. A zero declaration remains valid for unfinished and legacy captures.
- Gzip changes storage encoding only. Identity hashes, parsing, and reprocessing operate on decompressed bytes.
- Recording paths and names are chosen by telemetry/runtime adapters. This domain must not change their naming, activation, or shutdown order.
- Game adapters own frame recognition and parsing. Telemetry owns live pipeline behavior. Database modules own session/lap persistence. Race-result reconciliation runs only after a successful import.
- Reprocessing recomputes replayable facts but retains non-replayable source and writer events, deduplicated by stable event identity. Missing raw capture makes detector/schema quality rebuild unavailable.
- Import and live session finalization await every pending lap write before applying session quality generations, preserved source facts, or rebuild state.
- Import rollback deletes sessions and their newly recorded files. Scheduled maintenance skips active recordings; background compression remains age-gated, while user-triggered compression also includes untracked `.bin` files.

## Testing

`test/raw-binary-storage.test.ts` covers metadata bytes, offsets, reprocessing, and truncated captures. `test/session-recorder.test.ts` covers record round trips and truncated final records. `test/session-compressor.test.ts` covers gzip output and age gating. `test/raw-capture-identity.test.ts` covers storage-independent hashes. `test/lap-export-import-roundtrip.test.ts` covers capture slicing and import replay. Changes to framing or file maintenance should preserve these byte-level and lifecycle contracts.

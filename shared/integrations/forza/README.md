# Forza archive utilities

Node-side helpers for reading Forza's non-standard compressed archives. They remain available for parsing and decompression tests.

## Modules

- `zip.ts` reads ZIP files and exposes central-directory entries plus compressed byte ranges.
- `lzx-decoder.ts` decompresses ZIP method 21 / XMem LZX payloads.
- `internal/lzx-engine.ts` implements decoder internals used by `lzx-decoder.ts`.

These modules are Node/Bun-only. Keep browser code from importing them and preserve explicit leaf imports.

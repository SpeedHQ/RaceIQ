# Forza extraction utilities

Node-side helpers for locating a Forza Motorsport installation and reading its non-standard compressed archives.

## Modules

- `install.ts` reads Steam's library metadata and finds the installed game directory.
- `zip.ts` reads a ZIP file and exposes central-directory entries plus compressed byte ranges.
- `lzx-decoder.ts` decompresses Forza ZIP method 21 / XMem LZX payloads.
- `internal/lzx-engine.ts` implements the bit reader, Huffman tables, sliding window, and decoder state used by `lzx-decoder.ts`.

## Runtime boundary

This directory is Node/Bun-only. `install.ts` and `zip.ts` use `node:fs`; archive modules use `Buffer`. Browser code must not import these modules. Game extraction code in `server/games/fm-2023` is the outward consumer.

Dependency flow is:

`shared/forza/internal/lzx-engine` -> `shared/forza/lzx-decoder` -> `server/games/fm-2023/extraction`

`shared/forza/install` + `shared/forza/zip` -> `server/games/fm-2023/extraction`

## Extending extraction

- Keep archive parsing and decompression independent of server state; pass paths, buffers, and expected sizes explicitly.
- Treat `internal/lzx-engine.ts` as an implementation detail of `lzx-decoder.ts`.
- Keep framing fallbacks and terminal failure behavior deliberate; archive framing varies between files.
- Import explicit leaf modules such as `shared/forza/zip`; do not add a barrel.

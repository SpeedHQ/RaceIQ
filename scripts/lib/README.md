# Script helpers

## Purpose

Small, side-effect-free utilities shared by multiple script domains.

## Modules

- `cli.ts`: positional option lookup shared by script entrypoints.
- `compression.ts`: gzip magic detection and conditional decompression.
- `csv.ts`: standards-safe CSV cell escaping.
- `http.ts`: retry and delay primitives for network scrapers.
- `pool.ts`: bounded asynchronous work scheduling.

## Boundaries

- Helpers must not parse process arguments, write files, start work, or call `process.exit` at import time.
- Callers retain domain policy: headers, retry limits, compression expectations, validation, and error wording.
- Add a helper only when at least two consumers need identical behavior.
- Import explicit module leaves; no barrel exports.
- Prefer typed inputs and return values. Do not hide lossy conversion or fallback behavior in generic helpers.

## Verification

Exercise helpers through owning entrypoint tests. Use `bun run typecheck:scripts` for cross-domain import and type validation.

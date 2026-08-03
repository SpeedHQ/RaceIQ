# shared/catalog

Shared CSV parsing utility used by catalog loaders in `shared/track` and `shared/car`.

## Purpose
- Provide one parser that matches RFC-4180-like single-line semantics.
- Keep quote handling consistent across game feeds.
- Avoid inline ad-hoc splitting logic in every loader.

## Module contract
- `parseCsvLine(line: string): string[]`
  - Supports quoted fields with embedded delimiter handling.
  - Supports escaped quote pairs `""`.
  - Splits only on commas outside quote context.
- No trimming is performed by the parser; callers own normalization.
- Caller owns header skipping and typed conversion.

## Browser vs Node boundary
- `shared/catalog/csv.ts` is pure and browser-safe.
- Loader modules that call it are Node-side when they read files.

## Dependency direction
- `shared/catalog/csv.ts` sits at the utility leaf.
- Track catalog modules (`shared/track/catalogs/*`) and car catalog modules (`shared/car/*`) import it directly.

## Extend safely
- Preserve the documented single-line quote and delimiter semantics when changing the parser.
- Keep multi-line records or alternate delimiters in a format-specific caller rather than broadening this neutral primitive.
- Import `parseCsvLine` directly from `shared/catalog/csv`; this directory has no barrel contract.

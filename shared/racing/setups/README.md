# Setups

## Purpose
Shared setup-file contracts, lossless setup-form field paths, and semantic setup catalog inputs used by browser UI, server validation, and telemetry catalog generation.

## Key modules and nested folders
- `schema.ts`: ACC and AC Evo form sections, dotted setup paths, corner/axle arity, and round-trip-safe nested object accessors.
- `file-formats.ts`: accepted extension/payload contract for ACC `.json` and AC Evo `.carsetup`, client/server rejection messaging, and loose ACC JSON shape guard.
- `catalog/groups.ts`: semantic setup group and source-mapping contracts.
- `catalog/concepts.ts`: canonical setup semantic IDs, labels, units, and shapes.
- `catalog/file-source-mappings.ts`: ACC/AC Evo setup-file paths mapped to semantic IDs.
- `catalog/parser-source-mappings.ts`: game-parser setup paths mapped to semantic IDs.

## Browser vs Node boundary
- `schema.ts` and `file-formats.ts` are shared by browser components and server routes. Keep them free of DOM, Node, and file-system APIs.
- Browser code uses schema fields to render/edit setup JSON and uses file-format helpers for drop-zone checks.
- Server code reuses the same file-format contract before reading or placing setup files; simulator-specific binary I/O remains under `server/games/` and `server/routes/`.
- Catalog files are declarative generator inputs and have no runtime side effects.

## Dependency direction
- `shared/racing/setups/*` may depend on shared primitive contracts such as `shared/games/ids.ts` and Zod.
- Client and server setup flows consume `schema.ts` and `file-formats.ts` directly.
- `scripts/catalog/generate-telemetry-catalog.ts` consumes `schema.ts` plus every file in `catalog/`; generated telemetry artifacts depend on these definitions, never the reverse.
- Do not import client UI or server file I/O into this folder.

## Add/extend safely
- New editable ACC/AC Evo field: add one typed source entry with its path, label, description, cardinality, unit, and semantic link in `catalog/file-source-mappings.ts`; preserve simulator click values so setup JSON round-trips without normalization loss.
- New supported setup upload format: update `SetupGameId` and `SETUP_FILE_FORMATS` in `file-formats.ts`, then implement game-specific I/O at server boundary. Do not guess binary formats or coerce `.carsetup` bytes through JSON.
- New semantic setup concept: define group/concept first, then add each parser or file source mapping with native unit and explicit normalization or simplification when not direct.
- Any change under `catalog/` or in `schema.ts` requires telemetry catalog regeneration:
  - `bun run telemetry:catalog`
  - `bun run telemetry:catalog:check`
- Generated files live under `shared/telemetry/catalog/generated/`; never edit them manually.

## Source of truth and regeneration
- `catalog/file-source-mappings.ts` is source of truth for typed Kunos setup-file sections and fields; `schema.ts` derives form sections and safe read/write handles from those catalog entries.
- `catalog/data.ts` assembles setup variables and per-game sources, including known iRacing `CarSetup` fields for future setup surfaces.
- `catalog/groups.ts`, `catalog/concepts.ts`, and `catalog/parser-source-mappings.ts` are source inputs for semantic setup coverage in telemetry catalog.
- These files are hand-maintained. Regenerate only downstream telemetry artifacts after changes.

## Leaf imports (no barrel)
Use direct file imports only.

```ts
import { getSchemaForGame, readSetupField, readSetupSection, writeSetupField } from "@shared/racing/setups/schema";
import { SETUP_CATALOG } from "@shared/racing/setups/catalog/data";
import { getSetupCatalogSources } from "@shared/racing/setups/catalog/query";
import { AccSetupJsonSchema, setupFileFormat } from "@shared/racing/setups/file-formats";
```

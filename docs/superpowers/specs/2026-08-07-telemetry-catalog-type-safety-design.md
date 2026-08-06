# Telemetry Catalog Compile-Time Type Safety

## Goal

Make telemetry catalog IDs, tree references, semantic IDs, and per-game source paths reject invalid literals with TypeScript errors. Keep normalization text descriptive; type the executable normalization registry separately.

## Current gap

`shared/telemetry/catalog/contracts.ts` models catalog identifiers and source paths as `string`. `normalization?: string` documents parser behavior but is not executable. Runtime validation checks referential integrity after loading the catalog; it cannot provide authoring-time errors.

## Design

Generate a TypeScript type sidecar from the same catalog generation output as the JSON catalog. Export literal unions/maps for:

- group IDs;
- variable/semantic IDs;
- per-game source paths;
- source-path lookup by `GameId`.

Update catalog contracts to consume those generated types:

- group `id`, `parentId`, and child references use generated catalog ID types;
- variable `id` and `parentId` use generated group/variable ID types;
- source `semanticId` uses generated variable ID type;
- source `path` and available-link `sources` use the selected game's generated source-path type;
- `games` remains keyed by the existing `GameId` union;
- `normalization?: string` remains descriptive metadata;
- executable behavior continues to be represented by existing typed `execution`, reader, and derivation mechanisms.

The generated catalog remains the single source of truth. No hand-maintained duplicate unions.

## Type behavior

Authoring a catalog entry with an unknown group, semantic ID, parent, child, or game-specific source path must fail TypeScript compilation. Existing runtime catalog validation remains because generated JSON and external/custom catalog data can still be malformed at runtime.

## Compatibility

The generated JSON shape remains unchanged. Public runtime APIs remain unchanged except for stricter compile-time contract types. Existing consumers using catalog values continue to work because generated values are already catalog members.

## Verification

- Add type-level fixtures/assertions proving valid generated IDs and paths compile.
- Add negative compile checks proving unknown IDs and wrong-game paths fail.
- Run catalog generation and confirm JSON/type sidecars are synchronized.
- Run focused catalog validation tests and TypeScript checks for shared/server consumers.

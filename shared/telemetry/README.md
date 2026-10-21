# Telemetry

## Purpose
Shared semantic telemetry contracts and catalog data used by live capture, replay, and UI analytics. Executable resolver, derivation, replay, and live algorithms belong to `@raceiq/telemetry-core`.

This folder is source of truth for:
- semantic variable model (`valueType`, `cardinality`, `shape`, units, provenance)
- catalog lookup and validation
- resolver contracts and versions
- canonical replay value contracts

## Key modules and nested folders
- `catalog/contracts.ts`: catalog, source, and variable schema types.
- `catalog/data.ts`: runtime catalog entrypoint re-exporting generated artifact values.
- `catalog/query.ts`: indexed helpers (`getTelemetryVariable`, `getTelemetryChildren`, `getTelemetrySources`, `getSourcesWithoutSemanticDefinition`).
- `catalog/validation.ts`: integrity checks and complete-catalog guardrails.
- `catalog/generated/`: generated catalog artifacts.
- `resolver/contracts.ts`: `CompiledTelemetryResolver`, `TelemetryFrameView`, resolved-value, and slot contracts.
- `@raceiq/telemetry-core/telemetry/resolver/compile`: `compileTelemetryResolver` and graph build.
- `@raceiq/telemetry-core/telemetry/resolver/{value,readers,plan,frame-view}`: value coercion, source readers, plan models, frame cache.
- `resolver/versions.ts`: `TELEMETRY_RESOLVER_VERSION`, `TELEMETRY_PARSER_VERSIONS`.
- `derivations/contracts.ts`: derivation contracts; evaluator set lives in `@raceiq/telemetry-core/telemetry/derivations/builtins`.
- `replay/contracts.ts`: persisted replay payload; strict canonicalizer lives in `@raceiq/telemetry-core/telemetry/replay/canonicalize`.
- `types.ts`, `version.ts`, `f1-2025.ts`, `kunos.ts`, `iracing.ts`: normalized packet, version identity, and parser-domain typings.

## Browser vs Node boundary
- Contracts, catalogs, resolver, canonicalizer, history, semantics, and normalization are browser-safe leaves.
- `@raceiq/telemetry-core/telemetry/live-projector` is a separate Node leaf using `node:crypto`; browser consumers must not import it. Wire encoding lives in the separate `telemetry/live-wire` leaf.
- Production replay consumers import the resolver directly from telemetry-core. Shared contracts never depend on either algorithm-core workspace.
- Generator side effects live in `packages/tooling-catalog/src/catalog/generate-telemetry-catalog.ts` (Bun/Node), which writes artifacts under `shared/telemetry/catalog/generated`.

## Dependency direction
- Upstream dependencies:
  - generator consumes source-of-truth inputs from `shared/telemetry/*`, neutral setup definitions, assembled setup catalogs in `packages/game-catalogs/src/racing/setups/catalog/`, iRacing metadata `session-info/*`, and server game parsers.
  - built-in derivations use parser-independent semantic contracts only.
- Downstream dependencies:
  - `shared/telemetry/catalog/data.ts` and `replay/contracts.ts` are consumed by server and client telemetry code.
  - resolver modules feed replay writers, live display, map overlays, and validation helpers.
- Avoid cyclic use: app code must import from telemetry leaves, not re-export telemetry from domain folders.

## Add/extend safely
- To add or adjust semantic variables:
  1. update canonical source inputs (`shared/telemetry/*.ts`, neutral setup definitions/schema, assembled game catalogs, iRacing metadata `session-info/*`, and server parser contracts as needed).
  2. run generator so provenance, source hashes, and mapping provenance stay consistent.
  3. add/adjust derivation registration in `@raceiq/telemetry-core/telemetry/derivations/builtins` only when semantic-level computation is intentional.
  4. update schema/consumer code where semantic IDs are enumerated explicitly.
- Never edit generated outputs by hand; edit only source inputs.

## Generated/static artifacts
Generated outputs under `shared/telemetry/catalog/generated`:
- `telemetry-catalog.generated.ts`
- `telemetry-catalog.generated.json`
- `TELEMETRY_CATALOG.md`
- `telemetry-catalog-matrix.md`

These files are not hand-edited.

Source-of-truth list is declared by generator and stored in `generatedFrom`.
Current generator inputs are enumerated in `generatedFrom`, including shared packet contracts, neutral setup schema/definitions, assembled setup catalogs, iRacing metadata session-info, recorded diagnostics, each registered game parser, and the iRacing normalizer.

Regeneration:
- `bun run telemetry:catalog` (write artifacts)
- `bun run telemetry:catalog:check` (verify artifacts match + determinism)
- optional compatibility mode: `bun packages/tooling-catalog/src/catalog/generate-telemetry-catalog.ts --check --baseline <path-to-baseline-json>`

## Leaf imports (no barrel)
Use direct file imports only.

```ts
import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import { getTelemetryVariable } from "@raceiq/shared/telemetry/catalog/query";
import { TELEMETRY_CATALOG_HASH } from "@raceiq/shared/telemetry/catalog/data";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import type { CanonicalTelemetryEnvelope } from "@raceiq/shared/telemetry/replay/contracts";
```

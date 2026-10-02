# Telemetry

## Purpose
Shared semantic telemetry contracts and shared runtime used by live capture, replay, and UI analytics.

This folder is source of truth for:
- semantic variable model (`valueType`, `cardinality`, `shape`, units, provenance)
- catalog lookup and validation
- resolver compile/resolve pipeline
- canonical replay value envelopes

## Key modules and nested folders
- `catalog/contracts.ts`: catalog, source, and variable schema types.
- `catalog/data.ts`: runtime catalog entrypoint re-exporting generated artifact values.
- `catalog/query.ts`: indexed helpers (`getTelemetryVariable`, `getTelemetryChildren`, `getTelemetrySources`, `getSourcesWithoutSemanticDefinition`).
- `catalog/validation.ts`: integrity checks and complete-catalog guardrails.
- `catalog/generated/`: generated catalog artifacts.
- `resolver/contracts.ts`: `CompiledTelemetryResolver`, `TelemetryFrameView`, resolved-value, and slot contracts.
- `resolver/compile.ts`: `compileTelemetryResolver` and graph build.
- `resolver/value.ts`, `resolver/readers.ts`, `resolver/plan.ts`, `resolver/frame-view.ts`: value coercion, source readers, plan models, frame cache.
- `resolver/versions.ts`: `TELEMETRY_RESOLVER_VERSION`, `TELEMETRY_PARSER_VERSIONS`.
- `derivations/contracts.ts`, `derivations/builtins.ts`: built-in derivation contracts and evaluator set.
- `replay/contracts.ts`, `replay/canonicalize.ts`: persisted replay payload and strict canonicalizer.
- `types.ts`, `version.ts`, `f1-2025.ts`, `kunos.ts`, `iracing.ts`: normalized packet, version identity, and parser-domain typings.

## Browser vs Node boundary
- Runtime modules are environment-neutral TypeScript; no DOM, `fetch`, or Node-specific globals.
- `compileTelemetryResolver` and frame readers stay environment-neutral; production use currently lives in `server/telemetry/replay.ts`, with resolver contracts covered by `test/telemetry/resolver`.
- Generator side effects live in `scripts/catalog/generate-telemetry-catalog.ts` (Bun/Node), which writes artifacts under `shared/telemetry/catalog/generated`.

## Dependency direction
- Upstream dependencies:
  - generator consumes source-of-truth inputs from `shared/telemetry/*`, `shared/racing/setups/*`, `shared/games/iracing/session-info/*`, and server game parsers (`server/games/.../parser.ts` and `server/games/iracing/normalizer.ts`).
  - built-in derivations use parser-independent semantic contracts only.
- Downstream dependencies:
  - `shared/telemetry/catalog/data.ts` and `replay/contracts.ts` are consumed by server and client telemetry code.
  - resolver modules feed replay writers, live display, map overlays, and validation helpers.
- Avoid cyclic use: app code must import from telemetry leaves, not re-export telemetry from domain folders.

## Add/extend safely
- To add or adjust semantic variables:
  1. update canonical source inputs (`shared/telemetry/*.ts`, `shared/racing/setups/catalog/*`, `shared/racing/setups/schema.ts`, `shared/games/iracing/session-info/*`, and server parser contracts as needed).
  2. run generator so provenance, source hashes, and mapping provenance stay consistent.
  3. add/adjust derivation registration in `derivations/builtins.ts` only when semantic-level computation is intentional.
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
Current generator inputs are enumerated in `generatedFrom`, including `shared/telemetry/types.ts`, `shared/telemetry/{f1-2025,kunos,iracing}.ts`, `shared/racing/setups/schema.ts`, every file under `shared/racing/setups/catalog/`, `shared/games/iracing/session-info/*`, recorded iRacing diagnostics, each registered game parser, and `server/games/iracing/normalizer.ts`.

Regeneration:
- `bun run telemetry:catalog` (write artifacts)
- `bun run telemetry:catalog:check` (verify artifacts match + determinism)
- optional compatibility mode: `bun scripts/catalog/generate-telemetry-catalog.ts --check --baseline <path-to-baseline-json>`

## Leaf imports (no barrel)
Use direct file imports only.

```ts
import { TELEMETRY_CATALOG } from "@shared/telemetry/catalog/data";
import { compileTelemetryResolver } from "@shared/telemetry/resolver/compile";
import { getTelemetryVariable } from "@shared/telemetry/catalog/query";
import { TELEMETRY_CATALOG_HASH } from "@shared/telemetry/catalog/data";
import type { ResolvedValue } from "@shared/telemetry/resolver/contracts";
import type { CanonicalTelemetryEnvelope } from "@shared/telemetry/replay/contracts";
```

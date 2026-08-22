# Telemetry catalog

Owns telemetry catalog generation and iRacing SessionInfo capture coverage.

## Commands

| Command                                               | Purpose                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `bun run telemetry:catalog`                           | Build checked-in JSON, TypeScript, Markdown, and matrix outputs.                                    |
| `bun run telemetry:catalog --check`                   | Rebuild in memory and fail when checked-in outputs differ.                                          |
| `bun run telemetry:catalog --repeat`                  | Build twice and fail on non-deterministic output. Combine with `--check` for baseline verification. |
| `bun run telemetry:catalog --check --baseline <path>` | Require reviews for direct-to-simplified mapping changes against baseline catalog.                  |

Generator entrypoint is `scripts/catalog/generate-telemetry-catalog.ts`; it exports catalog builder, artifact builder, source hashing, and compatibility review APIs. Generated artifacts remain checked in under `shared/telemetry/catalog/generated/`; this domain does not regenerate them during refactors.

`builder.ts` stores aggregate generator provenance once as `metadata.generator.sourceHash`. `metadata.sourceHashes` stores one hash per referenced mapping artifact; mappings carry only origin and artifact path, avoiding repeated hash churn in generated diffs.

## Dependency boundaries

- `model.ts` owns public model types, game IDs, source paths, repository-root paths, and output paths.
- `semantic-metadata.ts` owns semantic helper/category/description/tire metadata; `semantic-definitions-live.ts`, `semantic-definitions-competitor.ts`, and `semantic-definitions-extended.ts` hold contiguous definition chunks, composed in original insertion order by `semantic-definitions.ts`.
- `ast-discovery.ts` reads parser/type sources and performs Babel discovery without catalog rendering.
- `packet-mapping.ts` owns normalized packet/native mappings and group setup.
- `extension-field-mapping.ts` owns extension field grouping, normalization, and variable construction; `extension-metadata.ts` owns extension aliases, metadata, and unavailable-source records.
- `iracing-mapping.ts` owns iRacing SDK aliases and SessionInfo YAML mapping; `setup-link-mapping.ts` owns setup-file variables and derived/normalized links. `extension-mapping.ts` preserves current internal exports as an acyclic compatibility facade.
- `derived-projections.ts` owns sector and cross-source projection builders.
- `contract-inference.ts` owns canonical hashing, value types, dimensions, schemas, cardinality, and ranges.
- `contract-provenance.ts` owns mapping provenance and contract enrichment; `contract-enrichment.ts` remains thin compatibility facade preserving exports.
- `builder.ts` orchestrates source reads and assembly; `rendering.ts` owns artifact text and compatibility checks; `cli.ts` owns argument parsing.
- `iracing-session-info-capture.ts` only reads capture files and validates catalog coverage.

Helpers are side-effect-free except explicit source/artifact reads in orchestration, capture, and rendering modules. Source paths in generated provenance point to final `scripts/catalog/**` modules.

// Catalog mapping provenance and enrichment.

import {
  DERIVATION_VERSION,
  GAME_IDS,
  PARSER_FILES,
} from "./model";
import {
  cardinalityFor,
  contentHash,
  dimensionForUnit,
  ENUM_DOMAINS,
  rangeForUnit,
  valueTypeFor,
} from "./contract-inference";
import type {
  CatalogVariable,
  GameId,
  MappingProvenance,
  SourceVariable,
} from "./model";

export
function mappingArtifact(
  gameId: GameId,
  sources: readonly string[],
): Pick<MappingProvenance, "origin" | "artifact"> {
  if (
    sources.some(
      (source) =>
        source === "iRacing.SessionInfo" ||
        source.includes(".SessionInfo."),
    )
  ) {
    return {
      origin: "yaml",
      artifact: "shared/games/iracing/session-info/catalog.ts",
    };
  }
  if (sources.some((source) => source.includes(".SetupFile."))) {
    return { origin: "schema", artifact: "shared/racing/setups/schema.ts" };
  }
  if (
    sources.some((source) =>
      /^(RaceIQ\.|LiveSectorData\.|LapMeta\.)/.test(source),
    )
  ) {
    return {
      origin: "derivation",
      artifact: "scripts/catalog/derived-projections.ts",
    };
  }
  return { origin: "parser", artifact: PARSER_FILES[gameId] };
}

export function enrichCatalogContracts(
  variables: Map<string, CatalogVariable>,
  inventories: Record<GameId, SourceVariable[]>,
): void {
  const allSources = GAME_IDS.flatMap((gameId) => inventories[gameId]);
  for (const variable of variables.values()) {
    const sourceVariables = allSources.filter(
      (source) => source.semanticId === variable.id,
    );
    variable.valueType ??= valueTypeFor(variable, sourceVariables);
    variable.dimensions ??= dimensionForUnit(variable.canonicalUnit);
    const cardinality = cardinalityFor(variable, sourceVariables);
    variable.cardinality ??= cardinality.cardinality;
    variable.ordering ??= cardinality.ordering;
    variable.structuredSchema ??= cardinality.structuredSchema;
    if (variable.valueType === "enum") {
      variable.enumDomain ??= ENUM_DOMAINS[variable.id];
      if (!variable.enumDomain?.length) {
        throw new Error(`Missing authoritative enum domain for ${variable.id}`);
      }
    }
    variable.range ??= rangeForUnit(variable.canonicalUnit);
    variable.limitations ??= [];

    for (const gameId of GAME_IDS) {
      const mapping = variable.games[gameId];
      if (mapping.kind === "unavailable") continue;
      const sources = Array.isArray(mapping.sources)
        ? mapping.sources
        : Object.values(mapping.sources).flat();
      if (
        mapping.kind === "direct" &&
        mapping.nativeUnit !== variable.canonicalUnit
      ) {
        mapping.kind = "normalized";
        mapping.normalization ??=
          `convert ${mapping.nativeUnit} to ${variable.canonicalUnit}`;
      }
      if (mapping.kind === "normalized" && !mapping.normalization) {
        throw new Error(
          `Normalized telemetry mapping ${gameId}:${variable.id} requires normalization metadata`,
        );
      }
      const artifact = mappingArtifact(gameId, sources);
      mapping.provenance ??= {
        origin: mapping.kind === "simplified" ? "projection" : artifact.origin,
        artifact: artifact.artifact,
      };
      mapping.limitations ??=
        mapping.kind === "simplified"
          ? [
              "Reduced-detail representation; unsuitable when direct semantic fidelity is required.",
            ]
          : [];
      if (mapping.kind !== "direct") {
        const execution = {
          kind:
            mapping.kind === "normalized"
              ? ("conversion" as const)
              : mapping.kind === "derived"
                ? ("derivation" as const)
                : ("simplification" as const),
          id: `${gameId}:${variable.id}:${mapping.kind}`,
          version: DERIVATION_VERSION,
          deterministic: true,
          inputs: sources,
          missingDataPolicy:
            /available|fallback|prefer/i.test(mapping.normalization ?? "")
              ? ("drop-missing" as const)
              : ("require-all" as const),
        };
        mapping.execution ??= {
          ...execution,
          codeHash: contentHash({
            ...execution,
            normalization: mapping.normalization,
          }),
        };
      }
    }
  }
}

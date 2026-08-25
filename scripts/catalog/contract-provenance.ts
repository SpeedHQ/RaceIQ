// Catalog mapping provenance and enrichment.

import {
  DERIVATION_VERSION,
  GAME_IDS,
  PARSER_FILES,
} from "./model";
import {
  cardinalityFor,
  contentHash,
  compareCatalogStrings,
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
    if (variable.valueType === "structured") {
      delete variable.enumDomain;
    }
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
          declaredInputs: sources,
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

function dimensionsKey(dimensions: readonly string[]): string {
  return [...dimensions].sort().join("|");
}

function conceptKey(id: string): string {
  let represented = id;
  if (id.startsWith("fuel.")) {
    const representation = id.slice("fuel.".length);
    if (representation === "fuel" || representation === "fuel-liters") {
      represented = "fuel.remaining-volume";
    } else if (representation === "fuel-percent") {
      represented = "fuel.remaining-percent";
    } else if (representation === "fuel-capacity") {
      represented = "fuel.capacity";
    }
  }
  return represented
    .toLowerCase()
    .replace(/player-car-sl/g, "shift-light")
    .replace(/(^|[._-])sl(?=([._-]|$))/g, "$1shift-light")
    .replace(/(^|[._-])(remain|left)(?=([._-]|$))/g, "$1remaining")
    .split(/[._-]+/)
    .map((token) => (token === "engine0" ? "engine" : token))
    .filter((token) => token !== "current" && token !== "official")
    .join("-");
}

function intentionalDuplicate(left: string, right: string): boolean {
  const pair = [left, right].sort().join("|");
  return (
    pair === "engine.current-engine-rpm|engine.engine0-rpm" ||
    pair === "timing.official-track-length|timing.track-length"
  );
}

function recognizedDimensions(unit: string): readonly string[] | undefined {
  if (unit.trim().toLowerCase() === "value-with-unit") return undefined;
  const dimensions = dimensionForUnit(unit);
  return dimensions.some((dimension) => dimension.startsWith("unit:"))
    ? undefined
    : dimensions;
}

function allowedDimensionChange(
  variable: CatalogVariable,
  gameId: GameId,
  nativeDimensions: readonly string[],
  canonicalDimensions: readonly string[],
  normalization: string | undefined,
): boolean {
  if (
    gameId === "iracing" &&
    variable.id === "inputs.steering" &&
    dimensionsKey(nativeDimensions) === "angle" &&
    dimensionsKey(canonicalDimensions) === "dimensionless"
  ) {
    return true;
  }
  return (
    /lap.*time|time.*lap/.test(variable.id) &&
    dimensionsKey(nativeDimensions) === "dimensionless" &&
    dimensionsKey(canonicalDimensions) === "time" &&
    /parse|formatted|text/i.test(normalization ?? "")
  );
}

export function assertCatalogSemanticQuality(
  variables: ReadonlyMap<string, CatalogVariable>,
): void {
  const ordered = [...variables.values()].sort((left, right) =>
    compareCatalogStrings(left.id, right.id),
  );
  const concepts = new Map<string, CatalogVariable>();
  const wheelFamilies = new Map<string, Set<string>>();

  for (const variable of ordered) {
    if (/(?:-ms|-in-ms|-temp-c)$/.test(variable.id)) {
      throw new Error(
        `Representation suffix is forbidden in semantic ID ${variable.id}; normalize the canonical unit instead.`,
      );
    }

    const dimensions = variable.dimensions ?? dimensionForUnit(variable.canonicalUnit);
    const concept = `${conceptKey(variable.id)}:${dimensionsKey(dimensions)}`;
    const existing = concepts.get(concept);
    if (
      existing &&
      !intentionalDuplicate(existing.id, variable.id)
    ) {
      throw new Error(
        `Duplicate telemetry concept ${existing.id} and ${variable.id} share dimensions ${dimensionsKey(dimensions)}.`,
      );
    }
    concepts.set(concept, variable);

    const wheel = variable.id.match(/^(.*)-(fl|fr|rl|rr)$/);
    if (wheel && variable.shape === "scalar") {
      const corners = wheelFamilies.get(wheel[1]) ?? new Set<string>();
      corners.add(wheel[2]);
      wheelFamilies.set(wheel[1], corners);
    }

    const canonicalDimensions =
      variable.dimensions ?? dimensionForUnit(variable.canonicalUnit);
    const canonicalRecognized = canonicalDimensions.some((dimension) =>
      dimension.startsWith("unit:"),
    )
      ? undefined
      : canonicalDimensions;
    for (const gameId of GAME_IDS) {
      const mapping = variable.games[gameId];
      if (mapping.kind === "unavailable") continue;
      if (mapping.kind === "derived") {
        if (
          mapping.execution?.kind !== "derivation" ||
          mapping.execution.declaredInputs.length === 0
        ) {
          throw new Error(
            `Derived telemetry mapping ${gameId}:${variable.id} must declare derivation inputs.`,
          );
        }
        continue;
      }
      const nativeDimensions = recognizedDimensions(mapping.nativeUnit);
      if (!nativeDimensions || !canonicalRecognized) continue;
      if (
        dimensionsKey(nativeDimensions) !==
          dimensionsKey(canonicalRecognized) &&
        !(
          mapping.kind === "normalized" &&
          allowedDimensionChange(
            variable,
            gameId,
            nativeDimensions,
            canonicalRecognized,
            mapping.normalization,
          )
        )
      ) {
        throw new Error(
          `Telemetry mapping ${gameId}:${variable.id} conflicts: native ${mapping.nativeUnit} has dimensions ${dimensionsKey(nativeDimensions)}, canonical ${variable.canonicalUnit} has dimensions ${dimensionsKey(canonicalRecognized)}.`,
        );
      }
    }
  }

  for (const [stem, corners] of [...wheelFamilies].sort(([left], [right]) =>
    compareCatalogStrings(left, right),
  )) {
    if (corners.size >= 3) {
      throw new Error(
        `Scalar wheel family ${stem} defines ${[...corners].sort().join(", ")}; aggregate FL/FR/RL/RR into one per-wheel semantic.`,
      );
    }
  }
}

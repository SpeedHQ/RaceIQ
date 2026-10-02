import { KNOWN_GAME_IDS, type GameId } from "../../games/ids";
import type { TelemetryPacket } from "../types";
import type {
  TelemetryCatalogData,
  TelemetryValueCardinality,
} from "./contracts";
import {
  TELEMETRY_CATALOG,
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "./data";

function hasFiniteEnumDomain(domain: readonly string[] | undefined): boolean {
  if (!domain?.length) return false;
  const normalized = domain.map((value) => value.trim().toLowerCase());
  return (
    normalized.every(
      (value) => value.length > 0 && !/^(?:\*|any|unknown)$/.test(value),
    ) && new Set(normalized).size === normalized.length
  );
}

function validCardinality(cardinality: TelemetryValueCardinality): boolean {
  return cardinality.kind === "scalar"
    ? true
    : cardinality.kind === "fixed"
      ? Number.isInteger(cardinality.count) && cardinality.count > 0
      : Number.isInteger(cardinality.min) &&
        cardinality.min >= 0 &&
        (cardinality.max === undefined ||
          (Number.isInteger(cardinality.max) &&
            cardinality.max >= cardinality.min));
}

function sameCardinality(
  left: TelemetryValueCardinality,
  right: TelemetryValueCardinality,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "scalar" ||
      (left.kind === "fixed" &&
        right.kind === "fixed" &&
        left.count === right.count) ||
      (left.kind === "variable" &&
        right.kind === "variable" &&
        left.min === right.min &&
        left.max === right.max))
  );
}

export function assertTelemetryCatalogComplete(
  catalog: TelemetryCatalogData = TELEMETRY_CATALOG,
): void {
  if (catalog.format !== "raceiq-semantic-telemetry-catalog-v7") {
    throw new Error(`Unexpected catalog format ${catalog.format}`);
  }
  const metadata = catalog.metadata;
  if (
    !metadata.catalogVersion ||
    !metadata.schemaVersion ||
    !metadata.generator.name ||
    !metadata.generator.version ||
    !/^[a-f0-9]{64}$/.test(metadata.generator.sourceHash) ||
    !metadata.sourceHashes ||
    Object.keys(metadata.sourceHashes).length === 0 ||
    Object.values(metadata.sourceHashes).some(
      (sourceHash) => !/^[a-f0-9]{64}$/.test(sourceHash),
    ) ||
    !/^[a-f0-9]{64}$/.test(metadata.contentHash)
  ) {
    throw new Error("Telemetry catalog metadata is incomplete");
  }
  if (
    metadata.catalogVersion !== TELEMETRY_CATALOG_VERSION ||
    metadata.schemaVersion !== TELEMETRY_CATALOG_SCHEMA_VERSION ||
    metadata.contentHash !== TELEMETRY_CATALOG_HASH
  ) {
    throw new Error("Generated telemetry catalog constants do not match metadata");
  }
  const normalizedFields = new Set(
    catalog.variables.flatMap((variable) => variable.packetFields ?? []),
  );
  const sourcePathsByGame = Object.fromEntries(
    KNOWN_GAME_IDS.map((gameId) => [
      gameId,
      new Set(catalog.sources[gameId].map((source) => source.path)),
    ]),
  ) as Record<GameId, Set<string>>;
  const groupsById = new Map(catalog.groups.map((group) => [group.id, group]));
  const variablesById = new Map(
    catalog.variables.map((variable) => [variable.id, variable]),
  );

  const nodeIds = new Set<string>();
  for (const group of catalog.groups) {
    if (nodeIds.has(group.id)) throw new Error(`Duplicate node ${group.id}`);
    nodeIds.add(group.id);
    if (!group.label || !group.description) {
      throw new Error(`${group.id} must declare label and description`);
    }
  }
  for (const variable of catalog.variables) {
    if (nodeIds.has(variable.id)) throw new Error(`Duplicate node ${variable.id}`);
    nodeIds.add(variable.id);
    if (
      !variable.label ||
      !variable.description ||
      !variable.canonicalUnit
    ) {
      throw new Error(`${variable.id} must declare label, unit, and description`);
    }
    if (
      !variable.valueType ||
      variable.dimensions.length === 0 ||
      !variable.cardinality ||
      !Array.isArray(variable.limitations)
    ) {
      throw new Error(`${variable.id} has incomplete value contract`);
    }
    const structuredSchema = variable.structuredSchema;
    if (
      (variable.shape === "structured") !==
        (variable.valueType === "structured") ||
      (variable.shape === "scalar" &&
        variable.cardinality.kind !== "scalar") ||
      (variable.shape === "per-wheel" &&
        (variable.cardinality.kind !== "fixed" ||
          variable.cardinality.count !== 4 ||
          variable.ordering?.join(",") !== "FL,FR,RL,RR")) ||
      (variable.shape === "vector" &&
        (variable.cardinality.kind !== "fixed" ||
          variable.cardinality.count !== 3 ||
          variable.ordering?.join(",") !== "x,y,z")) ||
      (variable.shape === "array" &&
        (variable.cardinality.kind !== "variable" ||
          !variable.ordering?.length)) ||
      (variable.shape === "structured" &&
        (!variable.ordering?.length ||
          !structuredSchema?.indices.length ||
          !structuredSchema.fields.length ||
          !sameCardinality(
            variable.cardinality,
            structuredSchema.indices[0].cardinality,
          ))) ||
      (variable.shape !== "structured" && structuredSchema)
    ) {
      throw new Error(`${variable.id} has incompatible cardinality or ordering`);
    }
    if (!validCardinality(variable.cardinality)) {
      throw new Error(`${variable.id} has invalid cardinality`);
    }
    if (structuredSchema) {
      const indexIds = new Set<string>();
      for (const index of structuredSchema.indices) {
        if (
          !index.id ||
          indexIds.has(index.id) ||
          !validCardinality(index.cardinality)
        ) {
          throw new Error(`${variable.id} has invalid structured index schema`);
        }
        indexIds.add(index.id);
      }
      const fieldIds = new Set<string>();
      for (const field of structuredSchema.fields) {
        if (
          !field.id ||
          fieldIds.has(field.id) ||
          field.dimensions.length === 0 ||
          (field.valueType === "enum" &&
            !hasFiniteEnumDomain(field.enumDomain)) ||
          (field.valueType !== "enum" && field.enumDomain)
        ) {
          throw new Error(`${variable.id} has invalid structured field schema`);
        }
        fieldIds.add(field.id);
      }
    }
    if (
      (variable.valueType === "enum" &&
        !hasFiniteEnumDomain(variable.enumDomain)) ||
      (variable.valueType !== "enum" && variable.enumDomain)
    ) {
      throw new Error(`${variable.id} has invalid enum domain`);
    }
    if (
      variable.range &&
      (!Number.isFinite(variable.range.min) ||
        !Number.isFinite(variable.range.max) ||
        variable.range.min > variable.range.max)
    ) {
      throw new Error(`${variable.id} has invalid range`);
    }
    const parent = groupsById.get(variable.parentId);
    if (!parent?.children.includes(variable.id)) {
      throw new Error(`${variable.id} has invalid parent ${variable.parentId}`);
    }
    for (const gameId of KNOWN_GAME_IDS) {
      const mapping = variable.games[gameId];
      if (!mapping) {
        throw new Error(`${variable.id} missing ${gameId} mapping`);
      }
      if (mapping.kind === "unavailable") continue;
      const sources = Array.isArray(mapping.sources)
        ? mapping.sources
        : Object.values(mapping.sources).flat();
      if (sources.length === 0 || sources.some((source) => !source)) {
        throw new Error(`${variable.id} has empty ${gameId} source mapping`);
      }
      if (
        (mapping.kind === "normalized" ||
          mapping.kind === "derived" ||
          mapping.kind === "simplified") &&
        !mapping.normalization
      ) {
        throw new Error(
          `${variable.id} ${gameId} ${mapping.kind} mapping lacks normalization`,
        );
      }
      if (
        !mapping.provenance.artifact ||
        !mapping.provenance.origin ||
        !metadata.sourceHashes[mapping.provenance.artifact] ||
        !Array.isArray(mapping.limitations)
      ) {
        throw new Error(`${variable.id} ${gameId} lacks mapping provenance`);
      }
      const compatibilityReview = mapping.compatibilityReview;
      if (
        compatibilityReview !== undefined &&
        (!compatibilityReview ||
          typeof compatibilityReview.id !== "string" ||
          !compatibilityReview.id.trim() ||
          typeof compatibilityReview.rationale !== "string" ||
          !compatibilityReview.rationale.trim())
      ) {
        throw new Error(
          `${variable.id} ${gameId} has invalid compatibility review`,
        );
      }
      if (
        mapping.kind === "direct" &&
        mapping.nativeUnit !== variable.canonicalUnit
      ) {
        throw new Error(
          `${variable.id} ${gameId} direct mapping requires unit conversion`,
        );
      }
      if (mapping.kind === "direct" && mapping.execution) {
        throw new Error(`${variable.id} ${gameId} direct mapping has execution`);
      }
      if (mapping.kind !== "direct") {
        const execution = mapping.execution;
        if (
          !execution?.id ||
          !execution.version ||
          !execution.deterministic ||
          !/^[a-f0-9]{64}$/.test(execution.codeHash) ||
          execution.declaredInputs.length === 0 ||
          execution.declaredInputs.some((input) => !sources.includes(input))
        ) {
          throw new Error(
            `${variable.id} ${gameId} lacks executable mapping identity`,
          );
        }
        if (
          (mapping.kind === "normalized" &&
            execution.kind !== "conversion") ||
          (mapping.kind === "simplified" &&
            (execution.kind !== "simplification" ||
              mapping.limitations.length === 0 ||
              mapping.provenance.origin !== "projection")) ||
          (mapping.kind === "derived" &&
            execution.kind !== "derivation")
        ) {
          throw new Error(
            `${variable.id} ${gameId} has incompatible execution contract`,
          );
        }
        for (const input of execution.declaredInputs) {
          if (
            input.startsWith("TelemetryPacket.") &&
            !normalizedFields.has(
              input.slice("TelemetryPacket.".length) as keyof TelemetryPacket,
            )
          ) {
            throw new Error(
              `${variable.id} ${gameId} references missing packet input ${input}`,
            );
          }
          const extensionInput =
            /^(?:f1|acc|iracing|lmu)\./.test(input) ? input : undefined;
          const iracingInput =
            gameId === "iracing" && input.startsWith("iRacing.")
              ? input.slice("iRacing.".length)
              : undefined;
          const cataloguedIRacingInput =
            iracingInput &&
            (!iracingInput.startsWith("SessionInfo.") ||
              /^[A-Z]/.test(iracingInput.slice("SessionInfo.".length)))
              ? iracingInput
              : undefined;
          if (
            (extensionInput &&
              !sourcePathsByGame[gameId].has(extensionInput)) ||
            (cataloguedIRacingInput &&
              !sourcePathsByGame.iracing.has(cataloguedIRacingInput))
          ) {
            throw new Error(
              `${variable.id} ${gameId} references missing source input ${input}`,
            );
          }
        }
      }
      if (
        sources.some((source) => source.startsWith("RaceIQ.ParserState."))
      ) {
        throw new Error(
          `${variable.id} ${gameId} still uses broad parser-state fallback`,
        );
      }
    }
  }

  for (const group of catalog.groups) {
    if (group.parentId) {
      const parent = groupsById.get(group.parentId);
      if (!parent?.children.includes(group.id)) {
        throw new Error(`${group.id} has invalid parent ${group.parentId}`);
      }
    }
    for (const childId of group.children) {
      if (!nodeIds.has(childId)) {
        throw new Error(`${group.id} references missing child ${childId}`);
      }
    }
  }

  for (const gameId of KNOWN_GAME_IDS) {
    const sources = catalog.sources[gameId];
    const coverage = catalog.coverage.sourceCounts[gameId];
    const expected = coverage.total;
    if (sources.length !== expected) {
      throw new Error(
        `${gameId} source coverage expected ${expected}, found ${sources.length}`,
      );
    }
    for (const sourceKind of [
      "packet",
      "extension",
      "sdk",
      "yaml",
      "setup",
    ] as const) {
      const actual = sources.filter(
        (source) => source.sourceKind === sourceKind,
      ).length;
      if (actual !== coverage[sourceKind]) {
        throw new Error(
          `${gameId} ${sourceKind} coverage expected ${coverage[sourceKind]}, found ${actual}`,
        );
      }
    }
    const recorded = sources.filter(
      (source) => source.recordedByRaceIQ,
    ).length;
    if (recorded !== coverage.recorded) {
      throw new Error(
        `${gameId} recorded coverage expected ${coverage.recorded}, found ${recorded}`,
      );
    }
    for (const source of sources) {
      if (
        !source.path ||
        !source.unit ||
        !source.description ||
        !source.retention ||
        !variablesById.has(source.semanticId)
      ) {
        throw new Error(`${gameId} source ${source.path} is not fully linked`);
      }
      if (
        (source.retention === "exact" && !source.recordedByRaceIQ) ||
        (source.retention === "not-recorded" && source.recordedByRaceIQ)
      ) {
        throw new Error(
          `${gameId} source ${source.path} has inconsistent retention`,
        );
      }
    }
  }

  if (normalizedFields.size !== catalog.coverage.normalizedPacketFields) {
    throw new Error(
      `Normalized field coverage expected ${catalog.coverage.normalizedPacketFields}, found ${normalizedFields.size}`,
    );
  }
}

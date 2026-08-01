import {
  TELEMETRY_CATALOG_GENERATED,
  TELEMETRY_CATALOG_HASH as GENERATED_TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION as GENERATED_TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION as GENERATED_TELEMETRY_CATALOG_VERSION,
} from "./telemetry-catalog.generated";
import { KNOWN_GAME_IDS, type GameId, type TelemetryPacket } from "./types";

export type TelemetryLinkKind =
  | "direct"
  | "normalized"
  | "derived"
  | "simplified"
  | "unavailable";

export type TelemetryValueType =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "structured";

export type TelemetryValueCardinality =
  | { kind: "scalar" }
  | { kind: "fixed"; count: number }
  | { kind: "variable"; min: number; max?: number };

export interface TelemetryStructuredIndexSchema {
  id: string;
  cardinality: TelemetryValueCardinality;
  ordering: "numeric-ascending" | "source-order" | "semantic-order";
}

export interface TelemetryStructuredFieldSchema {
  id: string;
  valueType: Exclude<TelemetryValueType, "structured">;
  dimensions: readonly string[];
  enumDomain?: readonly string[];
}

export interface TelemetryStructuredValueSchema {
  indices: readonly TelemetryStructuredIndexSchema[];
  fields: readonly TelemetryStructuredFieldSchema[];
}

export interface TelemetryMappingExecution {
  kind: "conversion" | "derivation" | "simplification";
  id: string;
  version: string;
  codeHash: string;
  deterministic: boolean;
  declaredInputs: readonly string[];
  missingDataPolicy: "propagate-missing" | "drop-missing" | "require-all";
}

export interface TelemetryMappingProvenance {
  origin: "parser" | "projection" | "schema" | "yaml" | "derivation";
  artifact: string;
  commit: string;
}

export interface TelemetryCompatibilityReview {
  id: string;
  rationale: string;
}

export interface AvailableTelemetryLink {
  kind: Exclude<TelemetryLinkKind, "unavailable">;
  nativeUnit: string;
  sources: readonly string[] | Record<string, readonly string[]>;
  freshness: "continuous" | "pit-snapshot" | "session-update" | "static";
  normalization?: string;
  description: string;
  limitations: readonly string[];
  provenance: TelemetryMappingProvenance;
  execution?: TelemetryMappingExecution;
  compatibilityReview?: TelemetryCompatibilityReview;
}

export interface UnavailableTelemetryLink {
  kind: "unavailable";
  reason:
    | "source-not-provided"
    | "parser-placeholder"
    | "source-not-populated"
    | "not-applicable";
  description: string;
}

export type TelemetryGameLink =
  | AvailableTelemetryLink
  | UnavailableTelemetryLink;

export interface TelemetryCatalogGroup {
  id: string;
  label: string;
  description: string;
  parentId?: string;
  canonicalUnit?: string;
  children: readonly string[];
}

export interface TelemetryVariableDefinition {
  id: string;
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  valueType: TelemetryValueType;
  dimensions: readonly string[];
  cardinality: TelemetryValueCardinality;
  ordering?: readonly string[];
  range?: { min: number; max: number };
  enumDomain?: readonly string[];
  structuredSchema?: TelemetryStructuredValueSchema;
  limitations: readonly string[];
  shape: "scalar" | "per-wheel" | "vector" | "array" | "structured";
  packetFields?: readonly (keyof TelemetryPacket)[];
  games: Record<GameId, TelemetryGameLink>;
}

export interface TelemetrySourceVariable {
  path: string;
  label: string;
  unit: string;
  dataType?: string;
  count?: number;
  description: string;
  semanticId: string;
  sourceKind: "packet" | "extension" | "sdk" | "yaml" | "setup";
  recordedByRaceIQ: boolean;
  retention: "exact" | "normalized" | "not-recorded";
}

export interface TelemetrySourceCoverage {
  total: number;
  packet: number;
  extension: number;
  sdk: number;
  yaml: number;
  setup: number;
  recorded: number;
}

export interface TelemetryCatalogMetadata {
  catalogVersion: string;
  schemaVersion: string;
  generator: {
    name: string;
    version: string;
    commit: string;
  };
  generatedAt: string;
  contentHash: string;
}

export interface TelemetryCatalogData {
  format: "raceiq-semantic-telemetry-catalog-v6";
  metadata: TelemetryCatalogMetadata;
  generatedFrom: readonly string[];
  groups: readonly TelemetryCatalogGroup[];
  variables: readonly TelemetryVariableDefinition[];
  sources: Record<GameId, readonly TelemetrySourceVariable[]>;
  coverage: {
    normalizedPacketFields: number;
    semanticVariables: number;
    sourceCounts: Record<GameId, TelemetrySourceCoverage>;
  };
}

/**
 * Central telemetry-first catalog. Generated from normalized packet types,
 * every registered parser output, parser-specific extension interfaces,
 * captured iRacing SDK variable table, and known SessionInfo YAML schema.
 */
export const TELEMETRY_CATALOG =
  TELEMETRY_CATALOG_GENERATED as unknown as TelemetryCatalogData;

export const TELEMETRY_CATALOG_VERSION =
  GENERATED_TELEMETRY_CATALOG_VERSION;
export const TELEMETRY_CATALOG_SCHEMA_VERSION =
  GENERATED_TELEMETRY_CATALOG_SCHEMA_VERSION;
export const TELEMETRY_CATALOG_HASH = GENERATED_TELEMETRY_CATALOG_HASH;

const groupsById = new Map(
  TELEMETRY_CATALOG.groups.map((group) => [group.id, group]),
);
const variablesById = new Map(
  TELEMETRY_CATALOG.variables.map((variable) => [variable.id, variable]),
);

export function getTelemetryVariable(
  variableId: string,
): TelemetryVariableDefinition {
  const variable = variablesById.get(variableId);
  if (!variable) throw new Error(`Unknown telemetry variable ${variableId}`);
  return variable;
}

export function isTelemetryEnumValue(
  variableId: string,
  value: string | number,
): boolean {
  const variable = getTelemetryVariable(variableId);
  if (variable.valueType !== "enum" || !variable.enumDomain) return false;
  const normalized = String(value).trim().toLowerCase();
  return variable.enumDomain.some(
    (candidate) => candidate.toLowerCase() === normalized,
  );
}

export function getTelemetryNode(
  nodeId: string,
): TelemetryCatalogGroup | TelemetryVariableDefinition {
  const node = groupsById.get(nodeId) ?? variablesById.get(nodeId);
  if (!node) throw new Error(`Unknown telemetry catalog node ${nodeId}`);
  return node;
}

export function getTelemetryChildren(
  groupId: string,
): (TelemetryCatalogGroup | TelemetryVariableDefinition)[] {
  const group = groupsById.get(groupId);
  if (!group) return [];
  return group.children.map(getTelemetryNode);
}

export function getTelemetrySources(
  gameId: GameId,
): readonly TelemetrySourceVariable[] {
  return TELEMETRY_CATALOG.sources[gameId];
}

export function getLinkedSourceNames(gameId: GameId): Set<string> {
  const linked = new Set<string>();
  for (const variable of TELEMETRY_CATALOG.variables) {
    const mapping = variable.games[gameId];
    if (mapping.kind === "unavailable") continue;
    const groups = Array.isArray(mapping.sources)
      ? [mapping.sources]
      : Object.values(mapping.sources);
    for (const sources of groups) {
      for (const source of sources) linked.add(source);
    }
  }
  return linked;
}

export function getSourcesWithoutSemanticDefinition(
  gameId: GameId,
): TelemetrySourceVariable[] {
  return TELEMETRY_CATALOG.sources[gameId].filter(
    (source) => !variablesById.has(source.semanticId),
  );
}

export const IRACING_TELEMETRY_SOURCE_VARIABLES =
  TELEMETRY_CATALOG.sources.iracing.filter(
    (source) => source.sourceKind === "sdk",
  );

export const IRACING_SESSION_INFO_SOURCE_VARIABLES =
  TELEMETRY_CATALOG.sources.iracing.filter(
    (source) => source.sourceKind === "yaml",
  );

export function getIRacingSdkSourcesWithoutSemanticDefinition(): TelemetrySourceVariable[] {
  return getSourcesWithoutSemanticDefinition("iracing").filter(
    (source) => source.sourceKind === "sdk",
  );
}

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

export function assertTelemetryCatalogComplete(): void {
  if (TELEMETRY_CATALOG.format !== "raceiq-semantic-telemetry-catalog-v6") {
    throw new Error(`Unexpected catalog format ${TELEMETRY_CATALOG.format}`);
  }
  const metadata = TELEMETRY_CATALOG.metadata;
  if (
    !metadata.catalogVersion ||
    !metadata.schemaVersion ||
    !metadata.generator.name ||
    !metadata.generator.version ||
    !/^[a-f0-9]{64}$/.test(metadata.generator.commit) ||
    !/^[a-f0-9]{64}$/.test(metadata.contentHash) ||
    Number.isNaN(Date.parse(metadata.generatedAt))
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
    TELEMETRY_CATALOG.variables.flatMap(
      (variable) => variable.packetFields ?? [],
    ),
  );
  const sourcePathsByGame = Object.fromEntries(
    KNOWN_GAME_IDS.map((gameId) => [
      gameId,
      new Set(TELEMETRY_CATALOG.sources[gameId].map((source) => source.path)),
    ]),
  ) as Record<GameId, Set<string>>;

  const nodeIds = new Set<string>();
  for (const group of TELEMETRY_CATALOG.groups) {
    if (nodeIds.has(group.id)) throw new Error(`Duplicate node ${group.id}`);
    nodeIds.add(group.id);
    if (!group.label || !group.description) {
      throw new Error(`${group.id} must declare label and description`);
    }
  }
  for (const variable of TELEMETRY_CATALOG.variables) {
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
    if (!parent || !parent.children.includes(variable.id)) {
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
        !/^[a-f0-9]{64}$/.test(mapping.provenance.commit) ||
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
          !execution ||
          !execution.id ||
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
            /^(?:f1|acc|iracing)\./.test(input) ? input : undefined;
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

  for (const group of TELEMETRY_CATALOG.groups) {
    if (group.parentId) {
      const parent = groupsById.get(group.parentId);
      if (!parent || !parent.children.includes(group.id)) {
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
    const sources = TELEMETRY_CATALOG.sources[gameId];
    const coverage = TELEMETRY_CATALOG.coverage.sourceCounts[gameId];
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

  if (
    normalizedFields.size !==
    TELEMETRY_CATALOG.coverage.normalizedPacketFields
  ) {
    throw new Error(
      `Normalized field coverage expected ${TELEMETRY_CATALOG.coverage.normalizedPacketFields}, found ${normalizedFields.size}`,
    );
  }
}

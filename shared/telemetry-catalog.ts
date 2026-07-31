import catalogJson from "./telemetry-catalog.generated.json";
import { KNOWN_GAME_IDS, type GameId, type TelemetryPacket } from "./types";

export type TelemetryLinkKind =
  | "direct"
  | "derived"
  | "simplified"
  | "unavailable";

export interface AvailableTelemetryLink {
  kind: Exclude<TelemetryLinkKind, "unavailable">;
  nativeUnit: string;
  sources: readonly string[] | Record<string, readonly string[]>;
  freshness: "continuous" | "pit-snapshot" | "session-update" | "static";
  normalization?: string;
  description: string;
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

export interface TelemetryCatalogData {
  format: "raceiq-semantic-telemetry-catalog-v5";
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
  catalogJson as unknown as TelemetryCatalogData;

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

export function assertTelemetryCatalogComplete(): void {
  if (TELEMETRY_CATALOG.format !== "raceiq-semantic-telemetry-catalog-v5") {
    throw new Error(`Unexpected catalog format ${TELEMETRY_CATALOG.format}`);
  }

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
        (mapping.kind === "derived" || mapping.kind === "simplified") &&
        !mapping.normalization
      ) {
        throw new Error(
          `${variable.id} ${gameId} ${mapping.kind} mapping lacks normalization`,
        );
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

  const normalizedFields = new Set(
    TELEMETRY_CATALOG.variables.flatMap(
      (variable) => variable.packetFields ?? [],
    ),
  );
  if (
    normalizedFields.size !==
    TELEMETRY_CATALOG.coverage.normalizedPacketFields
  ) {
    throw new Error(
      `Normalized field coverage expected ${TELEMETRY_CATALOG.coverage.normalizedPacketFields}, found ${normalizedFields.size}`,
    );
  }
}

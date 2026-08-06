import type { GameId } from "../../games/ids";
import type {
  TelemetryCatalogGroup,
  TelemetrySourceVariable,
  TelemetryVariableDefinition,
} from "./contracts";
import { TELEMETRY_CATALOG } from "./data";

export const groupsById = new Map<string, TelemetryCatalogGroup>(
  TELEMETRY_CATALOG.groups.map((group) => [group.id, group]),
);
export const variablesById = new Map<string, TelemetryVariableDefinition>(
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

export function getTelemetrySources<G extends GameId>(
  gameId: G,
): readonly TelemetrySourceVariable<G>[] {
  return TELEMETRY_CATALOG.sources[gameId];
}

export function getSourcesWithoutSemanticDefinition<G extends GameId>(
  gameId: G,
): TelemetrySourceVariable<G>[] {
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

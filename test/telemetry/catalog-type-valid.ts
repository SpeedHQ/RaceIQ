import type {
  TelemetryCatalogGroup,
  TelemetrySourceVariable,
  TelemetryVariableDefinition,
} from "../../shared/telemetry/catalog/contracts";
import type {
  TelemetryGroupId,
  TelemetrySourcePath,
  TelemetryVariableId,
} from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";

const groupId: TelemetryGroupId = "brakes";
const variableId: TelemetryVariableId = "engine.current-engine-rpm";
const accPath: TelemetrySourcePath<"acc"> = "TelemetryPacket.CurrentEngineRpm";

const group: Pick<TelemetryCatalogGroup, "id" | "children"> = {
  id: groupId,
  children: [variableId],
};

const variable: Pick<TelemetryVariableDefinition, "id" | "parentId"> = {
  id: variableId,
  parentId: groupId,
};

const source: Pick<TelemetrySourceVariable<"acc">, "path" | "semanticId"> = {
  path: accPath,
  semanticId: variableId,
};

void group;
void variable;
void source;

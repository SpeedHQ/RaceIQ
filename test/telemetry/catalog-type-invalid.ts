import type {
  TelemetryCatalogGroup,
  TelemetrySourceVariable,
  TelemetryVariableDefinition,
} from "../../shared/telemetry/catalog/contracts";
import type { TelemetrySourcePath } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";

// @ts-expect-error Unknown group IDs must be rejected.
const unknownGroup: Pick<TelemetryCatalogGroup, "id"> = { id: "not-a-catalog-group" };
// @ts-expect-error Unknown variable IDs must be rejected.
const unknownVariable: Pick<TelemetryVariableDefinition, "id"> = { id: "not-a-catalog-variable" };
// @ts-expect-error Unknown parent group IDs must be rejected.
const unknownParent: Pick<TelemetryVariableDefinition, "parentId"> = { parentId: "not-a-catalog-group" };
// @ts-expect-error Unknown semantic IDs must be rejected.
const unknownSemantic: Pick<TelemetrySourceVariable, "semanticId"> = { semanticId: "not-a-catalog-variable" };
// @ts-expect-error ACC paths must not be accepted as iRacing paths.
const wrongGamePath: TelemetrySourcePath<"iracing"> = "ACC.Physics.rpms";

void unknownGroup;
void unknownVariable;
void unknownParent;
void unknownSemantic;
void wrongGamePath;

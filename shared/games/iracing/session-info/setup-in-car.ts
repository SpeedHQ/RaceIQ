import type { IRacingSessionInfoCatalogField } from "./contracts";
import { setupField, type SetupLeaf } from "./setup-builders";

const IN_CAR_DIAL_LEAVES: readonly SetupLeaf[] = [
  {
    field: "BrakePressureBias",
    label: "brake bias",
    unit: "value-with-unit",
    description: "In-car brake-pressure bias",
    semanticId: "setup.brakes.bias",
  },
  {
    field: "AbsSetting",
    label: "ABS",
    unit: "level",
    description: "Configured ABS level",
    semanticId: "setup.electronics.abs",
  },
  {
    field: "TractionControlSetting",
    label: "traction control",
    unit: "level",
    description: "Configured traction-control level",
    semanticId: "setup.electronics.traction-control",
  },
  {
    field: "EngineMapSetting",
    label: "engine map",
    unit: "level",
    description: "Configured engine-map level",
    semanticId: "setup.electronics.engine-map",
  },
  {
    field: "ThrottleShapeSetting",
    label: "throttle shape",
    unit: "level",
    description: "Configured throttle-response shape",
    semanticId: "setup.electronics.throttle-shape",
  },
  {
    field: "DisplayPage",
    label: "display page",
    unit: "index",
    description: "Configured in-car display page",
    semanticId: "setup.electronics.display-page",
  },
  {
    field: "CrossWeight",
    label: "cross weight",
    unit: "value-with-unit",
    description: "Diagonal cross-weight percentage",
    semanticId: "setup.weight.cross-weight",
  },
];

export const IRACING_IN_CAR_SETUP_FIELDS: readonly IRacingSessionInfoCatalogField[] = IN_CAR_DIAL_LEAVES.map(
  (leaf) =>
    setupField(
      `Chassis.InCarDials.${leaf.field}`,
      leaf.label,
      leaf.unit,
      `${leaf.description} from iRacing in-car setup dials.`,
      leaf.semanticId,
    ),
);

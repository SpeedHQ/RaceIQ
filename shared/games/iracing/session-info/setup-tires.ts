import type { IRacingSessionInfoCatalogField } from "./contracts";
import {
  setupCornerFields,
  setupTemperatureFields,
  type SetupLeaf,
} from "./setup-builders";

const TIRE_SETUP_LEAVES: readonly SetupLeaf[] = [
  {
    field: "LastHotPressure",
    label: "last hot pressure",
    unit: "value-with-unit",
    description: "Last setup-screen hot tire pressure",
    semanticId: "setup.tires.last-hot-pressure",
  },
  {
    field: "TreadRemaining",
    label: "tread remaining",
    unit: "value-with-unit",
    description: "Three-band tread remaining",
    semanticId: "setup.tires.tread-remaining",
  },
];

export const IRACING_TIRE_SETUP_FIELDS: readonly IRacingSessionInfoCatalogField[] = [
  ...setupCornerFields("TiresAero", [
    {
      field: "StartingPressure",
      label: "starting pressure",
      unit: "value-with-unit",
      description: "Configured starting tire pressure",
      semanticId: "setup.tires.starting-pressure",
    },
    ...TIRE_SETUP_LEAVES,
  ]),
  ...setupTemperatureFields("TiresAero"),
  ...setupCornerFields("Tires", [
    {
      field: "ColdPressure",
      label: "cold pressure",
      unit: "value-with-unit",
      description: "Configured cold tire pressure",
      semanticId: "setup.tires.starting-pressure",
    },
    ...TIRE_SETUP_LEAVES,
  ]),
  ...setupTemperatureFields("Tires"),
];

export const IRACING_SUSPENSION_TIRE_LEAVES: readonly SetupLeaf[] = [
  {
    field: "ColdPressure",
    label: "cold pressure",
    unit: "value-with-unit",
    description: "Configured cold tire pressure",
    semanticId: "setup.tires.starting-pressure",
  },
  ...TIRE_SETUP_LEAVES,
];

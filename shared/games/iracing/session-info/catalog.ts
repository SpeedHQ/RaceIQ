import type { IRacingSessionInfoCatalogField } from "./contracts";
import { IRACING_SESSION_INFO_SECTION_FIELDS } from "./sections";
import { IRACING_CAPTURED_SETUP_FIELDS } from "./setup-captured";
import { IRACING_TIRE_SETUP_FIELDS } from "./setup-tires";
import { IRACING_CHASSIS_SETUP_FIELDS } from "./setup-chassis";
import { IRACING_IN_CAR_SETUP_FIELDS } from "./setup-in-car";
import { IRACING_AERO_DRIVETRAIN_SETUP_FIELDS } from "./setup-aero-drivetrain";

export const IRACING_SETUP_INFO_FIELDS: readonly IRacingSessionInfoCatalogField[] = [
  ...IRACING_CAPTURED_SETUP_FIELDS,
  ...IRACING_TIRE_SETUP_FIELDS,
  ...IRACING_CHASSIS_SETUP_FIELDS,
  ...IRACING_IN_CAR_SETUP_FIELDS,
  ...IRACING_AERO_DRIVETRAIN_SETUP_FIELDS,
  {
    path: "CarSetup.**",
    label: "Unmapped car-specific setup values",
    unit: "structured",
    description:
      "Fallback for car- or build-specific setup leaves not represented by stable catalogued paths.",
    semanticId: "setup.metadata.unmapped-source-values",
    retention: "exact",
  },
];

export const IRACING_SESSION_INFO_CATALOG_FIELDS: readonly IRacingSessionInfoCatalogField[] = [
  ...IRACING_SESSION_INFO_SECTION_FIELDS,
  ...IRACING_SETUP_INFO_FIELDS,
];

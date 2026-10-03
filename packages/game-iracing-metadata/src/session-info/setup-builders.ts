import type { IRacingSessionInfoCatalogField } from "./contracts";
import { humanize } from "./formatting";

export interface SetupLeaf {
  field: string;
  label: string;
  unit: string;
  description: string;
  semanticId: string;
}

const IRACING_SETUP_CORNERS = [
  { path: "LeftFront", label: "front-left", temperatures: "LastTempsOMI" },
  { path: "RightFront", label: "front-right", temperatures: "LastTempsIMO" },
  { path: "LeftRear", label: "rear-left", temperatures: "LastTempsOMI" },
  { path: "RightRear", label: "rear-right", temperatures: "LastTempsIMO" },
] as const;

export function setupField(
  path: string,
  label: string,
  unit: string,
  description: string,
  semanticId: string,
): IRacingSessionInfoCatalogField {
  return {
    path: `CarSetup.${path}`,
    label,
    unit,
    description,
    semanticId,
    retention: "exact",
  };
}

export function setupCornerFields(
  section: string,
  leaves: readonly SetupLeaf[],
): IRacingSessionInfoCatalogField[] {
  return IRACING_SETUP_CORNERS.flatMap((corner) =>
    leaves.map((leaf) =>
      setupField(
        `${section}.${corner.path}.${leaf.field}`,
        `${humanize(leaf.label)} ${corner.label}`,
        leaf.unit,
        `${leaf.description} for ${corner.label} wheel.`,
        leaf.semanticId,
      ),
    ),
  );
}

export function setupTemperatureFields(
  section: string,
): IRacingSessionInfoCatalogField[] {
  return IRACING_SETUP_CORNERS.map((corner) =>
    setupField(
      `${section}.${corner.path}.${corner.temperatures}`,
      `Last temperature bands ${corner.label}`,
      "value-with-unit",
      `Last three setup-screen tire temperature bands for ${corner.label} wheel; source order is encoded by OMI or IMO field name.`,
      "setup.tires.last-temperature-bands",
    ),
  );
}

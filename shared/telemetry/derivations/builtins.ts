import type { TelemetryDerivation } from "./contracts";

const FUEL_PERCENT_DERIVATION_ID = "raceiq.fuel.percent";
const DERIVATION_VERSION = "1.0.0";

const FUEL_PERCENT_DERIVATION: TelemetryDerivation = {
  id: FUEL_PERCENT_DERIVATION_ID,
  version: DERIVATION_VERSION,
  output: {
    semanticId: "fuel.fuel-percent",
    unit: "%",
    valueType: "number",
  },
  inputs: [
    {
      semanticId: "fuel.fuel",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
    {
      semanticId: "fuel.fuel-capacity",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: false,
    },
  ],
  missingDataPolicy: "unavailable",
  deterministic: true,
  codeHash:
    "sha256:60836f23f692ccfb12d9a337b7ca132364a5db7c902f5f56addf1af81c9c120e",
  evaluate(context) {
    const fuel = context.number("fuel.fuel");
    if (fuel === undefined || !Number.isFinite(fuel)) {
      return context.unavailable("fuel.fuel unavailable");
    }

    const capacity = context.number("fuel.fuel-capacity");
    if (capacity === undefined && fuel >= 0 && fuel <= 1) {
      return context.value(fuel * 100);
    }
    if (capacity === undefined || !Number.isFinite(capacity) || capacity === 0) {
      return context.unavailable("fuel.fuel-capacity unavailable");
    }

    return context.value((fuel / capacity) * 100);
  },
};

const LAP_FRACTION_DERIVATION: TelemetryDerivation = {
  id: "raceiq.timing.lap-fraction",
  version: DERIVATION_VERSION,
  output: {
    semanticId: "timing.lap-fraction",
    unit: "fraction",
    valueType: "number",
  },
  inputs: [
    {
      semanticId: "timing.distance-traveled",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
    {
      semanticId: "timing.track-length",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
  ],
  missingDataPolicy: "unavailable",
  deterministic: true,
  codeHash:
    "sha256:b87b5facb5baa314354c3a05f841ded88a95bb22e6e0746a9dbe7ce3e1c62065",
  evaluate(context) {
    const distance = context.number("timing.distance-traveled");
    const trackLength = context.number("timing.track-length");
    if (
      distance === undefined ||
      trackLength === undefined ||
      trackLength <= 0
    ) {
      return context.unavailable("Lap distance or track length unavailable");
    }
    const ratio = distance / trackLength;
    return context.value(
      Math.max(0, Math.min(1, ratio <= 1 ? ratio : ratio % 1)),
    );
  },
};

export const TELEMETRY_DERIVATION_VERSION = DERIVATION_VERSION;


export function getBuiltinTelemetryDerivation(
  semanticId: string,
): TelemetryDerivation | undefined {
  if (semanticId === FUEL_PERCENT_DERIVATION.output.semanticId) {
    return FUEL_PERCENT_DERIVATION;
  }
  return semanticId === LAP_FRACTION_DERIVATION.output.semanticId
    ? LAP_FRACTION_DERIVATION
    : undefined;
}

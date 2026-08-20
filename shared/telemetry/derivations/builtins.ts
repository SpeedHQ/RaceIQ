import type { TelemetryDerivation } from "./contracts";

const DERIVATION_VERSION = "2.0.0";

const FUEL_REMAINING_VOLUME_DERIVATION: TelemetryDerivation = {
  id: "raceiq.fuel.remaining-volume",
  version: DERIVATION_VERSION,
  output: {
    semanticId: "fuel.remaining-volume",
    unit: "L",
    valueType: "number",
  },
  inputs: [
    {
      semanticId: "fuel.remaining-fraction",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
    {
      semanticId: "fuel.capacity",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
  ],
  missingDataPolicy: "unavailable",
  deterministic: true,
  codeHash:
    "sha256:9b8ec62e44b29d76b9833c6c364e91d26c01185d9d7bdb90df99d2a8c5fe50ac",
  evaluate(context) {
    const fraction = context.number("fuel.remaining-fraction");
    const capacity = context.number("fuel.capacity");
    if (fraction === undefined || !Number.isFinite(fraction)) {
      return context.unavailable("fuel.remaining-fraction unavailable");
    }
    if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) {
      return context.unavailable("fuel.capacity unavailable");
    }
    return context.value(fraction * capacity);
  },
};

const FUEL_REMAINING_FRACTION_DERIVATION: TelemetryDerivation = {
  id: "raceiq.fuel.remaining-fraction",
  version: DERIVATION_VERSION,
  output: {
    semanticId: "fuel.remaining-fraction",
    unit: "fraction",
    valueType: "number",
  },
  inputs: [
    {
      semanticId: "fuel.remaining-volume",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
    {
      semanticId: "fuel.capacity",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
  ],
  missingDataPolicy: "unavailable",
  deterministic: true,
  codeHash:
    "sha256:cde2e7633c376175900d34843c9f262365c295bef46b910a508a91a019e15b43",
  evaluate(context) {
    const volume = context.number("fuel.remaining-volume");
    const capacity = context.number("fuel.capacity");
    if (volume === undefined || !Number.isFinite(volume)) {
      return context.unavailable("fuel.remaining-volume unavailable");
    }
    if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) {
      return context.unavailable("fuel.capacity unavailable");
    }
    return context.value(volume / capacity);
  },
};

const FUEL_REMAINING_PERCENT_DERIVATION: TelemetryDerivation = {
  id: "raceiq.fuel.remaining-percent",
  version: DERIVATION_VERSION,
  output: {
    semanticId: "fuel.remaining-percent",
    unit: "%",
    valueType: "number",
  },
  inputs: [
    {
      semanticId: "fuel.remaining-fraction",
      acceptedMappings: ["direct", "normalized", "derived"],
      required: true,
    },
  ],
  missingDataPolicy: "unavailable",
  deterministic: true,
  codeHash:
    "sha256:31a55251437dedc88c7e37f5624c312af58f914a16824c792ad32acf44f416cc",
  evaluate(context) {
    const fraction = context.number("fuel.remaining-fraction");
    if (fraction === undefined || !Number.isFinite(fraction)) {
      return context.unavailable("fuel.remaining-fraction unavailable");
    }
    return context.value(fraction * 100);
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
  for (const derivation of [
    FUEL_REMAINING_VOLUME_DERIVATION,
    FUEL_REMAINING_FRACTION_DERIVATION,
    FUEL_REMAINING_PERCENT_DERIVATION,
    LAP_FRACTION_DERIVATION,
  ]) {
    if (semanticId === derivation.output.semanticId) return derivation;
  }
  return undefined;
}

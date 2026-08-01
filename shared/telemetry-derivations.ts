
export type DerivationMissingDataPolicy =
  | "unavailable"
  | "hold-last"
  | "interpolate"
  | "partial";

export type MappingStatus =
  | "direct"
  | "derived"
  | "simplified"
  | "unavailable";

export interface MappingInputRequirement {
  semanticId: string;
  acceptedMappings: readonly MappingStatus[];
  required: boolean;
}

export interface DerivationOutput {
  semanticId: string;
  unit: string;
  valueType: "number" | "boolean" | "enum" | "string";
}

export interface DerivationWindow {
  durationMs?: number;
  samples?: number;
  alignment: "event-time" | "frame-order";
}

export type DerivationState =
  | "ok"
  | "missing"
  | "stale"
  | "invalid"
  | "not-applicable"
  | "error";

export interface DerivationResultValue<T> {
  state: "ok";
  value: T;
}

export interface DerivationResultUnavailable {
  state: "missing" | "invalid" | "not-applicable" | "error";
  reason?: string;
}

export type DerivationResult<T = unknown> =
  | DerivationResultValue<T>
  | DerivationResultUnavailable;

export interface DerivationContext {
  number(semanticId: string): number | undefined;
  boolean(semanticId: string): boolean | undefined;
  text(semanticId: string): string | undefined;
  unavailable(reason?: string): DerivationResult;
  value<T>(value: T): DerivationResult<T>;
}

export interface TelemetryDerivation {
  readonly id: string;
  readonly version: string;
  readonly output: DerivationOutput;
  readonly inputs: readonly MappingInputRequirement[];
  readonly window?: DerivationWindow;
  readonly missingDataPolicy: DerivationMissingDataPolicy;
  readonly deterministic: boolean;
  readonly codeHash: string;
  evaluate(context: DerivationContext): DerivationResult;
}


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
      acceptedMappings: ["direct", "derived"],
      required: true,
    },
    {
      semanticId: "fuel.fuel-capacity",
      acceptedMappings: ["direct", "derived"],
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
      acceptedMappings: ["direct", "derived"],
      required: true,
    },
    {
      semanticId: "timing.track-length",
      acceptedMappings: ["direct", "derived"],
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
export const TELEMETRY_DERIVATIONS: readonly TelemetryDerivation[] = [
  FUEL_PERCENT_DERIVATION,
  LAP_FRACTION_DERIVATION,
];

export const DERIVATION_BY_OUTPUT = new Map<string, TelemetryDerivation>(
  TELEMETRY_DERIVATIONS.map((definition) => [definition.output.semanticId, definition]),
);

export function getTelemetryDerivations(): readonly TelemetryDerivation[] {
  return TELEMETRY_DERIVATIONS;
}

export function getTelemetryDerivationForOutput(
  semanticId: string,
): TelemetryDerivation | undefined {
  return DERIVATION_BY_OUTPUT.get(semanticId);
}

import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";

const ACCEPTED_MAPPINGS = ["direct", "normalized", "derived"] as const;

export const F1_RACE_EVENT_DERIVATIONS: readonly TelemetryDerivation[] = [
  {
    id: "f1-2025.race.control.phase",
    version: "1.1.0",
    output: { semanticId: "race.control.phase", unit: "enum", valueType: "enum" },
    inputs: [
      { semanticId: "diagnostics.result-source", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
      { semanticId: "race.result-status", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
      { semanticId: "race.safety-car-status", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
      { semanticId: "diagnostics.vehicle-fia-flags", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:f9c83bc4ba7fbbed88c80c6a5226762933d7810da5ca610da5e70f2a7b7eb765",
    evaluate(context) {
      const resultStatus = context.number("race.result-status");
      if (
        context.text("diagnostics.result-source") === "final-classification" &&
        resultStatus !== undefined
      ) {
        return context.value("finished");
      }
      const safetyCar = context.number("race.safety-car-status");
      if (safetyCar === 1 || safetyCar === 2) return context.value("caution");
      if (safetyCar === 3) return context.value("formation");
      const fiaFlag = context.number("diagnostics.vehicle-fia-flags");
      if (fiaFlag === 3) return context.value("caution");
      if (safetyCar === 0 || fiaFlag === 0 || fiaFlag === 1) return context.value("green");
      return context.unavailable("F1 race-control status unavailable");
    },
  },
  {
    id: "f1-2025.race.control.caution-kind",
    version: "1.0.0",
    output: { semanticId: "race.control.caution-kind", unit: "enum", valueType: "enum" },
    inputs: [
      { semanticId: "race.safety-car-status", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
      { semanticId: "diagnostics.vehicle-fia-flags", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:be7c2f6dc8aa6545b08a72c2af85a7b72a9621375d3f0d2bd51f2a50f117f13c",
    evaluate(context) {
      const safetyCar = context.number("race.safety-car-status");
      if (safetyCar === 1) return context.value("safety-car");
      if (safetyCar === 2) return context.value("virtual-safety-car");
      return context.number("diagnostics.vehicle-fia-flags") === 3
        ? context.value("local-yellow")
        : context.unavailable("F1 caution status unavailable");
    },
  },
  {
    id: "f1-2025.race.player.pit-state",
    version: "1.0.0",
    output: { semanticId: "race.player.pit-state", unit: "enum", valueType: "enum" },
    inputs: [{ semanticId: "race.player-pit-code", acceptedMappings: ACCEPTED_MAPPINGS, required: true }],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:669b2c3c3d8dd63b81ed5bb3fb39ddc44e1a7e5f20ae5109b3c2428d76572854",
    evaluate(context) {
      const pitStatus = context.number("race.player-pit-code");
      if (pitStatus === 0) return context.value("out");
      if (pitStatus === 1 || pitStatus === 2) return context.value("pit-lane");
      return context.unavailable(
        pitStatus === undefined
          ? "F1 player pit status unavailable"
          : `Unsupported F1 player pit status ${pitStatus}`,
      );
    },
  },
];

import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";

const ACCEPTED_MAPPINGS = ["direct", "normalized", "derived"] as const;

export const ACC_RACE_EVENT_DERIVATIONS: readonly TelemetryDerivation[] = [
  {
    id: "acc.race.control.phase",
    version: "1.0.3",
    output: { semanticId: "race.control.phase", unit: "enum", valueType: "enum" },
    inputs: [
      { semanticId: "race.flag-status", acceptedMappings: ACCEPTED_MAPPINGS, required: true },
      { semanticId: "race.is-race-on", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:f6164de139b2303c8f29b4bba7cd47b2eff6810fa6dcf378a6c1f9bef4b7edb8",
    evaluate(context) {
      const raceOn = context.boolean("race.is-race-on") ?? context.number("race.is-race-on");
      if (raceOn === false || raceOn === 0) return context.value("inactive");
      const flag = context.text("race.flag-status")?.toLowerCase();
      if (flag === "none") return context.value("green");
      if (flag === "yellow") return context.value("caution");
      if (flag === "checkered") return context.value("checkered");
      return context.unavailable("ACC flag does not define a race phase");
    },
  },
  {
    id: "acc.race.control.caution-kind",
    version: "1.0.0",
    output: { semanticId: "race.control.caution-kind", unit: "enum", valueType: "enum" },
    inputs: [{ semanticId: "race.flag-status", acceptedMappings: ACCEPTED_MAPPINGS, required: true }],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:878228b922972bbf65fd3f9e7cc6d1621c6f8f5e38a3cf246bbd56b15d9fd2e6",
    evaluate(context) {
      return context.text("race.flag-status")?.toLowerCase() === "yellow"
        ? context.value("local-yellow")
        : context.unavailable("ACC flag does not define a caution kind");
    },
  },
  {
    id: "acc.race.player.pit-state",
    version: "1.0.0",
    output: { semanticId: "race.player.pit-state", unit: "enum", valueType: "enum" },
    inputs: [{ semanticId: "race.pit-status", acceptedMappings: ACCEPTED_MAPPINGS, required: true }],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:b669f2e6b7a6c51492122b70de6a3c1c0e2993f0e3c8bfc5f77c5fd510e11f4d",
    evaluate(context) {
      const pitStatus = context.text("race.pit-status")?.toLowerCase();
      if (pitStatus === "out") return context.value("out");
      if (pitStatus === "pit_lane") return context.value("pit-lane");
      if (pitStatus === "in_pit") return context.value("pit-stall");
      return context.unavailable("ACC pit status unavailable");
    },
  },
];

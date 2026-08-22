import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";

const ACCEPTED_MAPPINGS = ["direct", "normalized", "derived"] as const;

export const AC_EVO_RACE_EVENT_DERIVATIONS: readonly TelemetryDerivation[] = [
  {
    id: "ac-evo.race.control.phase",
    version: "1.0.3",
    output: { semanticId: "race.control.phase", unit: "enum", valueType: "enum" },
    inputs: [
      { semanticId: "race.flag-status", acceptedMappings: ACCEPTED_MAPPINGS, required: true },
      { semanticId: "race.is-race-on", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:7a26411273df5b44886c52d9cd13d012a5a332a4fe3fcecf78f15ce65c8b928d",
    evaluate(context) {
      const raceOn = context.boolean("race.is-race-on") ?? context.number("race.is-race-on");
      if (raceOn === false || raceOn === 0) return context.value("inactive");
      const flag = context.text("race.flag-status")?.toLowerCase();
      if (flag === "none" || flag === "green") return context.value("green");
      if (flag === "yellow") return context.value("caution");
      if (flag === "red") return context.value("red");
      if (flag === "checkered") return context.value("checkered");
      return context.unavailable("AC Evo flag does not define a race phase");
    },
  },
  {
    id: "ac-evo.race.control.caution-kind",
    version: "1.0.0",
    output: { semanticId: "race.control.caution-kind", unit: "enum", valueType: "enum" },
    inputs: [{ semanticId: "race.flag-status", acceptedMappings: ACCEPTED_MAPPINGS, required: true }],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:41c6f51a599dc6feca3d6c1270c21c327b5db718a9f52e59ebd01e101d0c62c7",
    evaluate(context) {
      return context.text("race.flag-status")?.toLowerCase() === "yellow"
        ? context.value("local-yellow")
        : context.unavailable("AC Evo flag does not define a caution kind");
    },
  },
  {
    id: "ac-evo.race.player.pit-state",
    version: "1.0.0",
    output: { semanticId: "race.player.pit-state", unit: "enum", valueType: "enum" },
    inputs: [{ semanticId: "race.pit-status", acceptedMappings: ACCEPTED_MAPPINGS, required: true }],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:3f86c5cc34e70fa1edc97a4d3435a37a53941059a7efcaa8f867f4538f99e69e",
    evaluate(context) {
      const pitStatus = context.text("race.pit-status")?.toLowerCase();
      if (pitStatus === "out") return context.value("out");
      if (pitStatus === "pit_lane") return context.value("pit-lane");
      if (pitStatus === "in_pit") return context.value("pit-stall");
      return context.unavailable("AC Evo pit status unavailable");
    },
  },
];

import type { TelemetryDerivation } from "../../../shared/telemetry/derivations/contracts";

const DERIVATION_VERSION = "1.0.0";
const ACCEPTED_MAPPINGS = ["direct", "normalized", "derived"] as const;
const PIT_SERVICE_STATUS = "race.player-car-pit-sv-status";
const MANDATORY_REPAIR = "race.pit-repair-left";
const OPTIONAL_REPAIR = "race.pit-opt-repair-left";
const TIRE_SETS_USED = "tires.tire-sets-used";

function repairCountdown(
  context: Parameters<TelemetryDerivation["evaluate"]>[0],
): { mandatory: number; optional: number } | null {
  const mandatory = context.number(MANDATORY_REPAIR);
  const optional = context.number(OPTIONAL_REPAIR);
  return mandatory !== undefined &&
    Number.isFinite(mandatory) &&
    mandatory >= 0 &&
    optional !== undefined &&
    Number.isFinite(optional) &&
    optional >= 0
    ? { mandatory, optional }
    : null;
}

export const IRACING_RACE_EVENT_DERIVATIONS: readonly TelemetryDerivation[] = [
  {
    id: "iracing.race.control.phase",
    version: DERIVATION_VERSION,
    output: {
      semanticId: "race.control.phase",
      unit: "enum",
      valueType: "enum",
    },
    inputs: [
      { semanticId: "session.session-flags", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
      { semanticId: "session.session-state", acceptedMappings: ACCEPTED_MAPPINGS, required: false },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:3d67670f1ccb1faee4a59a559f15ca4b543e8be57f3523f927d1197e1e143270",
    evaluate(context) {
      const state = context.number("session.session-state");
      const flags = context.number("session.session-flags");
      if (state === 6) return context.value("finished");
      if (state === 5 || (flags !== undefined && (flags & 0x1) !== 0)) {
        return context.value("checkered");
      }
      if (state === 3 || (flags !== undefined && (flags & 0x200) !== 0)) {
        return context.value("formation");
      }
      if (flags !== undefined && (flags & 0x10) !== 0) return context.value("red");
      if (flags !== undefined && (flags & (0x8 | 0x100 | 0x4000 | 0x8000)) !== 0) {
        return context.value("caution");
      }
      if (state === 4 && flags !== undefined && (flags & 0x4) !== 0) {
        return context.value("green");
      }
      return context.unavailable("iRacing race-control state unavailable");
    },
  },
  {
    id: "iracing.race.control.caution-kind",
    version: DERIVATION_VERSION,
    output: {
      semanticId: "race.control.caution-kind",
      unit: "enum",
      valueType: "enum",
    },
    inputs: [{ semanticId: "session.session-flags", acceptedMappings: ACCEPTED_MAPPINGS, required: true }],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:7354f13970eeb2bf6e372cbc6924ca237159ff028844892e1a02868f50a16b04",
    evaluate(context) {
      const flags = context.number("session.session-flags");
      return flags !== undefined && (flags & (0x8 | 0x100 | 0x4000 | 0x8000)) !== 0
        ? context.value("full-course-yellow")
        : context.unavailable("iRacing caution flags unavailable");
    },
  },
  {
    id: "iracing.race.player.pit-state",
    version: DERIVATION_VERSION,
    output: {
      semanticId: "race.player.pit-state",
      unit: "enum",
      valueType: "enum",
    },
    inputs: [
      {
        semanticId: "race.player-car-in-pit-stall",
        acceptedMappings: ACCEPTED_MAPPINGS,
        required: false,
      },
      {
        semanticId: "race.on-pit-road",
        acceptedMappings: ACCEPTED_MAPPINGS,
        required: false,
      },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:ab9b133a2e6dd69c5ac982ad966d9f58b38f0dd9e4b6b39f7b9fdf14c746baa5",
    evaluate(context) {
      if (context.boolean("race.player-car-in-pit-stall") === true) {
        return context.value("pit-stall");
      }
      const onPitRoad = context.boolean("race.on-pit-road");
      if (onPitRoad === true) return context.value("pit-lane");
      if (onPitRoad === false) return context.value("out");
      return context.unavailable("native pit state unavailable");
    },
  },
  {
    id: "iracing.race.pit-service.lifecycle-status",
    version: DERIVATION_VERSION,
    output: {
      semanticId: "race.pit-service.lifecycle-status",
      unit: "enum",
      valueType: "enum",
    },
    inputs: [
      {
        semanticId: PIT_SERVICE_STATUS,
        acceptedMappings: ACCEPTED_MAPPINGS,
        required: true,
      },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:cae6ea2a247e0e95ad7d35f77cbe02504f1252f4e79bc4ab99b3a894c0f2f45d",
    evaluate(context) {
      const status = context.number(PIT_SERVICE_STATUS);
      if (status === undefined) {
        return context.unavailable("native pit-service status unavailable");
      }
      if (status === 0) return context.value("none");
      if (status === 1) return context.value("in-progress");
      if (status === 2) return context.value("complete");
      if (status >= 100) return context.value("error");
      return context.unavailable(`Unsupported native pit-service status ${status}`);
    },
  },
  {
    id: "iracing.race.pit-service.tire-change-counts",
    version: DERIVATION_VERSION,
    output: {
      semanticId: "race.pit-service.tire-change-counts",
      unit: "count",
      valueType: "structured",
    },
    inputs: [
      {
        semanticId: TIRE_SETS_USED,
        acceptedMappings: ACCEPTED_MAPPINGS,
        required: true,
      },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:da4d3163576c7fac75a1bd8136459df46c8b21dcab25a2528061485e96a54dfd",
    evaluate(context) {
      const setsUsed = context.number(TIRE_SETS_USED);
      if (
        typeof setsUsed !== "number" ||
        !Number.isSafeInteger(setsUsed) ||
        setsUsed < 0
      ) {
        return context.unavailable("native tire-set counter unavailable");
      }
      return context.value({
        fl: setsUsed,
        fr: setsUsed,
        rl: setsUsed,
        rr: setsUsed,
      });
    },
  },
  {
    id: "iracing.race.pit-service.repair-time-remaining",
    version: DERIVATION_VERSION,
    output: {
      semanticId: "race.pit-service.repair-time-remaining",
      unit: "s",
      valueType: "structured",
    },
    inputs: [
      { semanticId: MANDATORY_REPAIR, acceptedMappings: ACCEPTED_MAPPINGS, required: true },
      { semanticId: OPTIONAL_REPAIR, acceptedMappings: ACCEPTED_MAPPINGS, required: true },
    ],
    missingDataPolicy: "unavailable",
    deterministic: true,
    codeHash: "sha256:cc9f2ae7c12d81f3d749ceb0b3898df0cfef58168ced2e8106a0aec96f21a879",
    evaluate(context) {
      const repair = repairCountdown(context);
      return repair === null
        ? context.unavailable("native repair countdown unavailable")
        : context.value(repair);
    },
  },
];

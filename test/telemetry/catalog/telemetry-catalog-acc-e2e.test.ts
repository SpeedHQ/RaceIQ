import { test } from "bun:test";
import { getGame } from "../../../shared/games/registry";
import { initGameAdapters } from "../../../shared/games/init";
import { requiredSemanticIds } from "../../../shared/games/metric-contracts";
import { assertRecordedCatalogCoverage, changingPacketFields } from "../../support/telemetry/catalog-e2e";
initGameAdapters();

const RECORDING = "test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz";

const DYNAMIC_UI_FIELDS = [
  "CurrentEngineRpm",
  "Speed",
  "Fuel",
  "DistanceTraveled",
  "CurrentLap",
  "CurrentRaceTime",
  "Accel",
  "Brake",
  "Gear",
  "Steer",
  "AccelerationX",
  "AccelerationZ",
  "Yaw",
  "Pitch",
  "Roll",
  "PositionX",
  "PositionZ",
  "TireTempFL",
  "TireTempFR",
  "TireTempRL",
  "TireTempRR",
  "NormSuspensionTravelFL",
  "NormSuspensionTravelFR",
  "NormSuspensionTravelRL",
  "NormSuspensionTravelRR",
  "SuspensionTravelMFL",
  "SuspensionTravelMFR",
  "SuspensionTravelMRL",
  "SuspensionTravelMRR",
  "TireSlipRatioFL",
  "TireSlipRatioFR",
  "TireSlipRatioRL",
  "TireSlipRatioRR",
  "TireSlipAngleFL",
  "TireSlipAngleFR",
  "TireSlipAngleRL",
  "TireSlipAngleRR",
  "TireCombinedSlipFL",
  "TireCombinedSlipFR",
  "TireCombinedSlipRL",
  "TireCombinedSlipRR",
  "WheelRotationSpeedFL",
  "WheelRotationSpeedFR",
  "WheelRotationSpeedRL",
  "WheelRotationSpeedRR",
  "BrakeTempFrontLeft",
  "BrakeTempFrontRight",
  "BrakeTempRearLeft",
  "BrakeTempRearRight",
  "TirePressureFrontLeft",
  "TirePressureFrontRight",
  "TirePressureRearLeft",
  "TirePressureRearRight",
] as const;

test(
  "acc recording resolves shared memory catalog semantics",
  async () => {
    await assertRecordedCatalogCoverage({
      gameId: "acc",
      recording: RECORDING,
      requiredSemanticIds: requiredSemanticIds(getGame("acc")),
      lapDynamics: changingPacketFields(DYNAMIC_UI_FIELDS),
      expectations: [
        {
          semanticId: "motion.speed",
          mappingStatus: "direct",
          unit: "m/s",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return value > 1 && value <= 100;
          },
          minimumRange: 1,
        },
        {
          semanticId: "inputs.throttle",
          mappingStatus: "normalized",
          unit: "ratio",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return value > 0 && value <= 1;
          },
          minimumRange: 1 / 255,
        },
        {
          semanticId: "timing.current-lap",
          mappingStatus: "direct",
          unit: "s",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return value > 0 && value <= 60 * 60;
          },
          minimumRange: 1,
        },
        {
          semanticId: "timing.lap-number",
          mappingStatus: "direct",
          unit: "count",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return Number.isInteger(value) && value >= 1 && value <= 50;
          },
        },
        {
          semanticId: "tires.tire-pressure",
          mappingStatus: "direct",
          unit: "psi",
          accepts: (value: unknown): boolean => {
            if (!Array.isArray(value)) return false;
            if (value.length !== 4) return false;
            return value.every((entry) => {
              if (typeof entry !== "number") return false;
              if (!Number.isFinite(entry)) return false;
              return entry >= 10 && entry <= 40;
            });
          },
        },
      ],
    });
  },
  { timeout: 120000 },
);

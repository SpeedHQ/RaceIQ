import { test } from "bun:test";
import { getGame } from "../../../shared/games/registry";
import { initGameAdapters } from "../../../shared/games/init";
import { requiredSemanticIds } from "../../../shared/games/metric-contracts";
import { assertRecordedCatalogCoverage, changingPacketFields } from "../../support/telemetry/catalog-e2e";
initGameAdapters();

const RECORDING = "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

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
  "AC-Evo recording resolves shared-memory catalog semantics",
  async () => {
    await assertRecordedCatalogCoverage({
      gameId: "ac-evo",
      recording: RECORDING,
      requiredSemanticIds: requiredSemanticIds(getGame("ac-evo")),
      lapDynamics: [
        ...changingPacketFields(DYNAMIC_UI_FIELDS),
        { name: "brake pad FL", read: (packet) => packet.acc?.brakePadWear[0] },
        { name: "brake pad FR", read: (packet) => packet.acc?.brakePadWear[1] },
        { name: "brake pad RL", read: (packet) => packet.acc?.brakePadWear[2] },
        { name: "brake pad RR", read: (packet) => packet.acc?.brakePadWear[3] },
      ],
      expectations: [
        {
          semanticId: "motion.speed",
          mappingStatus: "direct",
          unit: "m/s",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 1 && value < 150,
          minimumRange: 1,
        },
        {
          semanticId: "inputs.throttle",
          mappingStatus: "normalized",
          unit: "ratio",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value <= 1,
          minimumRange: 1 / 255,
        },
        {
          semanticId: "inputs.clutch",
          mappingStatus: "normalized",
          unit: "ratio",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value >= 0 && value <= 1,
        },
        {
          semanticId: "timing.current-lap",
          mappingStatus: "direct",
          unit: "s",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value < 60 * 60 * 10,
          minimumRange: 1,
        },
        {
          semanticId: "timing.lap-number",
          mappingStatus: "direct",
          unit: "count",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= 200,
        },
        {
          semanticId: "timing.distance-traveled",
          mappingStatus: "direct",
          unit: "m",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value < 100_000,
          minimumRange: 10,
        },
      ],
    });
  },
  { timeout: 120_000 },
);

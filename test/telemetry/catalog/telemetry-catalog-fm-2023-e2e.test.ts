import { describe, expect, test } from "bun:test";
import { getGame } from "../../../shared/games/registry";
import { initGameAdapters } from "../../../shared/games/init";
import { requiredSemanticIds } from "../../../shared/games/metric-contracts";
import { assertRecordedCatalogCoverage, changingPacketFields } from "../../support/telemetry/catalog-e2e";
function isFiniteNumberOrWheelArray(value: unknown): boolean {
  return isFiniteNumber(value) || (Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber));
}
import { TELEMETRY_CATALOG } from "../../../shared/telemetry/catalog/data";
initGameAdapters();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const DYNAMIC_UI_FIELDS = [
  "CurrentEngineRpm",
  "Speed",
  "Power",
  "Torque",
  "Boost",
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
  "TireWearFL",
  "TireWearFR",
  "TireWearRL",
  "TireWearRR",
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
] as const;
describe("FM 2023 telemetry catalog coverage", () => {
  test("keeps physical slip angle unavailable", () => {
    expect(TELEMETRY_CATALOG.variables.find(({ id }) => id === "tires.tire-slip-angle")?.games["fm-2023"]).toMatchObject({ kind: "unavailable" });
  });

  test(
    "covers motion, input, and timing/session semantics from recording",
    async () => {
      await assertRecordedCatalogCoverage({
        gameId: "fm-2023",
        recording: "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
        requiredSemanticIds: requiredSemanticIds(getGame("fm-2023")),
        lapDynamics: changingPacketFields(DYNAMIC_UI_FIELDS),
        expectations: [
          {
            semanticId: "tires.normalized-tire-slip-angle",
            mappingStatus: "direct",
            unit: "ratio",
            accepts: isFiniteNumberOrWheelArray,
          },
          {
            semanticId: "tires.tire-combined-slip",
            mappingStatus: "direct",
            unit: "ratio",
            accepts: isFiniteNumberOrWheelArray,
          },
          {
            semanticId: "tires.tire-slip-ratio",
            mappingStatus: "direct",
            unit: "ratio",
            accepts: isFiniteNumberOrWheelArray,
          },
          {
            semanticId: "tires.wheel-rotation-speed",
            mappingStatus: "direct",
            unit: "rad/s",
            accepts: isFiniteNumberOrWheelArray,
          },
          {
            semanticId: "motion.speed",
            mappingStatus: "direct",
            unit: "m/s",
            accepts: (value): boolean => isFiniteNumber(value) && value > 0 && value < 150,
            minimumRange: 1,
          },
          {
            semanticId: "motion.position-x",
            mappingStatus: "direct",
            unit: "m",
            accepts: (value): boolean => isFiniteNumber(value) && Math.abs(value) < 100_000,
            minimumRange: 10,
          },
          {
            semanticId: "inputs.accel",
            mappingStatus: "direct",
            unit: "0–255",
            accepts: (value): boolean => isFiniteNumber(value) && Number.isInteger(value) && value > 0 && value <= 255,
            minimumRange: 1,
          },
          {
            semanticId: "inputs.gear",
            mappingStatus: "direct",
            unit: "index",
            accepts: (value): boolean => isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 15,
            minimumRange: 0,
          },
          {
            semanticId: "timing.current-race-time",
            mappingStatus: "direct",
            unit: "s",
            accepts: (value): boolean => isFiniteNumber(value) && value > 0 && value < 10_000,
            minimumRange: 1,
          },
          {
            semanticId: "identity.track-ordinal",
            mappingStatus: "normalized",
            unit: "id",
            accepts: (value): boolean => isFiniteNumber(value) && Number.isInteger(value) && value > 0 && value < 10_000,
          },
        ],
      });
    },
    { timeout: 120000 },
  );
});

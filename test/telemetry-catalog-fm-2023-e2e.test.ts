import { describe, test } from "bun:test";
import { assertRecordedCatalogCoverage } from "./helpers/telemetry-catalog-e2e";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

describe("FM 2023 telemetry catalog coverage", () => {
  test(
    "covers motion, input, and timing/session semantics from recording",
    async () => {
      await assertRecordedCatalogCoverage({
        gameId: "fm-2023",
        recording: "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz",
        expectations: [
          {
            semanticId: "motion.speed",
            mappingStatus: "direct",
            unit: "m/s",
            accepts: (value): boolean => isFiniteNumber(value) && value > 0 && value < 150,
          },
          {
            semanticId: "motion.position-x",
            mappingStatus: "direct",
            unit: "m",
            accepts: (value): boolean => isFiniteNumber(value) && Math.abs(value) < 100_000,
          },
          {
            semanticId: "inputs.accel",
            mappingStatus: "direct",
            unit: "0–255",
            accepts: (value): boolean => isFiniteNumber(value) && Number.isInteger(value) && value > 0 && value <= 255,
          },
          {
            semanticId: "inputs.gear",
            mappingStatus: "direct",
            unit: "index",
            accepts: (value): boolean => isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 15,
          },
          {
            semanticId: "timing.current-race-time",
            mappingStatus: "direct",
            unit: "s",
            accepts: (value): boolean => isFiniteNumber(value) && value > 0 && value < 10_000,
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

import { test } from "bun:test";
import { assertRecordedCatalogCoverage } from "./helpers/telemetry-catalog-e2e";

const RECORDING = "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

test(
  "AC-Evo recording resolves shared-memory catalog semantics",
  async () => {
    await assertRecordedCatalogCoverage({
      gameId: "ac-evo",
      recording: RECORDING,
      expectations: [
        {
          semanticId: "motion.speed",
          mappingStatus: "normalized",
          unit: "m/s",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 1 && value < 150,
        },
        {
          semanticId: "inputs.accel",
          mappingStatus: "normalized",
          unit: "0–255",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value <= 255,
        },
        {
          semanticId: "inputs.clutch-percent",
          mappingStatus: "direct",
          unit: "%",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value >= 0 && value <= 100,
        },
        {
          semanticId: "timing.current-lap",
          mappingStatus: "normalized",
          unit: "s",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value < 60 * 60 * 10,
        },
        {
          semanticId: "timing.lap-number",
          mappingStatus: "derived",
          unit: "count",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && Number.isInteger(value) && value >= 1 && value <= 200,
        },
        {
          semanticId: "timing.distance-traveled",
          mappingStatus: "derived",
          unit: "m",
          accepts: (value: unknown): boolean => isFiniteNumber(value) && value > 0 && value < 100_000,
        },
      ],
    });
  },
  { timeout: 120_000 },
);

import { afterAll, describe, test } from "bun:test";
import { stopMaintenanceTasks } from "../server/telemetry/live-pipeline"
import { assertRecordedCatalogCoverage } from "./helpers/telemetry-catalog-e2e";

const RECORDING = "test/artifacts/sessions/iracing-road-america-gt3.bin.gz";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNumberArrayOfLength(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

describe("iRacing telemetry catalog coverage", () => {
  afterAll(() => {
    stopMaintenanceTasks();
  });

  test(
    "resolves catalog semantics through iracing parser and resolver",
    async () => {
      await assertRecordedCatalogCoverage({
        gameId: "iracing",
        recording: RECORDING,
        expectations: [
          {
            semanticId: "motion.speed",
            mappingStatus: "normalized",
            unit: "m/s",
            accepts: (value) => isFiniteNumber(value) && value > 1,
          },
          {
            semanticId: "inputs.brake",
            mappingStatus: "normalized",
            unit: "0–255",
            accepts: (value) => isFiniteNumber(value) && value > 0 && value <= 255,
          },
          {
            semanticId: "timing.current-lap",
            mappingStatus: "derived",
            unit: "s",
            accepts: (value) => isFiniteNumber(value) && value > 0,
          },
          {
            semanticId: "timing.lap-fraction",
            mappingStatus: "normalized",
            unit: "fraction",
            accepts: (value) => isFiniteNumber(value) && value > 0 && value < 1,
          },
          {
            semanticId: "timing.track-length",
            mappingStatus: "normalized",
            unit: "m",
            accepts: (value) => isFiniteNumber(value) && value > 100,
          },
          {
            semanticId: "session.session-tick",
            mappingStatus: "direct",
            unit: "count",
            accepts: (value) => isFiniteNumber(value) && value > 0,
          },
          {
            semanticId: "race.on-pit-road",
            mappingStatus: "direct",
            unit: "boolean",
            accepts: isBoolean,
          },
          {
            semanticId: "suspension.suspension-travel-m",
            mappingStatus: "direct",
            unit: "m",
            accepts: (value) => isFiniteNumberArrayOfLength(value, 4) && value.every((x) => x >= 0),
          },
          {
            semanticId: "tire.temperature.carcass.left",
            mappingStatus: "direct",
            unit: "°C",
            accepts: (value) => isFiniteNumberArrayOfLength(value, 4) && value.every((x) => x > -273.15 && x < 200),
          },
        ],
      });
    },
    { timeout: 120000 },
  );
});

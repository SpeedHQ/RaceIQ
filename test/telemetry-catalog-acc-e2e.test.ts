import { test } from "bun:test";
import { assertRecordedCatalogCoverage } from "./helpers/telemetry-catalog-e2e";

const RECORDING = "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz";

test(
  "acc recording resolves shared memory catalog semantics",
  async () => {
    await assertRecordedCatalogCoverage({
      gameId: "acc",
      recording: RECORDING,
      expectations: [
        {
          semanticId: "motion.speed",
          mappingStatus: "normalized",
          unit: "m/s",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return value > 1 && value <= 100;
          },
        },
        {
          semanticId: "inputs.accel",
          mappingStatus: "normalized",
          unit: "0–255",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return value > 0 && value <= 255;
          },
        },
        {
          semanticId: "timing.current-lap",
          mappingStatus: "normalized",
          unit: "s",
          accepts: (value: unknown): boolean => {
            if (typeof value !== "number") return false;
            if (!Number.isFinite(value)) return false;
            return value > 0 && value <= 60 * 60;
          },
        },
        {
          semanticId: "timing.lap-number",
          mappingStatus: "derived",
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

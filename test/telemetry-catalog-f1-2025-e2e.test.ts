import { test } from "bun:test";
import { assertRecordedCatalogCoverage } from "./helpers/telemetry-catalog-e2e";

const FIXTURE = "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";

test(
  "F1 2025 recording resolves end-to-end parser and catalog values",
  async () => {
    await assertRecordedCatalogCoverage({
      gameId: "f1-2025",
      recording: FIXTURE,
      expectations: [
        {
          semanticId: "motion.speed",
          mappingStatus: "normalized",
          unit: "m/s",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && value > 1 && value < 150,
        },
        {
          semanticId: "inputs.accel",
          mappingStatus: "normalized",
          unit: "0–255",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 255,
        },
        {
          semanticId: "inputs.brake",
          mappingStatus: "normalized",
          unit: "0–255",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 255,
        },
        {
          semanticId: "timing.current-race-time",
          mappingStatus: "direct",
          unit: "s",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100_000,
        },
        {
          semanticId: "timing.lap-number",
          mappingStatus: "direct",
          unit: "count",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value < 100,
        },
        {
          semanticId: "timing.track-length",
          mappingStatus: "direct",
          unit: "m",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && value > 100 && value < 20_000,
        },
        {
          semanticId: "timing.lap-fraction",
          mappingStatus: "derived",
          unit: "fraction",
          accepts: (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1,
        },
      ],
    });
  },
  { timeout: 120_000 },
);

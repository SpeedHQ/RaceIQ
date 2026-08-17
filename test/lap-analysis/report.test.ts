import { describe, expect, test } from "bun:test";
import { generateExport } from "../../server/lap-analysis/report";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";

const lap = {
  ...DEFAULT_LAP_CLASSIFICATION,
  lapNumber: 1,
  lapTime: 90,
  isValid: true,
  carOrdinal: 1,
  trackOrdinal: 1,
  gameId: "fm-2023" as const,
  quality: null,
  eligibility: null,
};

describe("generateExport quality policy", () => {
  test("rejects a lap whose quality has not been rebuilt", () => {
    expect(() => generateExport(lap, [])).toThrow("Quality has not been rebuilt from source telemetry.");
  });

  test("reports stale quality distinctly from missing quality", () => {
    expect(() => generateExport({ ...lap, qualityStale: true }, [])).toThrow("Stored quality is out of date and must be rebuilt.");
  });
});

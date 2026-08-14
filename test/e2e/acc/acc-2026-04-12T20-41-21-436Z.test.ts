import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDump } from "../../support/recordings/parse-dump";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";
import { assertValidLapHasSectors } from "../../support/laps/assertions";

const recordingFile = "acc-2026-04-12T20-41-21-436Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("pit lap sectors null, outlap and valid laps have correct sectors", async () => {
    if (!existsSync(recording)) return;

    const { laps } = await parseDump("acc", recording);
    for (const l of laps) console.log(lapSummary(l));

    // 6 laps: pit lap + outlap + 2 valid + short invalid + incomplete
    expect(laps.length).toBe(6);

    // Lap 0: valid pit telemetry, non-pace classification, sectors null
    expect(laps[0].isValid).toBe(true);
    expect(laps[0]).toMatchObject({ phase: "pit", conditions: [], paceEligibility: "excluded" });
    expect(laps[0].invalidReason).toBeNull();
    expect(laps[0].sectors).toBeNull();

    // Lap 1: valid out lap with valid sectors
    expect(laps[1].isValid).toBe(true);
    expect(laps[1]).toMatchObject({ phase: "out", conditions: [], paceEligibility: "excluded" });
    expect(laps[1].invalidReason).toBeNull();
    assertBrandHatchSectorBounds(laps[1]);

    // Laps 2-3: clean laps
    expect(laps[2].isValid).toBe(true);
    assertValidLapHasSectors(laps[2]);
    expect(laps[2].sectors).toHaveLength(3);
    assertBrandHatchSectorBounds(laps[2]);
    expect(laps[3].isValid).toBe(true);
    assertValidLapHasSectors(laps[3]);
    expect(laps[3].sectors).toHaveLength(3);
    assertBrandHatchSectorBounds(laps[3]);
  }, 120_000); // replays a full recorded UDP session through the pipeline; slow on CI
});

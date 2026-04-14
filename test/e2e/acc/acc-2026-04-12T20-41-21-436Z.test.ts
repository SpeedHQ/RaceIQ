import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDump } from "../../helpers/parse-dump";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";
import { assertValidLapHasSectors } from "../../helpers/lap-assertions";

const recordingFile = "acc-2026-04-12T20-41-21-436Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("pit lap sectors null, outlap and valid laps have correct sectors", async () => {
    if (!existsSync(recording)) return;

    const { laps } = await parseDump("acc", recording);
    for (const l of laps) console.log(lapSummary(l));

    // 6 laps: pit lap + outlap + 2 valid + short invalid + incomplete
    expect(laps.length).toBe(6);

    // Lap 0: pit lap — recording started mid-lap inside pit, sectors null
    expect(laps[0].isValid).toBe(false);
    expect(laps[0].invalidReason).toBe("pit lap");
    expect(laps[0].sectors).toBeNull();

    // Lap 1: outlap with valid sectors
    expect(laps[1].isValid).toBe(false);
    expect(laps[1].invalidReason).toBe("outlap");
    assertBrandHatchSectorBounds(laps[1]);

    // Laps 2-3: clean laps
    expect(laps[2].isValid).toBe(true);
    assertValidLapHasSectors(laps[2]);
    assertBrandHatchSectorBounds(laps[2]);
    expect(laps[3].isValid).toBe(true);
    assertValidLapHasSectors(laps[3]);
    assertBrandHatchSectorBounds(laps[3]);
  });
});

console.log = () => {};
import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDump } from "../../helpers/parse-dump";
import { TestLogger } from "../../helpers/test-logger";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";

const recordingFile = "acc-2026-04-12T20-41-21-436Z.bin";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("pit lap sectors null, outlap and valid laps have correct sectors", async () => {
    if (!existsSync(recording)) return;

    const log = new TestLogger(recordingFile);
    const { laps } = await parseDump("acc", recording);
    for (const l of laps) log.log(lapSummary(l));

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
    assertBrandHatchSectorBounds(laps[2]);
    expect(laps[3].isValid).toBe(true);
    assertBrandHatchSectorBounds(laps[3]);
    log.flush();
  }, { timeout: 30000 });
});

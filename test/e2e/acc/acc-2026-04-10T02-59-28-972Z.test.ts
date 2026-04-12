console.log = () => {};
import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDumpV2 } from "../../helpers/parse-dump-v2";
import { generateRecordingVisualizations } from "../../helpers/lap-viz";
import { TestLogger } from "../../helpers/test-logger";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";

const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("5 laps: outlap + 3 valid + incomplete tail", async () => {
    if (!existsSync(recording)) return;

    const log = new TestLogger(recordingFile);
    const { laps, carModel, trackName, rawPackets } = await parseDumpV2("acc", recording);

    log.log(`v2 detected ${laps.length} lap(s)`);
    for (const l of laps) log.log(lapSummary(l));
    await generateRecordingVisualizations(recordingFile, laps, rawPackets);

    expect(carModel).toBe("mclaren_720s_gt3_evo");
    expect(trackName).toBe("brands_hatch");
    expect(laps.length).toBe(5);
    expect(laps.filter((l) => l.isValid).length).toBe(3);

    // Lap 0: joining lap (recording started mid-lap, from pit)
    expect(laps[0].isValid).toBe(false);
    expect(laps[0].invalidReason).toBe("outlap");
    expect(laps[0].packets[0].acc?.pitStatus).not.toBe("out");

    // Laps 1-3: valid clean laps
    expect(laps[1].isValid).toBe(true);
    expect(laps[1].packets[0].acc?.pitStatus).toBe("out");
    expect(laps[2].isValid).toBe(true);
    expect(laps[2].packets[0].acc?.pitStatus).toBe("out");
    expect(laps[3].isValid).toBe(true);
    expect(laps[3].packets[0].acc?.pitStatus).toBe("out");

    expect(laps[1].lapTime).toBeCloseTo(90.375, 0);
    expect(laps[2].lapTime).toBeCloseTo(88.120, 0);
    expect(laps[3].lapTime).toBeCloseTo(89.277, 0);

    assertBrandHatchSectorBounds(laps[1]);
    assertBrandHatchSectorBounds(laps[2]);
    assertBrandHatchSectorBounds(laps[3]);

    // Lap 4: incomplete tail
    expect(laps[4].isValid).toBe(false);
    expect(laps[4].invalidReason).toBe("incomplete");
    log.flush();
  }, { timeout: 30000 });
});

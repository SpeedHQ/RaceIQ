import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDump } from "../../helpers/parse-dump";
import { generateRecordingVisualizations } from "../../helpers/lap-viz";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";
import { assertValidLapHasSectors } from "../../helpers/lap-assertions";

const recordingFile = "acc-2026-04-09T18-56-49-633Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("4 laps: outlap + 2 valid + incomplete tail", async () => {
    if (!existsSync(recording)) return;

    const { laps, carModel, trackName, rawPackets } = await parseDump("acc", recording);

    console.log(`v2 detected ${laps.length} lap(s)`);
    for (const l of laps) console.log(lapSummary(l));
    generateRecordingVisualizations(recordingFile, laps, rawPackets);

    expect(carModel).toBe("mclaren_720s_gt3_evo");
    expect(trackName).toBe("brands_hatch");
    expect(laps.length).toBe(4);
    expect(laps.filter((l) => l.isValid).length).toBe(2);

    // Lap 0: joining lap (recording started mid-lap, from pit)
    expect(laps[0].isValid).toBe(false);
    expect(laps[0].invalidReason).toBe("outlap");
    expect(laps[0].packets[0].acc?.pitStatus).not.toBe("out");

    // Laps 1-2: valid laps with sectors
    expect(laps[1].isValid).toBe(true);
    expect(laps[2].isValid).toBe(true);

    expect(laps[1].lapTime).toBeCloseTo(100.312, 0);
    expect(laps[2].lapTime).toBeCloseTo(101.750, 0);

    assertValidLapHasSectors(laps[1]);
    assertValidLapHasSectors(laps[2]);
    assertBrandHatchSectorBounds(laps[1]);
    assertBrandHatchSectorBounds(laps[2]);

    // Lap 3: incomplete tail
    expect(laps[3].isValid).toBe(false);
    expect(laps[3].invalidReason).toBe("incomplete");
  });
});

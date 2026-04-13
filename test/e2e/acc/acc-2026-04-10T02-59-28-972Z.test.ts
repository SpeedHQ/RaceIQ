import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDump } from "../../helpers/parse-dump";
import { generateRecordingVisualizations } from "../../helpers/lap-viz";
import { assertSectorTimesMatchLapTime, assertLapTimesProper, assertValidLapHasSectors } from "../../helpers/lap-assertions";
import type { LapSavedNotification } from "../../../server/lap-detector";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";

const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("5 laps: outlap + 3 valid + incomplete tail", async () => {
    if (!existsSync(recording)) return;

    const { laps, wsNotifications, rawPackets } = await parseDump("acc", recording);
    const lapSaved = wsNotifications.filter((n): n is LapSavedNotification => n.type === "lap-saved");

    console.log(`v2 detected ${laps.length} lap(s)`);
    for (const l of laps) console.log(lapSummary(l));
    generateRecordingVisualizations(recordingFile, laps, rawPackets);

    expect(laps.length).toBe(5);
    expect(laps.filter((l) => l.isValid).length).toBe(3);

    // All laps belong to the same session
    const sessionIds = new Set(laps.map((l) => l.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(laps.map((l) => l.lapNumber)).toEqual([0, 1, 2, 3, 4]);

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

    assertValidLapHasSectors(laps[1]);
    assertValidLapHasSectors(laps[2]);
    assertValidLapHasSectors(laps[3]);
    assertBrandHatchSectorBounds(laps[1]);
    assertBrandHatchSectorBounds(laps[2]);
    assertBrandHatchSectorBounds(laps[3]);
    assertSectorTimesMatchLapTime(laps[1]);
    assertSectorTimesMatchLapTime(laps[2]);
    assertSectorTimesMatchLapTime(laps[3]);
    assertLapTimesProper(laps[1].packets, laps[1].lapTime);
    assertLapTimesProper(laps[2].packets, laps[2].lapTime);
    assertLapTimesProper(laps[3].packets, laps[3].lapTime);

    // Lap 4: incomplete tail
    expect(laps[4].isValid).toBe(false);
    expect(laps[4].invalidReason).toBe("incomplete");

    // lap-saved notifications: lap 0 invalid, laps 1-3 valid with best lap tracking
    expect(lapSaved[0].lapNumber).toBe(0);
    expect(lapSaved[0].isValid).toBe(false);
    expect(lapSaved[1].lapNumber).toBe(1);
    expect(lapSaved[1].isValid).toBe(true);
    expect(lapSaved[1].estimatedBestLapTime).toBe(lapSaved[1].lapTime);
    expect(lapSaved[2].lapNumber).toBe(2);
    expect(lapSaved[2].isValid).toBe(true);
    expect(lapSaved[3].lapNumber).toBe(3);
    expect(lapSaved[3].isValid).toBe(true);
  });
});

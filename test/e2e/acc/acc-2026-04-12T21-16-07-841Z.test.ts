import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDump } from "../../support/recordings/parse-dump";
import { lapSummary, RECORDINGS_DIR } from "./shared";
import type { LapSavedNotification } from "../../../server/lap-detection/types"

const recordingFile = "acc-2026-04-12T21-16-07-841Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("detects laps correctly with no duplicates", async () => {
    if (!existsSync(recording)) return;

    const { laps, wsNotifications } = await parseDump("acc", recording, {
      capturePackets: false,
    });
    const lapSaved = wsNotifications.filter((notification): notification is LapSavedNotification => notification.type === "lap-saved");

    for (const l of laps) console.log(lapSummary(l));
    console.log(`lap-saved notifications: ${lapSaved.map((notification) => `lap${notification.lapNumber}`).join(", ")}`);

    expect(laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(lapSaved.map((notification) => notification.lapNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 120_000); // replays a full recorded UDP session through the pipeline; slow on CI
});

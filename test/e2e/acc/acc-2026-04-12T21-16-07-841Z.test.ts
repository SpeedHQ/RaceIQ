console.log = () => {};
import { describe, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { parseDump } from "../../helpers/parse-dump";
import { TestLogger } from "../../helpers/test-logger";
import { lapSummary, RECORDINGS_DIR } from "./shared";

const recordingFile = "acc-2026-04-12T21-16-07-841Z.bin";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("detects laps correctly with no duplicates", async () => {
    if (!existsSync(recording)) return;

    const log = new TestLogger(recordingFile);
    const { laps, wsNotifications } = await parseDump("acc", recording);
    const lapSaved = (wsNotifications as any[]).filter(n => n.type === "lap-saved");

    for (const l of laps) log.log(lapSummary(l));
    log.log(`lap-saved notifications: ${lapSaved.map((n: any) => `lap${n.lapNumber}`).join(", ")}`);
    log.flush();
  }, { timeout: 30000 });
});

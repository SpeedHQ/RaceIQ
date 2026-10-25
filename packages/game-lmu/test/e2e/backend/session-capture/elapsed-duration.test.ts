import { beforeAll, expect, test } from "bun:test";
import { LMU_TELEMETRY, LMU_TELEMETRY_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_INFO_OFFSET } from "@raceiq/capture-formats/lmu/layout";
import { encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { initServerGameAdapters } from "@raceiq/backend/test-support/games";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import { getRecordedElapsedSeconds } from "@raceiq/backend-core/session-capture/elapsed-duration";
import { playerMemory } from "../../../support/player-memory";
beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));
function lmuSourceFrame(captureTimestampMs: number, elapsedTime: number): Buffer {
  const memory = playerMemory();
  memory.writeDoubleLE(elapsedTime, LMU_TELEMETRY_INFO_OFFSET + LMU_TELEMETRY.elapsedTime);
  memory.writeDoubleLE(elapsedTime, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
  return encodeLMUSourceFrame(memory, captureTimestampMs)!;
}
test("prefers embedded LMU acquisition UTC over simulator elapsed clock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-lmu-"));
  try {
    const rawFile = join(directory, "lmu.bin");
    const first = lmuSourceFrame(1_790_111_999_401, 0);
    const last = lmuSourceFrame(1_790_112_004_402, 2);
    writeFileSync(rawFile, Buffer.concat([
      encodeMetaFrame(2), encodeSparseCaptureFormatFrame(),
      encodeFrameLength(first.length), first, encodeFrameLength(last.length), last,
    ]));
    expect(await getRecordedElapsedSeconds({
      rawFile, source: null, gameId: "lmu", carId: "", trackId: "",
    })).toBe(5.001);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDump } from "../../support/recordings/parse-dump";
import { assertBrandHatchSectorBounds, lapSummary, RECORDINGS_DIR } from "./shared";
import { assertValidLapHasSectors } from "../../support/laps/assertions";

const recordingFile = "acc-2026-04-12T21-44-38-899Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(recordingFile, () => {
  test("pit-only opening segment discarded, outlap is lap 0", async () => {
    if (!existsSync(recording)) return;

    const { laps, rawPackets } = await parseDump("acc", recording);
    for (const l of laps) console.log(lapSummary(l));

    // Raw recording started in pit box — confirms discard logic fired correctly
    expect(rawPackets[0].acc?.pitStatus).not.toBe("out");

    // 3 laps: outlap + valid + incomplete (pit-only opening segment discarded)
    expect(laps.length).toBe(3);

    // Lap 0: structurally valid out lap (was lap 1 before the pit-only opening segment was discarded)
    expect(laps[0].isValid).toBe(true);
    expect(laps[0]).toMatchObject({ phase: "out", conditions: ["caution"], paceEligibility: "excluded" });
    expect(laps[0].invalidReason).toBeNull();
    expect(laps[0].packets[0].acc?.pitStatus).not.toBe("out");
    assertBrandHatchSectorBounds(laps[0]);

    // Lap 1: clean lap
    expect(laps[1].isValid).toBe(true);
    assertValidLapHasSectors(laps[1]);
    expect(laps[1].sectors).toHaveLength(3);
    assertBrandHatchSectorBounds(laps[1]);

    // Lap 2: incomplete tail
    expect(laps[2].isValid).toBe(false);
    expect(laps[2].invalidReason).toBe("incomplete");
  }, 300_000); // replays a full recorded UDP session; full-suite CPU contention can exceed 120s
});

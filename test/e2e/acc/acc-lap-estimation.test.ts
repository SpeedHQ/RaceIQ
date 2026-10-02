import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LiveSectorData } from "../../../shared/racing/live/types";
import { SectorTracker } from "../../../server/live-strategy/sector-tracker";
import { parseDump } from "../../support/recordings/parse-dump";
import { RECORDINGS_DIR } from "./shared";

const recordingFile = "acc-2026-04-10T02-59-28-972Z.bin.gz";
const recording = join(RECORDINGS_DIR, recordingFile);

describe(`${recordingFile} lap estimation`, () => {
  test("projects slower following lap delta at multiple positions", async () => {
    if (!existsSync(recording)) return;

    const { laps } = await parseDump("acc", recording);
    const reference = laps[2];
    const target = laps[3];
    if (!reference || !target || !reference.isValid || !target.isValid) {
      throw new Error("Fixture missing required valid reference and target laps");
    }

    const tracker = new SectorTracker();
    await tracker.reset(
      target.packets[0]!.TrackOrdinal,
      "acc",
      target.packets[0]!.CarOrdinal,
    );
    tracker.updateRefLap(reference.packets, reference.lapTime, reference.sectors);
    tracker.feed(reference.packets[0]!);

    const targetStart = target.packets[0]!.DistanceTraveled;
    const targetEnd = target.packets.at(-1)!.DistanceTraveled;
    const targetLength = targetEnd - targetStart;
    const checkpoints = [0.25, 0.5, 0.75];
    const checkpointResults = checkpoints.map(() => ({
      result: null as LiveSectorData | null,
      distance: Infinity,
    }));
    let finalResult: LiveSectorData | null = null;

    for (const packet of target.packets) {
      const result = tracker.feed(packet);
      if (!result || result.estimatedLap <= 0) continue;
      finalResult = result;
      const progress = (packet.DistanceTraveled - targetStart) / targetLength;
      for (const [index, checkpoint] of checkpoints.entries()) {
        const distance = Math.abs(progress - checkpoint);
        if (distance < checkpointResults[index]!.distance) {
          checkpointResults[index] = { result, distance };
        }
      }
    }

    expect(target.lapTime).toBeGreaterThan(reference.lapTime);
    expect(finalResult).not.toBeNull();
    expect(finalResult!.estimatedLap).toBeCloseTo(target.lapTime, 0);
    for (const { result } of checkpointResults) {
      expect(result).not.toBeNull();
      expect(result!.bestLapTime).toBeCloseTo(reference.lapTime, 3);
      expect(result!.deltaToBest).toBeGreaterThan(0);
      expect(result!.estimatedLap).toBeGreaterThan(reference.lapTime);
    }
  }, 300_000);
});

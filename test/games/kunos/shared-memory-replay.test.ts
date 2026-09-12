import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcEvoSharedMemoryReader } from "../../../server/games/ac-evo/shared-memory";
import { ACEVO_STATUS, GRAPHICS_EVO } from "../../../server/games/ac-evo/structs";
import { AccSharedMemoryReader } from "../../../server/games/acc/shared-memory";
import { AC_STATUS, GRAPHICS } from "../../../server/games/acc/structs";
import { readKunosFrames } from "../../../server/games/kunos/frame-reader";
import { KunosRecorder } from "../../../server/games/kunos/recorder";
import type { Triplet, TripletProcessor } from "../../../server/games/kunos/triplet-pipeline";
import { ReplayedKunosMemoryReader } from "../../support/recordings/replayed-kunos-memory-reader";

const ACC_FIXTURE =
  "test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz";
const AC_EVO_FIXTURE =
  "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";

function acceptedFrames(
  path: string,
  statusOffset: number,
  live: number,
  paused: number,
): Triplet[] {
  return readKunosFrames(path)
    .filter((frame) => {
      const status = frame.graphics.readInt32LE(statusOffset);
      return status === live || status === paused;
    })
    .slice(0, 5);
}

function semanticTripwire(onCall: () => void): TripletProcessor {
  return {
    async process(): Promise<undefined> {
      onCall();
      throw new Error("semantic parser entered diagnostic recording mode");
    },
  };
}


describe("Kunos diagnostic recording through reconstructed shared memory", () => {
  test("replays historical ACC pages through AccSharedMemoryReader", async () => {
    const input = acceptedFrames(
      ACC_FIXTURE,
      GRAPHICS.status.offset,
      AC_STATUS.AC_LIVE,
      AC_STATUS.AC_PAUSE,
    );
    expect(input).toHaveLength(5);

    const dir = mkdtempSync(join(tmpdir(), "raceiq-acc-shared-memory-"));
    const memoryReader = new ReplayedKunosMemoryReader(input);
    const recorder = new KunosRecorder();
    let semanticCalls = 0;
    const reader = new AccSharedMemoryReader({
      recordingEnabled: true,
      memoryReader,
      recorder,
      recordingDir: dir,
      parser: semanticTripwire(() => semanticCalls++),
      enableMetrics: false,
    });

    try {
      reader.start();
      try {
        await memoryReader.exhausted;
      } finally {
        await reader.stop();
      }

      expect(readKunosFrames(recorder.path!)).toEqual(input);
      expect(semanticCalls).toBe(0);
      expect(reader.running).toBe(false);
      expect(reader.connected).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replays historical AC Evo pages through AcEvoSharedMemoryReader", async () => {
    const input = acceptedFrames(
      AC_EVO_FIXTURE,
      GRAPHICS_EVO.status.offset,
      ACEVO_STATUS.AC_LIVE,
      ACEVO_STATUS.AC_PAUSE,
    );
    expect(input).toHaveLength(5);

    const dir = mkdtempSync(join(tmpdir(), "raceiq-ac-evo-shared-memory-"));
    const memoryReader = new ReplayedKunosMemoryReader(input);
    const recorder = new KunosRecorder();
    let semanticCalls = 0;
    const reader = new AcEvoSharedMemoryReader({
      recordingEnabled: true,
      memoryReader,
      recorder,
      recordingDir: dir,
      parser: semanticTripwire(() => semanticCalls++),
      enableMetrics: false,
    });

    try {
      reader.start();
      try {
        await memoryReader.exhausted;
      } finally {
        await reader.stop();
      }

      expect(readKunosFrames(recorder.path!)).toEqual(input);
      expect(semanticCalls).toBe(0);
      expect(reader.running).toBe(false);
      expect(reader.connected).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

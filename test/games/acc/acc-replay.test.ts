import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { KunosRecordingFrame } from "../../../server/games/kunos/frame-reader";
import * as RealFrameReader from "../../../server/games/kunos/frame-reader";
import * as RealParser from "../../../server/games/acc/parser";
import * as RealLivePipeline from "../../../server/telemetry/live-pipeline";
// Bun mutates imported namespace bindings after mock.module registration.
// Capture real values first so process-global wrappers can delegate without recursing.
const realReadKunosFrames = RealFrameReader.readKunosFrames;
const realParseAccBuffers = RealParser.parseAccBuffers;
const realProcessPacket = RealLivePipeline.processPacket;
const realLapDetector = RealLivePipeline.lapDetector;
const realStopMaintenanceTasks = RealLivePipeline.stopMaintenanceTasks;

const frame: KunosRecordingFrame = {
  physics: Buffer.alloc(1),
  graphics: Buffer.alloc(1),
  staticData: Buffer.alloc(688),
  timestampMS: 0,
};

let useReplayMocks = true;
const readKunosFramesMock = mock((_filePath: string, _limit?: number) => [frame]);
const parseAccBuffersMock = mock(
  (_physics: Buffer, _graphics: Buffer, _staticData: Buffer, overrides?: Parameters<typeof RealParser.parseAccBuffers>[3]) => ({ TimestampMS: overrides?.timestampMS ?? 0 }) as TelemetryPacket,
);
const processPacketMock = mock(async (_packet: TelemetryPacket, _sourceFrame?: Buffer): Promise<void> => {});
const finalizeCurrentSessionMock = mock(async (): Promise<void> => {});

mock.module("../../../server/games/kunos/frame-reader", () => ({
  ...RealFrameReader,
  readKunosFrames: (...args: Parameters<typeof RealFrameReader.readKunosFrames>) => (useReplayMocks ? readKunosFramesMock(...args) : realReadKunosFrames(...args)),
}));

mock.module("../../../server/games/acc/parser", () => ({
  ...RealParser,
  parseAccBuffers: (...args: Parameters<typeof RealParser.parseAccBuffers>) => (useReplayMocks ? parseAccBuffersMock(...args) : realParseAccBuffers(...args)),
}));

mock.module("../../../server/telemetry/live-pipeline", () => ({
  ...RealLivePipeline,
  processPacket: (...args: Parameters<typeof RealLivePipeline.processPacket>) => (useReplayMocks ? processPacketMock(...args) : realProcessPacket(...args)),
  lapDetector: {
    get session() {
      return realLapDetector.session;
    },
    get fuelHistory() {
      return realLapDetector.fuelHistory;
    },
    get tireWearHistory() {
      return realLapDetector.tireWearHistory;
    },
    async finalizeCurrentSession(): Promise<void> {
      if (useReplayMocks) {
        await finalizeCurrentSessionMock();
        return;
      }
      await realLapDetector.finalizeCurrentSession();
    },
  },
}));

// Module mocks must register before replay binds its static dependencies.
const { replayRecording } = await import("../../../server/games/acc/replay");

beforeEach(() => {
  useReplayMocks = true;
  readKunosFramesMock.mockClear();
  parseAccBuffersMock.mockClear();
  processPacketMock.mockClear();
  finalizeCurrentSessionMock.mockClear();
  processPacketMock.mockImplementation(async () => {});
  finalizeCurrentSessionMock.mockImplementation(async () => {});
});

afterAll(() => {
  useReplayMocks = false;
  realStopMaintenanceTasks();
});

describe("ACC replay session boundaries", () => {
  test("finalizes exactly once between loop passes", async () => {
    const events: string[] = [];
    let releaseFirstPacket!: () => void;
    const firstPacketGate = new Promise<void>((resolve) => {
      releaseFirstPacket = resolve;
    });
    let resolveSecondPacket!: () => void;
    const secondPacketSeen = new Promise<void>((resolve) => {
      resolveSecondPacket = resolve;
    });
    let stopReplay: (() => void) | null = null;

    processPacketMock.mockImplementation(async () => {
      events.push("packet");
      if (processPacketMock.mock.calls.length === 1) {
        await firstPacketGate;
      } else if (processPacketMock.mock.calls.length === 2) {
        stopReplay?.();
        resolveSecondPacket();
      }
    });
    finalizeCurrentSessionMock.mockImplementation(async () => {
      events.push("finalize");
    });

    const replay = await replayRecording("mock.bin", { loop: true, speed: 1 });
    stopReplay = replay.stop;
    releaseFirstPacket();
    await secondPacketSeen;
    await Promise.resolve();

    expect(replay.frameCount).toBe(1);
    expect(finalizeCurrentSessionMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["packet", "finalize", "packet"]);
  });

  test("does not finalize after one-shot playback", async () => {
    let releasePacket!: () => void;
    const packetGate = new Promise<void>((resolve) => {
      releasePacket = resolve;
    });
    let resolvePacketStarted!: () => void;
    const packetStarted = new Promise<void>((resolve) => {
      resolvePacketStarted = resolve;
    });
    processPacketMock.mockImplementation(async () => {
      resolvePacketStarted();
      await packetGate;
    });

    const replay = await replayRecording("mock.bin", { loop: false, speed: 1 });
    await packetStarted;
    releasePacket();
    await Promise.resolve();
    await Promise.resolve();

    expect(replay.frameCount).toBe(1);
    expect(processPacketMock).toHaveBeenCalledTimes(1);
    expect(finalizeCurrentSessionMock).not.toHaveBeenCalled();
  });
});

import { expect, test } from "bun:test";
import { ensureInit, readUdpPackets } from "../support/recordings/parse-dump";
import { runLiveEngineerSessionReplay } from "../../server/live-strategy/live-engineer-replay";

ensureInit();

const RECORDING = "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";

test("F1 recording classifies completed laps against recent race pace", () => {
  // This capture contains qualifying followed by a race. Replay one native session
  // so qualifying lap state cannot become the race's baseline.
  const packets = readUdpPackets(RECORDING, "f1-2025").packets
    .filter((packet) => packet.sessionUID === "1678828670943386641")
    .filter((_, index) => index % 500 === 0);
  expect(packets.every((packet) => packet.f1?.sessionType === "race")).toBe(true);
  expect(packets.some((packet) => packet.f1?.grid.some((entry) =>
    !entry.isPlayer && entry.lastLapValid && (entry.completedLapNumber ?? 0) >= 3,
  ))).toBe(true);

  const replay = runLiveEngineerSessionReplay({
    session: { id: 1, gameId: "f1-2025" },
    laps: [],
    packets,
    sourceProfile: {
      gameId: "f1-2025",
      captureKind: "test",
      limitations: [],
      sourceClockCaptured: true,
      opponentSourceCapture: null,
      segmentCount: 1,
      skippedMalformedFrames: 0,
      nativeSessionInfo: false,
      retainedPrefix: true,
    },
    scenario: "f1-opponent-lap-pace",
  });

  const firstFrameValues = replay.frames[0]?.values ?? {};
  expect(Object.keys(firstFrameValues)).toEqual(expect.arrayContaining([
    "inputs.accel",
    "inputs.brake",
    "inputs.steer",
    "inputs.gear",
    "engine.current-engine-rpm",
    "fuel.fuel",
    "brakes.brake-bias",
    "tires.tire-pressure",
    "suspension.suspension-travel-m",
  ]));
  const paceCallouts = replay.annotations.filter(
    (annotation) => annotation.stage === "callout" && annotation.family === "opponent-pace",
  );
  expect(paceCallouts).toEqual(expect.arrayContaining([
    expect.objectContaining({
      payload: expect.objectContaining({
        parameters: expect.objectContaining({
          relation: "fastest-in-class",
          scope: "overall",
          benchmarkKind: "recent-race-pace",
        }),
      }),
    }),
  ]));
  expect(replay.sourceCounts.packets).toBe(packets.length);
});

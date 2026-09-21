import { expect, test } from "bun:test";
import { ensureInit, readUdpPackets } from "../support/recordings/parse-dump";
import { runLiveEngineerSessionReplay } from "../../server/live-strategy/live-engineer-replay";

ensureInit();

const RECORDING = "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";

test("F1 recording drives opponent-lap pace replay scenario", () => {
  const packets = readUdpPackets(RECORDING, "f1-2025").packets.filter((_, index) => index % 500 === 0);
  expect(packets.length).toBeGreaterThan(100);
  expect(packets.some((packet) => (packet.f1?.grid.length ?? 0) > 1)).toBe(true);
  expect(packets.some((packet) => packet.f1?.grid.some((entry) => (entry.completedLapNumber ?? 0) > 0))).toBe(true);

  const replay = runLiveEngineerSessionReplay({
    session: { id: 1, gameId: "f1-2025" },
    laps: [],
    packets,
    sourceProfile: {
      gameId: "f1-2025",
      captureKind: "test",
      limitations: [],
      sourceClockCaptured: true,
      segmentCount: 1,
      skippedMalformedFrames: 0,
      nativeSessionInfo: false,
      retainedPrefix: true,
    },
    scenario: "f1-opponent-lap-pace",
  });

  const paceCallouts = replay.annotations.filter(
    (annotation) => annotation.stage === "callout" && annotation.family === "opponent-pace",
  );
  expect(paceCallouts.length).toBeGreaterThan(0);
  expect(paceCallouts[0]?.payload).toMatchObject({
    parameters: {
      relation: "off-class-pace",
      benchmarkKind: "session-best",
    },
  });
  expect(paceCallouts[0]?.renderedText).toContain("off overall pace");
  expect(replay.sourceCounts.packets).toBe(packets.length);
});

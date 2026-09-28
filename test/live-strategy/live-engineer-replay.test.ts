import { expect, test } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LiveEngineerReplaySourceProfileV1 } from "../../shared/racing/live/engineer-replay-contracts";
import { runLiveEngineerSessionReplay } from "../../server/live-strategy/live-engineer-replay";

const profile = (gameId: "fm-2023" | "acc", captured = false): LiveEngineerReplaySourceProfileV1 => ({
  gameId, captureKind: "capture", limitations: [], sourceClockCaptured: captured,
  opponentSourceCapture: gameId === "acc" ? { source: "acc-broadcast", status: captured ? "captured" : "unavailable", recordCount: captured ? 3 : 0 } : null,
  segmentCount: 1, skippedMalformedFrames: 0, nativeSessionInfo: false, retainedPrefix: true,
});

test("replay availability retains loss and recovery at their original frames", () => {
  const packets = [1, 2, undefined, 3, 4].map((lap, index) => ({
    gameId: "fm-2023", TimestampMS: index * 10, LapNumber: lap, Speed: 20,
  } as TelemetryPacket));
  const replay = runLiveEngineerSessionReplay({ session: { id: 1, gameId: "fm-2023" }, laps: [], packets, sourceProfile: profile("fm-2023") });
  const lapCounter = replay.systems.find((system) => system.systemId === "crewchief:LapCounter")!;
  expect(lapCounter.transitions.map(({ frameIndex, lifecycle }) => [frameIndex, lifecycle])).toEqual([
    [0, "baseline"], [1, "ready"], [2, "unavailable"], [3, "baseline"], [4, "ready"],
  ]);
  expect(replay.frames.map((frame) => frame.values["timing.lap-number"])).toEqual([1, 2, null, 3, 4]);
  expect(replay.frames.map((frame) => frame.states["timing.lap-number"])).toEqual(["ok", "ok", "missing", "ok", "ok"]);
  expect(replay.frames[0]!.freshness["timing.lap-number"]).toBe("fresh");
});

test("captured ACC replay preserves wall clock deltas and source loss evidence", () => {
  const times = [1_800_000_000_000, 1_800_000_000_017, 1_800_000_001_250];
  const sources = [
    { source: "acc-broadcast", state: "available", reasonCode: "ready" },
    { source: "acc-broadcast", state: "stale", reasonCode: "source-timeout" },
    { source: "acc-broadcast", state: "malformed", reasonCode: "sequence-gap" },
  ] as const;
  const packets = times.map((TimestampMS, index) => ({
    gameId: "acc", TimestampMS, LapNumber: 1, Speed: 20,
    acc: { broadcastSource: sources[index], broadcastPlayerCarIndex: index === 0 ? 7 : undefined },
  } as TelemetryPacket));
  const replay = runLiveEngineerSessionReplay({ session: { id: 1, gameId: "acc" }, laps: [], packets, sourceProfile: profile("acc", true) });
  expect(replay.clockQuality).toBe("captured");
  expect(replay.frames.map((frame) => frame.timelineMs)).toEqual([0, 17, 1250]);
  expect(replay.frames.map((frame) => frame.rawSourceTimestampMs)).toEqual(times);
  expect(replay.frames.map((frame) => frame.rawSourceTimestampDomain)).toEqual(["wall-clock", "wall-clock", "wall-clock"]);
  expect(replay.frames.map((frame) => frame.opponentSource)).toEqual([...sources]);
  expect(replay.frames[0]!.values["identity.player-car-index"]).toBe(7);
  expect(replay.frames[1]!.values["identity.player-car-index"]).toBeNull();
  expect(replay.frames[1]!.states["identity.player-car-index"]).toBe("missing");
});

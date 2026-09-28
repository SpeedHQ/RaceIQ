import { expect, test } from "bun:test";
import type { SemanticReplayFrame } from "../../client/src/hooks/laps";
import { replayLapTimes } from "../../client/src/lib/replay-clock";

function frame(lap: number, captureTimeMs?: number): SemanticReplayFrame {
  return {
    sequence: 0,
    observedAt: { domain: "wall-clock", milliseconds: captureTimeMs ?? 0 },
    receivedAt: { domain: "wall-clock", milliseconds: 0 },
    simulator: "f1-2025",
    values: [{ semanticId: "timing.current-lap", value: lap }],
    ...(captureTimeMs === undefined ? {} : { captureTimeMs }),
  };
}

test("capture pause does not stretch analyse replay, while ordinary timing remains intact", () => {
  const frames = [frame(10, 1000), frame(10.05, 1050), frame(15.05, 6050), frame(15.1, 6100)];
  expect(replayLapTimes(frames).map((time) => Number(time.toFixed(2)))).toEqual([10, 10.05, 10.15, 10.2]);
  expect(frames[2]!.values[0]!.value).toBe(15.05);
  expect(frames[2]!.captureTimeMs).toBe(6050);
  expect(replayLapTimes([frame(10), frame(15), frame(15.05)])).toEqual([10, 15, 15.05]);
  expect(replayLapTimes([frame(10, 1000), frame(10.05, 1050), frame(10.1, 6050)])).toEqual([10, 10.05, 10.1]);
});

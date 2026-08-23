import { describe, expect, test } from "bun:test";
import { SpotterTracker } from "../../server/live-strategy/spotter-tracker";
import type { SpotterFrameV1 } from "../../shared/racing/live/spotter-contracts";

const frame = (time: number, opponents: SpotterFrameV1["opponents"], extra: Partial<SpotterFrameV1> = {}): SpotterFrameV1 => ({ sessionId: "s", timelineEpoch: 1, sourceSequence: time, sessionTimeMs: time, player: { x: 0, z: 0, rotationRad: 0, speedMps: 20, widthM: 1.8, lengthM: 4.8 }, opponents, ...extra });

describe("CrewChief-style spotter tracker", () => {
  test("announces entry, repeats still there, then clears after hysteresis", () => {
    const tracker = new SpotterTracker();
    expect(tracker.update(frame(0, [{ id: "a", x: 2.2, z: -1 }])).map((x) => x.state)).toEqual(["car-left"]);
    expect(tracker.update(frame(2_999, [{ id: "a", x: 2.2, z: -1 }]))).toHaveLength(0);
    expect(tracker.update(frame(3_000, [{ id: "a", x: 2.2, z: -1 }])).map((x) => x.state)).toEqual(["still-there"]);
    expect(tracker.update(frame(3_200, [])).map((x) => x.state)).toEqual([]);
    expect(tracker.update(frame(3_700, [])).map((x) => x.state)).toEqual(["clear-left"]);
  });

  test("detects three-wide only when two cars are separated on one side", () => {
    const tracker = new SpotterTracker();
    expect(tracker.update(frame(0, [{ id: "a", x: 2.2, z: -1 }, { id: "b", x: 4.5, z: 1 }])).map((x) => x.state)).toEqual(["car-left"]);
    expect(tracker.update(frame(3_000, [{ id: "a", x: 2.2, z: -1 }, { id: "b", x: 4.5, z: 1 }])).map((x) => x.state)).toEqual(["three-wide-left"]);
  });

  test("suppresses formation, caution, pit, and low-speed frames", () => {
    const tracker = new SpotterTracker();
    expect(tracker.update(frame(0, [{ id: "a", x: 2.2, z: -1 }], { formationLap: true }))).toEqual([]);
    expect(tracker.update(frame(1, [{ id: "a", x: 2.2, z: -1 }], { cautionContext: true }))).toEqual([]);
    expect(tracker.update(frame(2, [{ id: "a", x: 2.2, z: -1 }], { pitContext: true }))).toEqual([]);
  });
});

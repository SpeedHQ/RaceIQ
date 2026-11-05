import { describe, expect, test } from "bun:test";
import { distanceRangeToTimeRange } from "../../ui/corner-focus-band";
import type { SpectateLap, SpectateSample } from "../../contracts";

function lap(samples: SpectateSample[], motionSamples?: SpectateSample[]): SpectateLap {
  return {
    samples,
    motionSamples,
    duration: samples.at(-1)?.time ?? 0,
    distance: Math.max(...samples.map((sample) => sample.distance).filter((distance) => Number.isFinite(distance))),
    hasProgress: true,
    replay: {},
  } as unknown as SpectateLap;
}

const sample = (time: number, distance: number, run = 0): SpectateSample => ({ time, distance, run, values: {} });

describe("corner focus chart band", () => {
  test("interpolates entry and exit times from recorded distance", () => {
    const loaded = lap([sample(0, 0), sample(1, 100), sample(2, 200), sample(3, 300)]);
    expect(distanceRangeToTimeRange(loaded, { start: 50, end: 150 })).toEqual({ start: 0.5, end: 1.5 });
  });

  test("uses the earliest arrival across a distance plateau", () => {
    const loaded = lap([sample(0, 0), sample(1, 100), sample(2, 100), sample(3, 200)]);
    expect(distanceRangeToTimeRange(loaded, { start: 100, end: 150 })).toEqual({ start: 1, end: 2.5 });
  });

  test("does not bridge a recording run or telemetry gap", () => {
    const runBreak = lap([sample(0, 0), sample(1, 100), sample(5, 200, 1)]);
    expect(distanceRangeToTimeRange(runBreak, { start: 50, end: 150 })).toBeNull();
  });

  test("returns null when the range is outside the recorded distance", () => {
    const loaded = lap([sample(0, 0), sample(1, 100), sample(2, 200)]);
    expect(distanceRangeToTimeRange(loaded, { start: 250, end: 300 })).toBeNull();
    expect(distanceRangeToTimeRange(loaded, { start: -100, end: -50 })).toBeNull();
  });

  test("prefers distinct motion samples when present", () => {
    const loaded = lap(
      [sample(0, 0), sample(1, 100), sample(2, 200)],
      [sample(0, 0), sample(4, 200)],
    );
    expect(distanceRangeToTimeRange(loaded, { start: 50, end: 150 })).toEqual({ start: 1, end: 3 });
  });
});

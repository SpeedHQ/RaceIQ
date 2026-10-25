import { describe, expect, test } from "bun:test";
import { buildSegmentData } from "../../ui/AnalyseSegmentList";
import type { SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";

const frame = (values: Record<string, unknown>): SemanticAnalysisFrame => ({ values, states: {}, freshness: {} });

describe("iRacing Analyse grouped segments", () => {
  test("combines start/finish ranges split by lap boundary", () => {
    const telemetry = Array.from({ length: 101 }, (_, index) =>
      frame({ "timing.distance-traveled": 7000 + index * 20, "timing.current-lap": index * 0.5 }),
    );
    const segments = [
      { type: "straight", name: "Front straight", group: "Main straight", startFrac: 0, endFrac: 0.1 },
      { type: "corner", name: "T1", startFrac: 0.1, endFrac: 0.3 },
      { type: "straight", name: "Back straight", group: "Main straight", startFrac: 0.9, endFrac: 1 },
    ];

    const result = buildSegmentData(telemetry, segments);
    expect(result?.staticSegments.map((segment) => segment.name)).toEqual(["Main straight", "T1"]);
    expect(result?.staticSegments[0].ranges).toHaveLength(2);
  });
});

describe("partial native opponent segments", () => {
  const telemetry = () => Array.from({ length: 101 }, (_, index) => ({
    ...frame({ "timing.distance-traveled": 2000 + index * 10, "timing.current-lap": index * 0.2 }),
    run: 0,
  }));
  const segments = [
    { type: "corner", name: "Unrecorded", startFrac: 0.1, endFrac: 0.2 },
    { type: "corner", name: "Recorded", startFrac: 0.551, endFrac: 0.626 },
    { type: "corner", name: "Recording start", startFrac: 0.5, endFrac: 0.55 },
  ];

  test("uses circuit distance, interpolates recorded boundaries, and leaves uncovered segments unavailable", () => {
    const result = buildSegmentData(telemetry(), segments, 4000)!;
    expect(result.cumDist[0]).toBe(2000);
    expect(result.totalDist).toBe(4000);
    expect(result.staticSegments[0].time).toBeNull();
    expect(result.staticSegments[1].time).toBeCloseTo(6);
    expect(result.staticSegments[2].time).toBeCloseTo(4);
  });

  test("does not interpolate a boundary across an invalid native distance", () => {
    const samples = telemetry();
    samples[21] = { ...samples[21], values: { ...samples[21].values, "timing.distance-traveled": null } };
    expect(buildSegmentData(samples, segments, 4000)!.staticSegments[1].time).toBeNull();
    expect(buildSegmentData(samples, segments, 4000)!.staticSegments[2].time).toBeCloseTo(4);
  });

  test("does not time a segment across a source continuity gap", () => {
    const samples = telemetry().map((sample, index) => ({ ...sample, run: index < 40 ? 0 : 1 }));
    expect(buildSegmentData(samples, segments, 4000)!.staticSegments[1].time).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { adaptComparisonToFindings } from "../../server/findings/comparison-adapter";
import type { AlignedTrace, ComparisonResult } from "../../server/lap-analysis/comparison";

function trace(sourceIndices: number[]): AlignedTrace {
  const length = sourceIndices.length;
  return {
    speed: Array(length).fill(100),
    throttle: Array(length).fill(1),
    brake: Array(length).fill(0),
    steer: Array(length).fill(0),
    rpm: Array(length).fill(7000),
    gear: Array(length).fill(4),
    posX: Array.from({ length }, (_, index) => index),
    posZ: Array(length).fill(0),
    elapsedTime: Array.from({ length }, (_, index) => index / 10),
    tireWear: Array(length).fill(0),
    fuel: Array(length).fill(20),
    sourceIndices,
  };
}

const result: ComparisonResult = {
  distances: [0, 1, 2, 3, 4, 5, 6, 7],
  lapA: trace([10, 11, 12, 20, 21, 22, 23, 24]),
  lapB: trace([30, 31, 32, 40, 41, 42, 43, 44]),
  timeDelta: [0, -0.05, -0.1, -0.1, -0.12, -0.15, -0.18, -0.2],
  cornerDeltas: [{
    label: "T1",
    deltaSeconds: -0.1,
    timeA: 0.2,
    timeB: 0.3,
    distanceStart: 0,
    distanceEnd: 2,
    alignedStartIndex: 0,
    alignedEndIndex: 2,
    sourceStartIndexA: 10,
    sourceEndIndexA: 12,
    sourceStartIndexB: 30,
    sourceEndIndexB: 32,
  }, {
    label: "T2",
    deltaSeconds: -0.1,
    timeA: 0.4,
    timeB: 0.5,
    distanceStart: 3,
    distanceEnd: 7,
    alignedStartIndex: 3,
    alignedEndIndex: 7,
    sourceStartIndexA: 20,
    sourceEndIndexA: 24,
    sourceStartIndexB: 40,
    sourceEndIndexB: 44,
  }],
};

describe("adaptComparisonToFindings", () => {
  test("uses each corner range for A/B evidence and measurement sample counts", () => {
    const findings = adaptComparisonToFindings({
      sessionId: 7,
      sessionAId: 7,
      sessionBId: 9,
      lapAId: 41,
      lapBId: 52,
      result,
    });

    const ranges = findings.map((finding) => finding.evidenceRefs.filter((evidence) => evidence.kind === "telemetry-range"));
    expect(ranges[0]).toEqual([
      expect.objectContaining({ sessionId: "7", startFrameIndex: 10, endFrameIndex: 12 }),
      expect.objectContaining({ sessionId: "9", startFrameIndex: 30, endFrameIndex: 32 }),
    ]);
    expect(ranges[1]).toEqual([
      expect.objectContaining({ sessionId: "7", startFrameIndex: 20, endFrameIndex: 24 }),
      expect.objectContaining({ sessionId: "9", startFrameIndex: 40, endFrameIndex: 44 }),
    ]);
    expect(findings.map((finding) => finding.measurements.map((measurement) => measurement.sampleCount))).toEqual([
      [3, 3, 3],
      [5, 5, 5],
    ]);
    expect(ranges[0]).not.toEqual(ranges[1]);
  });
});

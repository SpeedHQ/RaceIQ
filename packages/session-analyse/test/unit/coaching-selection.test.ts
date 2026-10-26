import { expect, test } from "bun:test";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { selectCoachingPriorities, type CoachingLap } from "../../server/coaching-selection";

function finding(id: string, frameIndices: number[]): LapInsight {
  return { id, category: "driving", severity: "info", label: id, detail: "fixture", frameIndices };
}

function lap(
  lapId: number,
  lapNumber: number,
  insights: LapInsight[],
  fractions: ReadonlyMap<number, number>,
): CoachingLap {
  return {
    lapId,
    lapNumber,
    insights,
    fractionAtSourceFrame: (frame) => fractions.get(frame) ?? null,
    cornerAtFraction: () => null,
  };
}

test("selection ranks ties by family and returns deterministic representative from distinct laps", () => {
  const ids = ["driving-brake-drag", "driving-downshift-over-rev", "driving-steering-sawing", "driving-early-throttle"];
  const fractions = new Map([[1, 0.1], [2, 0.3], [3, 0.5], [4, 0.7]]);
  const laps = [
    lap(12, 1, ids.map((id, index) => finding(id, [index + 1])), fractions),
    lap(11, 1, ids.map((id, index) => finding(id, [index + 1])), fractions),
  ];

  const result = selectCoachingPriorities(laps);
  expect(result.items.map(({ id, supportingLapCount, evidencePointCount, evidenceLevel }) => ({
    id, supportingLapCount, evidencePointCount, evidenceLevel,
  }))).toEqual([
    { id: "brake-drag:5", supportingLapCount: 2, evidencePointCount: 2, evidenceLevel: "repeated" },
    { id: "downshift:15", supportingLapCount: 2, evidencePointCount: 2, evidenceLevel: "repeated" },
    { id: "steering:25", supportingLapCount: 2, evidencePointCount: 2, evidenceLevel: "repeated" },
  ]);
  expect(result.items[0]!.representative).toEqual({ lapId: 11, lapNumber: 1, sourceFrameIndex: 1 });
});

test("selection merges family signals, deduplicates identical frames and greedily excludes occupied buckets", () => {
  const lapData = lap(21, 4, [
    finding("driving-early-throttle", [1]),
    finding("driving-binary-throttle", [1]),
    finding("driving-throttle-micro-lifts", [2]),
    finding("driving-steering-sawing", [3]),
    finding("driving-downshift-over-rev", [4]),
  ], new Map([[1, 0.245], [2, 0.249], [3, 0.24], [4, 0.4]]));

  const result = selectCoachingPriorities([lapData]);
  expect(result.items.map(({ id, evidencePointCount }) => ({ id, evidencePointCount }))).toEqual([
    { id: "throttle:12", evidencePointCount: 2 },
    { id: "downshift:20", evidencePointCount: 1 },
  ]);
});

test("selection keeps exact bucket boundaries and rejects invalid source locations", () => {
  const fractions = new Map<number, number>([
    [0, 0], [1, 0.019999], [2, 0.02], [3, 0.999], [5, Number.NaN], [6, -0.01], [7, 1.001],
  ]);
  const findings = [
    finding("driving-brake-drag", [0, 1, 5, 6, 7, 8, 1.5]),
    finding("driving-downshift-over-rev", [2]),
    finding("driving-steering-sawing", [3]),
  ];
  const result = selectCoachingPriorities([lap(31, 2, findings, fractions)]);

  expect(result.unlocatedEvidenceCount).toBe(5);
  expect(result.items.map(({ id, location, representative }) => ({ id, fraction: location.fraction, frame: representative.sourceFrameIndex }))).toEqual([
    { id: "brake-drag:0", fraction: 0, frame: 0 },
    { id: "downshift:1", fraction: 0.02, frame: 2 },
    { id: "steering:49", fraction: 0.999, frame: 3 },
  ]);
});

test("representative prefers lowest lap number, then lap ID, then original source index", () => {
  const result = selectCoachingPriorities([
    lap(40, 3, [finding("driving-brake-drag", [5])], new Map([[5, 0.5]])),
    lap(42, 1, [finding("driving-brake-drag", [8])], new Map([[8, 0.501]])),
    lap(41, 1, [finding("driving-brake-drag", [3])], new Map([[3, 0.519]])),
  ]);

  expect(result.items[0]).toMatchObject({
    id: "brake-drag:25",
    supportingLapCount: 3,
    evidencePointCount: 3,
    location: { fraction: 0.519, cornerName: null },
    representative: { lapId: 41, lapNumber: 1, sourceFrameIndex: 3 },
  });
});

test("selection preserves curated locations and assigns fraction one to final bucket", () => {
  const fractions = new Map([[1, 1], [2, 0.4]]);
  const lapData: CoachingLap = {
    ...lap(50, 1, [
      finding("driving-brake-drag", [1]),
      finding("driving-downshift-over-rev", [2]),
      finding("driving-abs-activity", [3]),
    ], fractions),
    cornerAtFraction: (fraction) => fraction === 1 ? "Final Chicane" : null,
  };
  const result = selectCoachingPriorities([lapData]);

  expect(result.items.map(({ id, location }) => ({ id, fraction: location.fraction, cornerName: location.cornerName }))).toEqual([
    { id: "brake-drag:49", fraction: 1, cornerName: "Final Chicane" },
    { id: "downshift:20", fraction: 0.4, cornerName: null },
  ]);
  expect(result.unlocatedEvidenceCount).toBe(0);
});

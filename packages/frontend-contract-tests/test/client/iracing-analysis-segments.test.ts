import { describe, expect, test } from "bun:test";
import { buildSegmentData } from "client/src/components/analyse/AnalyseSegmentList";
import type { SemanticAnalysisFrame } from "client/src/components/analyse/track-map/types";

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

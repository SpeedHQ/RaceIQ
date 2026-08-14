import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LapStatsPanel } from "../src/components/track/detail/LapStatsPanel";
import type { TrackLap } from "../src/components/track/detail/types";

const ineligibleLap: TrackLap = {
  lapId: 1,
  lapNumber: 1,
  lapTime: 90,
  carOrdinal: 1,
  carName: "Test car",
  carClass: "Test class",
  pi: 800,
  phase: "out",
  conditions: [],
  paceEligibility: "excluded",
};

describe("Track Detail lap statistics", () => {
  test("renders an empty state when recorded laps are not pace eligible", () => {
    const markup = renderToStaticMarkup(<LapStatsPanel laps={[ineligibleLap]} sectorCount={3} />);

    expect(markup).toContain("No laps are eligible for pace statistics");
    expect(markup).not.toContain("NaN");
  });
});

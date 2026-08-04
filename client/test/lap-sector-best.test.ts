import { describe, expect, test } from "bun:test";
import { bestSectorLapIds } from "../src/lib/lap-sectors";

describe("bestSectorLapIds", () => {
  test("selects only the actual fastest lap for each sector", () => {
    const laps = [
      { id: 1, lapNumber: 10, sectorTimes: [15.433, 27.8, 32.96] },
      { id: 2, lapNumber: 11, sectorTimes: [15.45, 27.783, 32.948] },
      { id: 3, lapNumber: 12, sectorTimes: [15.44, 27.81, 32.972] },
    ];

    expect(bestSectorLapIds(laps, 3)).toEqual([1, 2, 2]);
  });

  test("breaks exact timing ties by earliest lap", () => {
    const laps = [
      { id: 20, lapNumber: 438, sectorTimes: [15.433] },
      { id: 10, lapNumber: 395, sectorTimes: [15.433] },
    ];

    expect(bestSectorLapIds(laps, 1)).toEqual([10]);
  });
});

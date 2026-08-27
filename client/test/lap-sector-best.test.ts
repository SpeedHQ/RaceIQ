import { describe, expect, test } from "bun:test";
import { sectorIndexAtFraction } from "../../shared/racing/tracks/sectors";
import { bestSectorLapIds, storedLapsSectorCount } from "../src/lib/lap-sectors";

describe("bestSectorLapIds", () => {
  test("selects only the actual fastest lap for each sector", () => {
    const laps = [
      { id: 1, lapNumber: 10, sectorTimes: [15.433, 27.8, 32.96] },
      { id: 2, lapNumber: 11, sectorTimes: [15.45, 27.783, 32.948] },
      { id: 4, lapNumber: 13, sectorTimes: [1, 1] },
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

describe("source-defined sector layouts", () => {
  test("keeps each lap collection's own sector count", () => {
    expect(storedLapsSectorCount([{ sectorTimes: [20, 30] }])).toBe(2);
    expect(storedLapsSectorCount([{ sectorTimes: [10, 11, 12, 13, 14] }])).toBe(5);
  });

  test("finds sectors across variable source boundaries", () => {
    const starts = [0, 0.137196, 0.273519, 0.353413, 0.630555];
    expect([0.1, 0.2, 0.3, 0.5, 0.9].map((fraction) => sectorIndexAtFraction(starts, fraction))).toEqual([0, 1, 2, 3, 4]);
  });
});

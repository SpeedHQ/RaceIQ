import { describe, expect, test } from "bun:test";
import { bestSectorLapIds, validLapBests } from "../src/lib/lap-sectors";

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

test("recorded PBs ignore a faster invalid lap and incomplete timings", () => {
  expect(validLapBests([
    { isValid: false, lapTime: 58.468, sectorTimes: [19.728, 20.492, 18.248] },
    { isValid: true, lapTime: 90, sectorTimes: [30, 31, 29] },
    { isValid: true, lapTime: 0, sectorTimes: [1, 1, 1] },
    { isValid: true, lapTime: NaN, sectorTimes: [1, 1, 1] },
  ], 3)).toEqual({ lapTime: 90, sectors: [30, 31, 29] });
  expect(validLapBests([{ isValid: false, lapTime: 58.468, sectorTimes: [19, 20, 19] }], 3))
    .toEqual({ lapTime: 0, sectors: [0, 0, 0] });
});

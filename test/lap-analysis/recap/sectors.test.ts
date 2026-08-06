import { describe, test, expect } from "bun:test";
import { computeRecap } from "../../../server/lap-analysis/recap";
import { baseSession, lap, run } from "../../support/lap-analysis/recap";

describe("computeRecap", () => {
  describe("sectors", () => {
    test("null when no valid lap has all three sectors", () => {
      const laps = [
        lap({ lapNumber: 1, lapTime: 100, sectorTimes: null }),
      ];
      const recap = run(laps);
      expect(recap.sectors).toBeNull();
    });

    test("sessionBestSec is the min per sector across different laps", () => {
      const laps = [
        lap({ id: 1, lapNumber: 1, lapTime: 100, sectorTimes: [30, 40, 30] }),
        lap({ id: 2, lapNumber: 2, lapTime: 99, sectorTimes: [29, 41, 29] }),
      ];
      const recap = run(laps);
      expect(recap.sectors).not.toBeNull();
      const [s1, s2, s3] = recap.sectors!;
      expect(s1.sessionBestSec).toBe(29);
      expect(s2.sessionBestSec).toBe(40);
      expect(s3.sessionBestSec).toBe(29);
    });

    test("status is 'record' when there is no all-time (first ever)", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100, sectorTimes: [33, 34, 33] })];
      const recap = run(laps, { allTimeBestSectors: null });
      expect(recap.sectors!.every((s) => s.status === "record")).toBe(true);
      expect(recap.sectors!.every((s) => s.allTimeBestSec === null)).toBe(true);
    });

    test("status is 'record' when sessionBest beats all-time", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100, sectorTimes: [33, 34, 33] })];
      const recap = run(laps, {
        allTimeBestSectors: [34, 35, 34],
      });
      expect(recap.sectors!.every((s) => s.status === "record")).toBe(true);
    });

    test("status is 'session-best' when the best lap owns that sector and all-time is faster", () => {
      const laps = [
        lap({ id: 1, lapNumber: 1, lapTime: 100, sectorTimes: [33, 34, 33] }),
        lap({ id: 2, lapNumber: 2, lapTime: 105, sectorTimes: [40, 40, 40] }),
      ];
      // best lap (id 1, lapTime 100) owns all three sectors, all faster than all-time
      const recap = run(laps, {
        allTimeBestSectors: [30, 30, 30],
      });
      // sessionBest for each sector equals best lap's own sector (it's the only fast lap)
      expect(recap.sectors!.every((s) => s.status === "session-best" || s.status === "record")).toBe(true);
    });

    test("status is 'lost' when the best lap's sector is slower than the session best, with all-time faster", () => {
      const laps = [
        // best overall lap (fastest lapTime), but slow s1
        lap({ id: 1, lapNumber: 1, lapTime: 98, sectorTimes: [35, 30, 33] }),
        // slower overall lap, but fastest s1
        lap({ id: 2, lapNumber: 2, lapTime: 100, sectorTimes: [29, 40, 31] }),
      ];
      const recap = run(laps, {
        allTimeBestSectors: [20, 20, 20],
      });
      const s1 = recap.sectors!.find((s) => s.index === 1)!;
      expect(s1.bestLapSec).toBe(35); // best lap's own s1
      expect(s1.sessionBestSec).toBe(29); // session-wide best s1, from the other lap
      expect(s1.status).toBe("lost");
    });

    test("best lap has null sectors but another valid lap has complete sectors: must not throw, no 'lost' status", () => {
      const laps = [
        // fastest overall lap, but missing sector data
        lap({ id: 1, lapNumber: 1, lapTime: 90, sectorTimes: null }),
        // slower lap, complete sectors
        lap({ id: 2, lapNumber: 2, lapTime: 100, sectorTimes: [33, 34, 33] }),
      ];
      expect(() => run(laps, { allTimeBestSectors: [20, 20, 20] })).not.toThrow();
      const recap = run(laps, { allTimeBestSectors: [20, 20, 20] });
      expect(recap.bestLapSec).toBe(90);
      expect(recap.sectors).not.toBeNull();
      expect(recap.sectors!.every((s) => s.status !== "lost")).toBe(true);
      // falls back to sessionBestSec for bestLapSec on every sector
      const [s1, s2, s3] = recap.sectors!;
      expect(s1.bestLapSec).toBe(s1.sessionBestSec);
      expect(s2.bestLapSec).toBe(s2.sessionBestSec);
      expect(s3.bestLapSec).toBe(s3.sessionBestSec);
    });

    test("sectors entries are ordered index 1,2,3", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100, sectorTimes: [33, 34, 33] })];
      const recap = run(laps);
      expect(recap.sectors!.map((s) => s.index)).toEqual([1, 2, 3]);
    });

    test("preserves an iRacing six-sector layout without projecting it to three", () => {
      const sectorStarts = [0, 0.1, 0.25, 0.45, 0.7, 0.85];
      const recap = computeRecap({
        session: { ...baseSession, gameId: "iracing" },
        laps: [
          lap({ lapNumber: 1, lapTime: 60, sectorTimes: [8, 10, 11, 12, 9, 10] }),
          lap({ lapNumber: 2, lapTime: 59, sectorTimes: [7, 10, 12, 11, 9, 10] }),
        ],
        carName: "Test Car",
        trackName: "Test Track",
        trackLengthM: 4000,
        allTimeBestSec: null,
        allTimeBestSectors: null,
        sectorStarts,
      });

      expect(recap.sectorStarts).toEqual(sectorStarts);
      expect(recap.theoretical?.bestSectorTimes).toEqual([7, 10, 11, 11, 9, 10]);
      expect(recap.sectors?.map((sector) => sector.index)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});

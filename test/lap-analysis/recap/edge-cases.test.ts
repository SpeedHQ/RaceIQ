import { describe, test, expect } from "bun:test";
import { lap, run } from "../../support/lap-analysis/recap";

describe("computeRecap", () => {
  describe("edge cases", () => {
    test("empty session: every metric null/zero, no laps", () => {
      const recap = run([]);
      expect(recap.lapsTotal).toBe(0);
      expect(recap.lapsValid).toBe(0);
      expect(recap.bestLapSec).toBeNull();
      expect(recap.timeOnTrackSec).toBe(0);
      expect(recap.distanceM).toBeNull();
      expect(recap.sparkline).toEqual([]);
      expect(recap.theoretical).toBeNull();
      expect(recap.improvementSec).toBeNull();
      expect(recap.consistency).toBeNull();
      expect(recap.personalBest).toBeNull();
    });

    test("single lap: best lap shown, improvement + consistency null", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100 })];
      const recap = run(laps);
      expect(recap.bestLapSec).toBe(100);
      expect(recap.improvementSec).toBeNull();
      expect(recap.consistency).toBeNull();
    });

    test("all laps invalid: bestLapSec/theoretical/personalBest null, time + distance zero", () => {
      const laps = [
        lap({ lapNumber: 1, lapTime: 100, isValid: false, sectorTimes: [30, 40, 30] }),
        lap({ lapNumber: 2, lapTime: 101, isValid: false }),
      ];
      const recap = run(laps, { trackLengthM: 500, allTimeBestSec: 90 });
      expect(recap.bestLapSec).toBeNull();
      expect(recap.theoretical).toBeNull();
      expect(recap.personalBest).toBeNull();
      expect(recap.timeOnTrackSec).toBe(0);
      expect(recap.distanceM).toBe(0);
    });

    test("distance null without a track outline", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100 })];
      const recap = run(laps, { trackLengthM: null });
      expect(recap.distanceM).toBeNull();
    });

    test("computeRecap never throws on ragged/empty input", () => {
      expect(() => run([])).not.toThrow();
    });
  });
});

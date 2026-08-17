import { describe, test, expect } from "bun:test";
import { lap, run } from "../../support/lap-analysis/recap";

describe("computeRecap", () => {
  test("invalid laps excluded from best/consistency/improvement AND from time + distance", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 90, isValid: false }),
      lap({ lapNumber: 2, lapTime: 100, isValid: true }),
      lap({ lapNumber: 3, lapTime: 101, isValid: true }),
      lap({ lapNumber: 4, lapTime: 102, isValid: true }),
    ];
    const recap = run(laps, { trackLengthM: 1000 });
    expect(recap.bestLapSec).toBe(100);
    expect(recap.lapsValid).toBe(3);
    expect(recap.lapsTotal).toBe(4);
    // the invalid 90s lap contributes to neither
    expect(recap.timeOnTrackSec).toBe(100 + 101 + 102);
    expect(recap.distanceM).toBe(1000 * 3);
    // consistency computed only from the 3 valid laps
    expect(recap.consistency).not.toBeNull();
  });

  test("pit transitions are excluded from every pace-derived recap metric", () => {
    const laps = [
      lap({ id: 1, lapNumber: 1, lapTime: 100, sectorTimes: [33, 33, 34] }),
      lap({ id: 2, lapNumber: 2, lapTime: 120, sectorTimes: [1, 1, 118], invalidReason: "inlap" }),
      lap({ id: 3, lapNumber: 3, lapTime: 190, sectorTimes: [1, 1, 188], invalidReason: "outlap" }),
      lap({ id: 4, lapNumber: 4, lapTime: 101, sectorTimes: [34, 33, 34] }),
      lap({ id: 5, lapNumber: 5, lapTime: 102, sectorTimes: [34, 34, 34] }),
    ];

    const recap = run(laps, { trackLengthM: 1000 });

    expect(recap.lapsValid).toBe(3);
    expect(recap.lapsTotal).toBe(5);
    expect(recap.bestLapSec).toBe(100);
    expect(recap.timeOnTrackSec).toBe(303);
    expect(recap.distanceM).toBe(3000);
    expect(recap.theoretical?.bestSectorTimes).toEqual([33, 33, 34]);
    expect(recap.improvementSec).toBe(0);
    expect(recap.consistency?.stdDevSec).toBeCloseTo(0.816_497, 6);
    expect(recap.sparkline.map((point) => point.lapId)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a single absurd invalid lap does not inflate time or distance (real session 174 case)", () => {
    // Regression: dev DB session 174 is one invalid 13207s lap — a detector artifact
    // from sitting in a menu. The recap must not report "0 laps · 3h 40m on track".
    const laps = [lap({ lapNumber: 0, lapTime: 13207.646484375, isValid: false })];
    const recap = run(laps, { trackLengthM: 3490.63 });
    expect(recap.lapsValid).toBe(0);
    expect(recap.lapsTotal).toBe(1);
    expect(recap.bestLapSec).toBeNull();
    expect(recap.timeOnTrackSec).toBe(0);
    expect(recap.distanceM).toBe(0);
  });

  test("lapTime <= 0 laps excluded from valid set, but still 'driven' time excluded too since lapTime<=0", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 0, isValid: true }),
      lap({ lapNumber: 2, lapTime: -5, isValid: true }),
      lap({ lapNumber: 3, lapTime: 100, isValid: true }),
    ];
    const recap = run(laps);
    expect(recap.lapsValid).toBe(1);
    expect(recap.bestLapSec).toBe(100);
    // timeOnTrackSec sums only lapTime > 0
    expect(recap.timeOnTrackSec).toBe(100);
    expect(recap.lapsTotal).toBe(3);
  });

  test("improvement clamps at 0 when lap 1 is best", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 95 }),
      lap({ lapNumber: 2, lapTime: 100 }),
      lap({ lapNumber: 3, lapTime: 98 }),
    ];
    const recap = run(laps);
    expect(recap.improvementSec).toBe(0);
  });

  test("improvement is first valid lap time minus best lap time", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 105 }),
      lap({ lapNumber: 2, lapTime: 100 }),
    ];
    const recap = run(laps);
    expect(recap.improvementSec).toBe(5);
  });

  test("improvement null when fewer than 2 valid laps", () => {
    const laps = [lap({ lapNumber: 1, lapTime: 100 })];
    const recap = run(laps);
    expect(recap.improvementSec).toBeNull();
  });

  describe("consistency rating thresholds", () => {
    test("rating 5 when stddev/best < 1%", () => {
      // best = 100; want stddev just under 1
      const laps = [
        lap({ lapNumber: 1, lapTime: 100 }),
        lap({ lapNumber: 2, lapTime: 100.5 }),
        lap({ lapNumber: 3, lapTime: 100 }),
      ];
      const recap = run(laps);
      expect(recap.consistency).not.toBeNull();
      expect(recap.consistency!.rating).toBe(5);
    });

    test("rating 4 when stddev/best is between 1% and 2%", () => {
      const laps = [
        lap({ lapNumber: 1, lapTime: 100 }),
        lap({ lapNumber: 2, lapTime: 103 }),
        lap({ lapNumber: 3, lapTime: 100 }),
      ];
      const recap = run(laps);
      // population stddev of [100,103,100]: mean=101, variance=((1)^2+(2)^2+(1)^2)/3=2, sd=1.414 -> ratio 1.414%
      expect(recap.consistency!.rating).toBe(4);
    });

    test("rating 3 when stddev/best is between 2% and 4%", () => {
      const laps = [
        lap({ lapNumber: 1, lapTime: 100 }),
        lap({ lapNumber: 2, lapTime: 107 }),
        lap({ lapNumber: 3, lapTime: 100 }),
      ];
      const recap = run(laps);
      // mean=102.333, variance=((2.333)^2+(4.667)^2+(2.333)^2)/3 = (5.44+21.78+5.44)/3=10.89, sd=3.3 -> ratio 3.3%
      expect(recap.consistency!.rating).toBe(3);
    });

    test("rating 2 when stddev/best is between 4% and 7%", () => {
      const laps = [
        lap({ lapNumber: 1, lapTime: 100 }),
        lap({ lapNumber: 2, lapTime: 100 }),
        lap({ lapNumber: 3, lapTime: 110 }),
      ];
      const recap = run(laps);
      // mean=103.333, sd=4.714 -> ratio 4.714% (>=4%, <7%)
      expect(recap.consistency!.rating).toBe(2);
    });

    test("rating 1 when stddev/best >= 7%", () => {
      const laps = [
        lap({ lapNumber: 1, lapTime: 100 }),
        lap({ lapNumber: 2, lapTime: 130 }),
        lap({ lapNumber: 3, lapTime: 100 }),
      ];
      const recap = run(laps);
      expect(recap.consistency!.rating).toBe(1);
    });

    test("consistency null when fewer than 3 valid laps", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100 }), lap({ lapNumber: 2, lapTime: 101 })];
      const recap = run(laps);
      expect(recap.consistency).toBeNull();
    });
  });

  describe("personal best", () => {
    test("isNew true, previousBestSec set, when this session beats the prior best", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 95 })];
      const recap = run(laps, { allTimeBestSec: 100 });
      expect(recap.personalBest).toEqual({ isNew: true, previousBestSec: 100 });
    });

    test("isNew false when this session does not beat the prior best", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 105 })];
      const recap = run(laps, { allTimeBestSec: 100 });
      expect(recap.personalBest).toEqual({ isNew: false, previousBestSec: 100 });
    });

    test("first-ever session: previousBestSec null, isNew true", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 105 })];
      const recap = run(laps, { allTimeBestSec: null });
      expect(recap.personalBest).toEqual({ isNew: true, previousBestSec: null });
    });

    test("null when bestLapSec is null (no valid laps)", () => {
      const laps = [lap({ lapNumber: 1, lapTime: 100, isValid: false })];
      const recap = run(laps, { allTimeBestSec: 90 });
      expect(recap.personalBest).toBeNull();
    });
  });
});

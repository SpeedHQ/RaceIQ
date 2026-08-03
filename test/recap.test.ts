import { describe, test, expect } from "bun:test";
import { computeRecap, type RecapLapInput, type RecapSessionInput } from "../server/lap-analysis/recap"

const baseSession: RecapSessionInput = {
  id: 1,
  carOrdinal: 10,
  trackOrdinal: 20,
  gameId: "fm-2023",
  createdAt: "2026-07-15T12:00:00.000Z",
};

function lap(overrides: Partial<RecapLapInput>): RecapLapInput {
  const merged = {
    lapNumber: 1,
    lapTime: 100,
    isValid: true,
    sectorTimes: null,
    ...overrides,
  };
  // Default the id to the lap number so fixtures can assert bestLapId readably.
  return { id: overrides.id ?? merged.lapNumber, ...merged };
}

function run(
  laps: RecapLapInput[],
  opts: Partial<{
    trackLengthM: number | null;
    allTimeBestSec: number | null;
    allTimeBestSectors: Array<number | null> | null;
    carName: string;
    trackName: string;
  }> = {},
) {
  return computeRecap({
    session: baseSession,
    laps,
    carName: opts.carName ?? "2019 Mazda MX-5",
    trackName: opts.trackName ?? "Maple Valley",
    trackLengthM: opts.trackLengthM ?? null,
    allTimeBestSec: opts.allTimeBestSec ?? null,
    allTimeBestSectors: opts.allTimeBestSectors ?? null,
  });
}

describe("computeRecap", () => {
  test("bestLapId points at the fastest VALID lap, for deep-linking to analyse", () => {
    const laps = [
      lap({ id: 501, lapNumber: 1, lapTime: 100 }),
      lap({ id: 502, lapNumber: 2, lapTime: 95 }),
      // faster, but invalid — must not win
      lap({ id: 503, lapNumber: 3, lapTime: 90, isValid: false }),
    ];
    const recap = run(laps);
    expect(recap.bestLapSec).toBe(95);
    expect(recap.bestLapId).toBe(502);
  });

  test("sparkline preserves lap ids when detector lap numbers repeat", () => {
    const recap = run([
      lap({ id: 45, lapNumber: 0, lapTime: 135.5, isValid: false }),
      lap({ id: 54, lapNumber: 0, lapTime: 49.1, isValid: false }),
    ]);
    expect(recap.sparkline.map((point) => point.lapId)).toEqual([45, 54]);
  });

  test("bestLapId is null when there is no valid lap", () => {
    const recap = run([lap({ id: 9, lapNumber: 1, lapTime: 100, isValid: false })]);
    expect(recap.bestLapId).toBeNull();
  });

  test("carOrdinal/trackOrdinal are carried through for deep-linking", () => {
    const recap = run([lap({ lapNumber: 1, lapTime: 100 })]);
    expect(recap.carOrdinal).toBe(baseSession.carOrdinal);
    expect(recap.trackOrdinal).toBe(baseSession.trackOrdinal);
  });

  test("theoretical mixes sectors across laps", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 100, sectorTimes: [30, 40, 30] }),
      lap({ lapNumber: 2, lapTime: 99, sectorTimes: [29, 40, 30] }),
      lap({ lapNumber: 3, lapTime: 98, sectorTimes: [29, 39, 30] }),
    ];
    const recap = run(laps);
    expect(recap.theoretical).not.toBeNull();
    expect(recap.theoretical!.bestSectorTimes).toEqual([29, 39, 30]);
    expect(recap.theoretical!.sumSec).toBe(98);
    // bestLapSec = 98, sumSec = 98 -> delta 0
    expect(recap.theoretical!.deltaToBestSec).toBe(0);
  });

  test("theoretical equals best lap when one lap owns all three sectors", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 100, sectorTimes: [33, 34, 33] }),
      lap({ lapNumber: 2, lapTime: 105, sectorTimes: [35, 35, 35] }),
    ];
    const recap = run(laps);
    expect(recap.theoretical!.sumSec).toBe(100);
    expect(recap.bestLapSec).toBe(100);
    expect(recap.theoretical!.deltaToBestSec).toBe(0);
  });

  test("theoretical null when any sector missing on all valid laps", () => {
    const laps = [
      lap({ lapNumber: 1, lapTime: 100, sectorTimes: null }),
      lap({ lapNumber: 2, lapTime: 101, sectorTimes: null }),
    ];
    const recap = run(laps);
    expect(recap.theoretical).toBeNull();
  });

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

    test("preserves a six-sector session layout without projecting it to three", () => {
      const sectorStarts = [0, 0.1, 0.25, 0.45, 0.7, 0.85];
      const recap = computeRecap({
        session: baseSession,
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

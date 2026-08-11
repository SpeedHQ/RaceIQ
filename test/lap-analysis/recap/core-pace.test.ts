import { describe, test, expect } from "bun:test";
import { baseSession, lap, normalPaceEligibility, run } from "../../support/lap-analysis/recap";

describe("computeRecap", () => {
  test("bestLapId points at fastest valid pace lap", () => {
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

  test("valid non-pace lap stays visible but cannot set pace metrics", () => {
    const recap = run([
      lap({ id: 501, lapNumber: 1, lapTime: 40, phase: "grid_start", paceEligibility: "excluded" }),
      lap({ id: 502, lapNumber: 2, lapTime: 95 }),
    ]);
    expect(recap.lapsValid).toBe(1);
    expect(recap.bestLapSec).toBe(95);
    expect(recap.bestLapId).toBe(502);
    expect(recap.sparkline).toEqual([
      expect.objectContaining({ lapId: 501, lapNumber: 1, lapTimeSec: 40, isValid: true, phase: "grid_start", conditions: [], paceEligibility: "excluded" }),
      expect.objectContaining({ lapId: 502, lapNumber: 2, lapTimeSec: 95, isValid: true, phase: "flying", conditions: [], paceEligibility: "eligible" }),
    ]);
  });

  test("persisted normal-pace decisions override legacy classification for pace metrics", () => {
    const recap = run([
      lap({ id: 601, lapNumber: 1, lapTime: 90, paceEligibility: "eligible", eligibility: normalPaceEligibility("ineligible") }),
      lap({ id: 602, lapNumber: 2, lapTime: 95, paceEligibility: "excluded", eligibility: normalPaceEligibility("eligible") }),
    ]);
    expect(recap.bestLapId).toBe(602);
    expect(recap.bestLapSec).toBe(95);
    expect(recap.sparkline[0]?.eligibility?.["normal-pace"].status).toBe("ineligible");
    expect(recap.sparkline[1]?.eligibility?.["normal-pace"].status).toBe("eligible");
  });

  test("sparkline preserves lap ids when detector lap numbers repeat", () => {
    const recap = run([
      lap({ id: 45, lapNumber: 0, lapTime: 135.5, isValid: false }),
      lap({ id: 54, lapNumber: 0, lapTime: 49.1, isValid: false }),
    ]);
    expect(recap.sparkline.map((point) => point.lapId)).toEqual([45, 54]);
  });

  test("bestLapId is null when there is no valid pace lap", () => {
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



});

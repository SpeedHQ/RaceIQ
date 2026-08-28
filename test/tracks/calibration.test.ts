import { describe, expect, test } from "bun:test";
import {
  calibrateFromPositions,
  computeStaticAlignment,
  feedCalibrationPosition,
  getCalibrationStatus,
  resetLiveCalibration,
  transformToSourceSpace,
} from "../../server/tracks/calibration";

type Point = { x: number; z: number };

function circle(count = 120): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return { x: Math.cos(a) * 100, z: Math.sin(a) * 100 };
  });
}

describe("calibration progress sampling", () => {
  test("bounds representatives to 100 progress bins", () => {
    const outline = circle();
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      feedCalibrationPosition(9101, { x: Math.cos(a) * 100, z: Math.sin(a) * 100 }, 1, outline);
    }
    expect(getCalibrationStatus(9101).pointsCollected).toBeLessThanOrEqual(100);
  });

  test("repeated samples in one bin do not grow state", () => {
    const outline = circle();
    const point = outline[10]!;
    for (let i = 0; i < 500; i++) feedCalibrationPosition(9102, point, 1, outline);
    expect(getCalibrationStatus(9102).pointsCollected).toBe(1);
  });

  test("lap completion retains accumulated session evidence", () => {
    const outline = circle();
    for (let i = 0; i < 100; i++) {
      const point = outline[i]!;
      feedCalibrationPosition(9103, point, 1, outline);
    }
    const before = getCalibrationStatus(9103).pointsCollected;
    feedCalibrationPosition(9103, outline[0]!, 2, outline);
    expect(getCalibrationStatus(9103).pointsCollected).toBe(before);
  });

  test("zero and malformed coordinates are rejected", () => {
    const outline = circle();
    feedCalibrationPosition(9104, { x: 0, z: 0 }, 1, outline);
    feedCalibrationPosition(9105, { x: Number.NaN, z: 1 }, 1, outline);
    expect(getCalibrationStatus(9104).pointsCollected).toBe(0);
    expect(getCalibrationStatus(9105).pointsCollected).toBe(0);
  });

  test("failed stored replacement preserves existing calibration", () => {
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    expect(calibrateFromPositions(9106, positions, outline)).toBe(true);
    expect(calibrateFromPositions(9106, [{ x: 0, z: 0 }], outline)).toBe(false);
    expect(getCalibrationStatus(9106).calibrated).toBe(true);
  });

  test("stored calibration ignores malformed positions before downsampling", () => {
    const outline = circle();
    const positions = [{ x: Number.NaN, z: 1 }, ...outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }))];
    expect(calibrateFromPositions(9107, positions, outline)).toBe(true);
  });
  test("fits one transform across two laps with different lateral lines", () => {
    const outline = circle();
    const positions: Point[] = [];
    for (const lateral of [8, -11]) {
      for (let i = 0; i < 80; i++) {
        const p = outline[i]!;
        const length = Math.hypot(p.x, p.z);
        positions.push({ x: p.x + (p.x / length) * lateral, z: p.z + (p.z / length) * lateral });
      }
    }
    expect(calibrateFromPositions(9108, positions, outline)).toBe(true);
    const transform = getCalibrationStatus(9108).transform!;
    expect(transform.scale).toBeCloseTo(1, 0);
    expect(transform.rotation).toBeCloseTo(0, 1);
  });

  test("uses normalized lap progress to distribute samples across laps", () => {
    const outline = circle();
    for (let i = 0; i < 100; i++) {
      feedCalibrationPosition(9111, { x: 40, z: 40 }, 1, outline, (i + 0.5) / 100);
    }
    expect(getCalibrationStatus(9111).pointsCollected).toBe(100);
  });
  test("pairs sparse progress bins at their actual outline fractions", () => {
    const outline = circle(1200);
    for (let i = 0; i < 60; i++) {
      const progress = 0.1 + i * 0.01;
      const point = outline[Math.round(progress * outline.length) % outline.length]!;
      feedCalibrationPosition(9114, point, 1, outline, progress);
    }
    feedCalibrationPosition(9114, outline[0]!, 2, outline, 0);
    const transform = getCalibrationStatus(9114).transform!;
    expect(transform.scale).toBeCloseTo(1, 2);
    expect(transform.rotation).toBeCloseTo(0, 1);
    expect(transform.tx).toBeCloseTo(0, 0);
    expect(transform.tz).toBeCloseTo(0, 0);
  });


  test("rejects sparse evidence and resists one extreme outlier", () => {
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.2, z: point.z * 1.2 }));
    positions.push({ x: 10000, z: -10000 });
    expect(calibrateFromPositions(9109, positions, outline)).toBe(true);
    expect(getCalibrationStatus(9109).transform!.scale).toBeCloseTo(1 / 1.2, 1);
    expect(calibrateFromPositions(9110, positions.slice(0, 20), outline)).toBe(false);
  });

  test("reset clears live evidence but preserves cached static fallback", () => {
    const tumftm = circle();
    const recorded = tumftm.map(point => ({ x: point.x + 300, z: point.z - 120 }));
    computeStaticAlignment(9112, tumftm, recorded);
    expect(transformToSourceSpace(9112, [{ x: 0, z: 0 }])).not.toBeNull();

    const livePositions = tumftm.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    expect(calibrateFromPositions(9112, livePositions, tumftm)).toBe(true);
    expect(getCalibrationStatus(9112).calibrated).toBe(true);

    resetLiveCalibration(9112);
    expect(getCalibrationStatus(9112).calibrated).toBe(false);
    expect(transformToSourceSpace(9112, [{ x: 0, z: 0 }])).not.toBeNull();
  });

  test("lap counter reset isolates next live session", () => {
    const outline = circle();
    for (let i = 0; i < 60; i++) {
      feedCalibrationPosition(9113, outline[i]!, 4, outline, i / 60);
    }
    expect(getCalibrationStatus(9113).pointsCollected).toBeGreaterThan(0);
    feedCalibrationPosition(9113, outline[0]!, 1, outline, 0);
    expect(getCalibrationStatus(9113).pointsCollected).toBe(1);
    expect(getCalibrationStatus(9113).calibrated).toBe(false);
  });
});

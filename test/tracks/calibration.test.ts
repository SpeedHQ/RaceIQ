import { describe, expect, test } from "bun:test";
import {
  calibrateFromPositions,
  computeStaticAlignment,
  feedCalibrationPosition,
  getCalibrationComparison,
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

function stadium(count = 400, straightLength = 200, radius = 20): Point[] {
  const turnLength = Math.PI * radius;
  const totalLength = 2 * straightLength + 2 * turnLength;
  return Array.from({ length: count }, (_, i) => {
    const distance = i / (count - 1) * totalLength;
    if (distance < straightLength) {
      return { x: -straightLength / 2 + distance, z: -radius };
    }
    if (distance < straightLength + turnLength) {
      const angle = -Math.PI / 2 + (distance - straightLength) / radius;
      return { x: straightLength / 2 + Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    }
    if (distance < 2 * straightLength + turnLength) {
      return { x: straightLength / 2 - (distance - straightLength - turnLength), z: radius };
    }
    const angle = Math.PI / 2 + (distance - 2 * straightLength - turnLength) / radius;
    return { x: -straightLength / 2 + Math.cos(angle) * radius, z: Math.sin(angle) * radius };
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

  test("fits geometry when game progress drifts from outline arc distance", () => {
    const outline = stadium();
    for (let i = 0; i < 100; i++) {
      const pathProgress = (i + 0.5) / 100;
      const point = outline[Math.floor(pathProgress * (outline.length - 1))]!;
      const gameProgress = pathProgress < 0.5
        ? pathProgress * 0.8
        : 0.4 + (pathProgress - 0.5) * 1.2;
      feedCalibrationPosition(9117, point, 1, outline, gameProgress);
    }
    feedCalibrationPosition(9117, outline[0]!, 2, outline, 0);
    const transform = getCalibrationStatus(9117).transform!;
    expect(transform.scale).toBeCloseTo(1, 2);
    expect(transform.rotation).toBeCloseTo(0, 2);
    expect(transform.tx).toBeCloseTo(0, 0);
    expect(transform.tz).toBeCloseTo(0, 0);
  });

  test("freezes accepted transform for remaining session laps", () => {
    const outline = circle();
    for (let i = 0; i < 100; i++) {
      feedCalibrationPosition(9118, outline[i]!, 1, outline, i / 100);
    }
    feedCalibrationPosition(9118, outline[0]!, 2, outline, 0);
    const accepted = { ...getCalibrationStatus(9118).transform! };
    for (let i = 0; i < 100; i++) {
      feedCalibrationPosition(9118, { x: outline[i]!.x + 20, z: outline[i]!.z - 15 }, 2, outline, i / 100);
    }
    feedCalibrationPosition(9118, outline[0]!, 3, outline, 0);
    expect(getCalibrationStatus(9118).transform).toEqual(accepted);
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

  test("rejects sustained samples outside supplied track boundaries", () => {
    const outline = circle();
    const boundaries = {
      leftEdge: circle().map(point => ({ x: point.x * 0.95, z: point.z * 0.95 })),
      rightEdge: circle().map(point => ({ x: point.x * 1.05, z: point.z * 1.05 })),
      pitLane: null,
    };
    const positions = outline.map((point, index) => index < 80
      ? point
      : { x: point.x * 1.8, z: point.z * 1.8 });
    expect(calibrateFromPositions(9120, outline, outline, boundaries)).toBe(true);
    const baseline = getCalibrationStatus(9120).transform!;
    expect(calibrateFromPositions(9119, positions, outline, boundaries)).toBe(true);
    const transform = getCalibrationStatus(9119).transform!;
    expect(transform.scale).toBeCloseTo(baseline.scale, 2);
    expect(transform.rotation).toBeCloseTo(baseline.rotation, 1);
    expect(transform.tx).toBeCloseTo(baseline.tx, 0);
    expect(Math.abs(transform.tz - baseline.tz)).toBeLessThan(1);
  });

  test("keeps every valid racing-line representative inside track corridor", () => {
    const outline = circle();
    const boundaries = {
      leftEdge: circle().map(point => ({ x: point.x * 0.95, z: point.z * 0.95 })),
      rightEdge: circle().map(point => ({ x: point.x * 1.05, z: point.z * 1.05 })),
      pitLane: null,
    };
    const positions = outline.map((point, index) => {
      const radiusScale = index < 72 ? 0.96 : 1.04;
      return { x: point.x * radiusScale, z: point.z * radiusScale };
    });
    expect(calibrateFromPositions(9121, positions, outline, boundaries)).toBe(true);
    const transform = getCalibrationStatus(9121).transform!;
    const cos = Math.cos(transform.rotation);
    const sin = Math.sin(transform.rotation);
    for (const point of positions) {
      const x = transform.scale * (cos * point.x - sin * point.z) + transform.tx;
      const z = transform.scale * (sin * point.x + cos * point.z) + transform.tz;
      expect(Math.hypot(x, z)).toBeWithin(95, 105);
    }
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
  test("records accepted fit comparison and clears history on reset", () => {
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    expect(calibrateFromPositions(9115, positions, outline)).toBe(true);
    const comparison = getCalibrationComparison(9115);
    expect(comparison.history).toHaveLength(1);
    expect(comparison.history[0]).toMatchObject({ sequence: 1, lapNumber: 0, points: 100 });
    expect(comparison.history[0]!.rmse).toBeLessThan(3);
    expect(comparison.current).toEqual(comparison.history[0]!.transform);
    resetLiveCalibration(9115);
    expect(getCalibrationComparison(9115).history).toHaveLength(0);
  });

  test("bounds comparison history to latest twelve fits", () => {
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    for (let i = 0; i < 13; i++) expect(calibrateFromPositions(9116, positions, outline)).toBe(true);
    const history = getCalibrationComparison(9116).history;
    expect(history).toHaveLength(12);
    expect(history[0]!.sequence).toBe(2);
    expect(history.at(-1)!.sequence).toBe(13);
  });
});

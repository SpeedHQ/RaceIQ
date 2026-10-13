import { describe, expect, test } from "bun:test";
import {
  calibrateFromPositions,
  computeStaticAlignment,
  fitLapToTrack,
  feedCalibrationPosition,
  getCalibrationComparison,
  getCalibrationStatus,
  resetLiveCalibration,
  transformToSourceSpace,
} from "@raceiq/backend-core/tracks/calibration";

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
    const trackId = "calibration-progress";
    const outline = circle();
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      feedCalibrationPosition(trackId, { x: Math.cos(a) * 100, z: Math.sin(a) * 100 }, 1, outline);
    }
    expect(getCalibrationStatus(trackId).pointsCollected).toBeLessThanOrEqual(100);
  });

  test("repeated samples in one bin do not grow state", () => {
    const trackId = "calibration-repeat";
    const outline = circle();
    const point = outline[10]!;
    for (let i = 0; i < 500; i++) feedCalibrationPosition(trackId, point, 1, outline);
    expect(getCalibrationStatus(trackId).pointsCollected).toBe(1);
  });

  test("lap completion retains accumulated session evidence", () => {
    const trackId = "calibration-lap-retention";
    const outline = circle();
    for (let i = 0; i < 100; i++) feedCalibrationPosition(trackId, outline[i]!, 1, outline);
    const before = getCalibrationStatus(trackId).pointsCollected;
    feedCalibrationPosition(trackId, outline[0]!, 2, outline);
    expect(getCalibrationStatus(trackId).pointsCollected).toBe(before);
  });

  test("zero and malformed coordinates are rejected", () => {
    const outline = circle();
    feedCalibrationPosition("calibration-zero", { x: 0, z: 0 }, 1, outline);
    feedCalibrationPosition("calibration-malformed", { x: Number.NaN, z: 1 }, 1, outline);
    expect(getCalibrationStatus("calibration-zero").pointsCollected).toBe(0);
    expect(getCalibrationStatus("calibration-malformed").pointsCollected).toBe(0);
  });

  test("failed stored replacement preserves existing calibration", () => {
    const trackId = "calibration-replacement";
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    expect(calibrateFromPositions(trackId, positions, outline)).toBe(true);
    expect(calibrateFromPositions(trackId, [{ x: 0, z: 0 }], outline)).toBe(false);
    expect(getCalibrationStatus(trackId).calibrated).toBe(true);
  });

  test("stored calibration ignores malformed positions before downsampling", () => {
    const outline = circle();
    const positions = [{ x: Number.NaN, z: 1 }, ...outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }))];
    expect(calibrateFromPositions("calibration-downsample", positions, outline)).toBe(true);
  });
  test("fits one transform across two laps with different lateral lines", () => {
    const trackId = "calibration-multilap";
    const outline = circle();
    const positions: Point[] = [];
    for (const lateral of [8, -11]) {
      for (let i = 0; i < 80; i++) {
        const p = outline[i]!;
        const length = Math.hypot(p.x, p.z);
        positions.push({ x: p.x + (p.x / length) * lateral, z: p.z + (p.z / length) * lateral });
      }
    }
    expect(calibrateFromPositions(trackId, positions, outline)).toBe(true);
    const transform = getCalibrationStatus(trackId).transform!;
    expect(transform.scale).toBeCloseTo(1, 0);
    expect(transform.rotation).toBeCloseTo(0, 1);
  });

  test("uses normalized lap progress to distribute samples across laps", () => {
    const trackId = "calibration-progress-distribution";
    const outline = circle();
    for (let i = 0; i < 100; i++) {
      feedCalibrationPosition(trackId, { x: 40, z: 40 }, 1, outline, (i + 0.5) / 100);
    }
    expect(getCalibrationStatus(trackId).pointsCollected).toBe(100);
  });
  test("rejects spatially degenerate live evidence", () => {
    const trackId = "calibration-degenerate";
    const outline = circle();
    for (let i = 0; i < 100; i++) feedCalibrationPosition(trackId, { x: 40, z: 40 }, 1, outline, (i + 0.5) / 100);
    feedCalibrationPosition(trackId, { x: 40, z: 40 }, 2, outline, 0);

    const status = getCalibrationStatus(trackId);
    expect(status.calibrated).toBe(false);
    expect(status.collecting).toBe(true);
  });

  test("waits for a complete stadium lap before calibrating", () => {
    const trackId = "calibration-stadium-lap";
    const outline = stadium();
    for (let i = 0; i <= 80; i++) {
      const progress = 0.1 + i / 100;
      const point = outline[Math.floor(progress * (outline.length - 1))]!;
      feedCalibrationPosition(trackId, point, 1, outline, progress);
    }
    feedCalibrationPosition(trackId, outline[0]!, 2, outline, 0);

    const partialStatus = getCalibrationStatus(trackId);
    expect(partialStatus.calibrated).toBe(false);
    expect(partialStatus.collecting).toBe(true);
    expect(partialStatus.transform).toBeNull();

    for (let i = 0; i < 100; i++) {
      const progress = i / 100;
      const point = outline[Math.floor(progress * (outline.length - 1))]!;
      feedCalibrationPosition(trackId, point, 2, outline, progress);
    }
    feedCalibrationPosition(trackId, outline[0]!, 3, outline, 0);

    const completeStatus = getCalibrationStatus(trackId);
    expect(completeStatus.calibrated).toBe(true);
    expect(completeStatus.transform).not.toBeNull();
    expect(completeStatus.transform!.scale).toBeCloseTo(1, 2);
    expect(completeStatus.transform!.rotation).toBeCloseTo(0, 2);
    expect(completeStatus.transform!.tx).toBeCloseTo(0, 0);
    expect(completeStatus.transform!.tz).toBeCloseTo(0, 0);
  });

  test("fits geometry when game progress drifts from outline arc distance", () => {
    const trackId = "calibration-progress-drift";
    const outline = stadium();
    for (let i = 0; i < 100; i++) {
      const pathProgress = (i + 0.5) / 100;
      const point = outline[Math.floor(pathProgress * (outline.length - 1))]!;
      const gameProgress = pathProgress < 0.5 ? pathProgress * 0.8 : 0.4 + (pathProgress - 0.5) * 1.2;
      feedCalibrationPosition(trackId, point, 1, outline, gameProgress);
    }
    feedCalibrationPosition(trackId, outline[0]!, 2, outline, 0);
    const transform = getCalibrationStatus(trackId).transform!;
    expect(transform.scale).toBeCloseTo(1, 2);
    expect(transform.rotation).toBeCloseTo(0, 2);
    expect(transform.tx).toBeCloseTo(0, 0);
    expect(transform.tz).toBeCloseTo(0, 0);
  });
  test("fits a lap that starts at a cyclic track offset", () => {
    const outline = stadium(400);
    const offset = 73;
    const scale = 1.25;
    const rotation = 0.35;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const positions = Array.from({ length: 180 }, (_, i) => {
      const point = outline[(offset + i * 2) % (outline.length - 1)]!;
      return { x: scale * (cos * point.x - sin * point.z) + 400, z: scale * (sin * point.x + cos * point.z) - 200 };
    });
    const result = fitLapToTrack(positions, outline);
    expect(result).not.toBeNull();
    expect(result!.rmse).toBeLessThan(5);
  });

  test("freezes accepted transform for remaining session laps", () => {
    const trackId = "calibration-frozen-transform";
    const outline = circle();
    for (let i = 0; i < 100; i++) feedCalibrationPosition(trackId, outline[i]!, 1, outline, i / 100);
    feedCalibrationPosition(trackId, outline[0]!, 2, outline, 0);
    const accepted = { ...getCalibrationStatus(trackId).transform! };
    for (let i = 0; i < 100; i++) feedCalibrationPosition(trackId, { x: outline[i]!.x + 20, z: outline[i]!.z - 15 }, 2, outline, i / 100);
    feedCalibrationPosition(trackId, outline[0]!, 3, outline, 0);
    expect(getCalibrationStatus(trackId).transform).toEqual(accepted);
  });
  test("waits for complete lap before fitting sparse progress bins", () => {
    const trackId = "calibration-sparse-bins";
    const outline = circle(1200);
    for (let i = 0; i < 60; i++) {
      const progress = 0.1 + i * 0.01;
      const point = outline[Math.round(progress * outline.length) % outline.length]!;
      feedCalibrationPosition(trackId, point, 1, outline, progress);
    }
    feedCalibrationPosition(trackId, outline[0]!, 2, outline, 0);
    const status = getCalibrationStatus(trackId);
    expect(status.calibrated).toBe(false);
    expect(status.collecting).toBe(true);
    expect(status.transform).toBeNull();
  });

  test("rejects sparse evidence and resists one extreme outlier", () => {
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.2, z: point.z * 1.2 }));
    positions.push({ x: 10000, z: -10000 });
    expect(calibrateFromPositions("calibration-outlier", positions, outline)).toBe(true);
    expect(getCalibrationStatus("calibration-outlier").transform!.scale).toBeCloseTo(1 / 1.2, 1);
    expect(calibrateFromPositions("calibration-sparse", positions.slice(0, 20), outline)).toBe(false);
  });

  test("rejects sustained samples outside supplied track boundaries", () => {
    const outline = circle();
    const boundaries = {
      leftEdge: circle().map(point => ({ x: point.x * 0.95, z: point.z * 0.95 })),
      rightEdge: circle().map(point => ({ x: point.x * 1.05, z: point.z * 1.05 })),
      pitLane: null,
    };
    const positions = outline.map((point, index) => index < 80 ? point : { x: point.x * 1.8, z: point.z * 1.8 });
    expect(calibrateFromPositions("calibration-boundary-baseline", outline, outline, boundaries)).toBe(true);
    const baseline = getCalibrationStatus("calibration-boundary-baseline").transform!;
    expect(calibrateFromPositions("calibration-boundary-rejected", positions, outline, boundaries)).toBe(true);
    const transform = getCalibrationStatus("calibration-boundary-rejected").transform!;
    expect(transform.scale).toBeCloseTo(baseline.scale, 2);
    expect(transform.rotation).toBeCloseTo(baseline.rotation, 1);
    expect(transform.tx).toBeCloseTo(baseline.tx, 0);
    expect(Math.abs(transform.tz - baseline.tz)).toBeLessThan(1);
  });

  test("keeps every valid racing-line representative inside track corridor", () => {
    const trackId = "calibration-corridor";
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
    expect(calibrateFromPositions(trackId, positions, outline, boundaries)).toBe(true);
    const transform = getCalibrationStatus(trackId).transform!;
    const cos = Math.cos(transform.rotation);
    const sin = Math.sin(transform.rotation);
    for (const point of positions) {
      const x = transform.scale * (cos * point.x - sin * point.z) + transform.tx;
      const z = transform.scale * (sin * point.x + cos * point.z) + transform.tz;
      expect(Math.hypot(x, z)).toBeWithin(95, 105);
    }
  });

  test("reset clears live evidence but preserves cached static fallback", () => {
    const trackId = "calibration-static-fallback";
    const tumftm = circle();
    const recorded = tumftm.map(point => ({ x: point.x + 300, z: point.z - 120 }));
    computeStaticAlignment(trackId, tumftm, recorded);
    expect(transformToSourceSpace(trackId, [{ x: 0, z: 0 }])).not.toBeNull();

    const livePositions = tumftm.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    expect(calibrateFromPositions(trackId, livePositions, tumftm)).toBe(true);
    expect(getCalibrationStatus(trackId).calibrated).toBe(true);

    resetLiveCalibration(trackId);
    expect(getCalibrationStatus(trackId).calibrated).toBe(false);
    expect(transformToSourceSpace(trackId, [{ x: 0, z: 0 }])).not.toBeNull();
  });

  test("lap counter reset isolates next live session", () => {
    const trackId = "calibration-lap-counter";
    const outline = circle();
    for (let i = 0; i < 60; i++) feedCalibrationPosition(trackId, outline[i]!, 4, outline, i / 60);
    expect(getCalibrationStatus(trackId).pointsCollected).toBeGreaterThan(0);
    feedCalibrationPosition(trackId, outline[0]!, 1, outline, 0);
    expect(getCalibrationStatus(trackId).pointsCollected).toBe(1);
    expect(getCalibrationStatus(trackId).calibrated).toBe(false);
  });
  test("records accepted fit comparison and clears history on reset", () => {
    const trackId = "calibration-history";
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    expect(calibrateFromPositions(trackId, positions, outline)).toBe(true);
    const comparison = getCalibrationComparison(trackId);
    expect(comparison.history).toHaveLength(1);
    expect(comparison.history[0]).toMatchObject({ sequence: 1, lapNumber: 0, points: 100 });
    expect(comparison.history[0]!.rmse).toBeLessThan(3);
    expect(comparison.current).toEqual(comparison.history[0]!.transform);
    resetLiveCalibration(trackId);
    expect(getCalibrationComparison(trackId).history).toHaveLength(0);
  });

  test("bounds comparison history to latest twelve fits", () => {
    const trackId = "calibration-fit-history";
    const outline = circle();
    const positions = outline.map(point => ({ x: point.x * 1.1, z: point.z * 1.1 }));
    for (let i = 0; i < 13; i++) expect(calibrateFromPositions(trackId, positions, outline)).toBe(true);
    const history = getCalibrationComparison(trackId).history;
    expect(history).toHaveLength(12);
    expect(history[0]!.sequence).toBe(2);
    expect(history.at(-1)!.sequence).toBe(13);
  });
});

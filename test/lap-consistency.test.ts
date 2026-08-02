import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { computeLapConsistencyDelta, computeLineSpreadTrace, LINE_SPREAD_THRESHOLD_M, INPUT_VAR_THRESHOLD } from "../server/lap-analysis/consistency"
import type { Corner } from "../server/lap-analysis/corners"

/**
 * `computeLapConsistencyDelta` is pure math over resampled lap paths — these
 * tests pin the racing-line spread / input-variance behaviour with hand-built
 * synthetic laps rather than real telemetry.
 */

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "f1-2025",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    PositionX: 0,
    PositionZ: 0,
    VelocityX: 0,
    VelocityY: 0,
    VelocityZ: 0,
    Gear: 1,
    Accel: 0,
    Brake: 0,
    ...overrides,
  } as TelemetryPacket;
}

// Straight-line lap along Z, 600m long, ~120 frames (5m / frame, 100ms cadence).
// Corner T1 spans distance 200..300; the rest of the lap is straight.
// Braking pattern: constant, contiguous braking window in the corner approach.
const LAP_LENGTH_M = 600;
const FRAME_COUNT = 121;
const STEP_M = LAP_LENGTH_M / (FRAME_COUNT - 1);
const CORNER_START = 200;
const CORNER_END = 300;

interface LapOptions {
  lateralOffsetInCorner?: number; // metres added to PositionX within the corner span
  brakeShiftM?: number; // shift the braking window earlier by this many metres
}

function buildLap(opts: LapOptions = {}): TelemetryPacket[] {
  const { lateralOffsetInCorner = 0, brakeShiftM = 0 } = opts;
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const distance = i * STEP_M;
    const inCorner = distance >= CORNER_START && distance <= CORNER_END;
    const x = inCorner ? lateralOffsetInCorner : 0;

    // Braking normally happens mid-corner (220..260), shiftable earlier while
    // staying inside the T1 corner span (200..300) so the corner's brakeVar
    // actually picks up the shift.
    const brakeWindowStart = 220 - brakeShiftM;
    const brakeWindowEnd = 260 - brakeShiftM;
    const braking = distance >= brakeWindowStart && distance <= brakeWindowEnd;

    packets.push(
      pkt({
        TimestampMS: i * 100,
        DistanceTraveled: distance,
        PositionX: x,
        PositionZ: distance,
        VelocityX: 0,
        VelocityZ: STEP_M / 0.1,
        Brake: braking ? 1 : 0,
        Accel: braking ? 0 : 1,
      }),
    );
  }
  return packets;
}

const corners: Corner[] = [
  { index: 1, label: "T1", distanceStart: CORNER_START, distanceEnd: CORNER_END },
  { index: 2, label: "T2", distanceStart: 400, distanceEnd: 500 },
];

describe("computeLapConsistencyDelta", () => {
  test("returns empty result with fewer than 2 laps or no corners", () => {
    const lap = buildLap();
    expect(computeLapConsistencyDelta([lap], corners)).toEqual({
      perCorner: [],
      overall: { lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false },
    });
    expect(computeLapConsistencyDelta([lap, lap], [])).toEqual({
      perCorner: [],
      overall: { lateralSpreadM: 0, brakeVar: 0, throttleVar: 0, lowTrust: false },
    });
  });

  test("two identical laps: near-zero spread/variance everywhere, lowTrust false", () => {
    const lapA = buildLap();
    const lapB = buildLap();
    const result = computeLapConsistencyDelta([lapA, lapB], corners);

    const t1 = result.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.lateralSpreadM).toBeCloseTo(0, 3);
    expect(t1.brakeVar).toBeCloseTo(0, 3);
    expect(t1.throttleVar).toBeCloseTo(0, 3);
    expect(t1.lowTrust).toBe(false);

    const t2 = result.perCorner.find((c) => c.corner === "T2")!;
    expect(t2.lowTrust).toBe(false);

    expect(result.overall.lowTrust).toBe(false);
  });

  test("lap offset laterally through T1 flags that corner's line, not T2", () => {
    const lapA = buildLap();
    const lapB = buildLap({ lateralOffsetInCorner: 4 });
    const result = computeLapConsistencyDelta([lapA, lapB], corners);

    const t1 = result.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.lateralSpreadM).toBeGreaterThan(LINE_SPREAD_THRESHOLD_M);
    expect(t1.lowTrust).toBe(true);

    const t2 = result.perCorner.find((c) => c.corner === "T2")!;
    expect(t2.lateralSpreadM).toBeCloseTo(0, 3);
    expect(t2.lowTrust).toBe(false);
  });

  test("lap braking ~20m earlier through T1 flags brakeVar for that corner", () => {
    const lapA = buildLap();
    const lapB = buildLap({ brakeShiftM: 20 });
    const result = computeLapConsistencyDelta([lapA, lapB], corners);

    const t1 = result.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.brakeVar).toBeGreaterThan(INPUT_VAR_THRESHOLD);
    expect(t1.lowTrust).toBe(true);
  });
});

describe("computeLineSpreadTrace", () => {
  test("returns null with fewer than 3 resampled laps", () => {
    const lapA = buildLap();
    const lapB = buildLap({ lateralOffsetInCorner: 4 });
    expect(computeLineSpreadTrace([lapA, lapB], [1, 2], corners)).toBeNull();
  });

  test("three laps offset by known amounts through T1: trimmed spread reflects the inner two, not the outlier", () => {
    // Three laps sharing the same corner: 0m, 1m, 2m lateral offset — a tight
    // cluster. The 10th-90th percentile trim over 3 points keeps the full
    // 0..2m spread (no room to trim a 3-point set down further), so this
    // pins the "known amounts" case before introducing a real outlier below.
    const lapA = buildLap({ lateralOffsetInCorner: 0 });
    const lapB = buildLap({ lateralOffsetInCorner: 1 });
    const lapC = buildLap({ lateralOffsetInCorner: 2 });
    const result = computeLineSpreadTrace([lapA, lapB, lapC], [101, 102, 103], corners);
    expect(result).not.toBeNull();
    expect(result!.lapCount).toBe(3);

    // lapLines: one entry per surviving lap, correct lapIds, each 200 bins.
    expect(result!.lapLines.length).toBe(3);
    expect(result!.lapLines.map((l) => l.lapId).sort()).toEqual([101, 102, 103]);
    // Raw per-frame lines (full resolution) — x/z/brake/throttle all share the
    // lap's own frame count, independent of the 200-bin metric resample.
    for (const line of result!.lapLines) {
      expect(line.x.length).toBeGreaterThan(0);
      expect(line.z.length).toBe(line.x.length);
      expect(line.brake.length).toBe(line.x.length);
      expect(line.throttle.length).toBe(line.x.length);
      // Per-frame normalized distance fraction, monotonic 0..1.
      expect(line.frac.length).toBe(line.x.length);
      expect(line.frac[0]).toBeCloseTo(0, 5);
      expect(line.frac[line.frac.length - 1]).toBeCloseTo(1, 5);
      expect(line.frac.every((f, i) => i === 0 || f >= line.frac[i - 1])).toBe(true);
    }

    const t1 = result!.perCorner.find((c) => c.corner === "T1")!;
    expect(t1.lateralSpreadM).toBeGreaterThan(0);
    expect(t1.lateralSpreadM).toBeLessThan(LINE_SPREAD_THRESHOLD_M);
    expect(t1.lowTrust).toBe(false);

    const t2 = result!.perCorner.find((c) => c.corner === "T2")!;
    expect(t2.lateralSpreadM).toBeCloseTo(0, 3);
    expect(t2.lowTrust).toBe(false);

    // fracs cover the full lap 0..1 with RESAMPLE_BINS entries.
    expect(result!.fracs.length).toBe(result!.spreadM.length);
    expect(result!.fracs[0]).toBeCloseTo(0, 5);
    expect(result!.fracs[result!.fracs.length - 1]).toBeCloseTo(1, 5);
  });

  test("laps on an identical spatial line but with desynced odometers report ~0 spread", () => {
    // Regression: laps are resampled over their own DistanceTraveled span, so a
    // different odometer origin/scale (e.g. drivers braking at different points,
    // a slightly longer measured lap) shifts equal-fraction points ALONG the
    // track. A naive point-to-point distance folds that longitudinal shift into
    // the metric as metres of phantom "spread" — which is exactly the bug that
    // made a tight session read ~19m. Here all three laps trace the SAME (X,Z)
    // path (0m offset, with an X=4 kink through the corner), differing ONLY in
    // their DistanceTraveled mapping, so the true line spread is zero.
    function desyncedLap(distanceOffset: number, distanceScale: number): TelemetryPacket[] {
      const packets: TelemetryPacket[] = [];
      for (let i = 0; i < FRAME_COUNT; i++) {
        const z = i * STEP_M; // spatial coordinate — identical across laps
        const inCorner = z >= CORNER_START && z <= CORNER_END;
        packets.push(
          pkt({
            TimestampMS: i * 100,
            // Odometer decoupled from space: same line, different distance axis.
            DistanceTraveled: distanceOffset + i * STEP_M * distanceScale,
            PositionX: inCorner ? 4 : 0,
            PositionZ: z,
            VelocityX: 0,
            VelocityZ: STEP_M / 0.1,
            Brake: 0,
            Accel: 1,
          }),
        );
      }
      return packets;
    }

    const result = computeLineSpreadTrace([desyncedLap(0, 1), desyncedLap(37, 1.08), desyncedLap(-19, 0.94)], [201, 202, 203], corners);
    expect(result).not.toBeNull();
    const t1 = result!.perCorner.find((c) => c.corner === "T1")!;
    // Nearest-point projection cancels the longitudinal desync; the residual is
    // only the discretisation at the two corner edges, far below the 1.5m
    // "tight line" threshold (the old point-to-point metric reported ~4m here).
    expect(t1.lateralSpreadM).toBeLessThan(LINE_SPREAD_THRESHOLD_M);
    expect(t1.lowTrust).toBe(false);
  });

  test("consistencyScore is 100 for identical lines and falls as the line spreads", () => {
    const tight = computeLineSpreadTrace([buildLap(), buildLap(), buildLap()], [301, 302, 303], corners);
    expect(tight!.consistencyScore).toBe(100);
    expect(tight!.overallSpreadM).toBeCloseTo(0, 3);

    // A ~4m offset through T1 lifts the mean spread, so the score drops below 100.
    const spread = computeLineSpreadTrace(
      [buildLap(), buildLap({ lateralOffsetInCorner: 4 }), buildLap({ lateralOffsetInCorner: 8 })],
      [301, 302, 303],
      corners,
    );
    expect(spread!.consistencyScore).toBeLessThan(100);
    expect(spread!.consistencyScore).toBeGreaterThanOrEqual(0);
  });

  test("a single wild outlier lap is suppressed by percentile trimming with enough laps in the pool", () => {
    // Five tightly-clustered laps (0m offset) plus one wild 50m-off blunder
    // lap through T1. The 10th-90th trim over 6 points drops the extreme end,
    // so the reported spread should stay far below the raw min/max (50m) —
    // nowhere near what an untrimmed mean/max would report.
    const tight = [0, 0, 0, 0, 0].map((offset) => buildLap({ lateralOffsetInCorner: offset }));
    const outlier = buildLap({ lateralOffsetInCorner: 50 });
    const result = computeLineSpreadTrace([...tight, outlier], [1, 2, 3, 4, 5, 6], corners);
    expect(result).not.toBeNull();
    expect(result!.lapCount).toBe(6);

    const t1 = result!.perCorner.find((c) => c.corner === "T1")!;
    // Untrimmed, the outlier alone would put the raw range at ~50m; the
    // percentile trim pulls the reported spread well below that even though
    // one outlier among six still drags the per-lap mean it's measured
    // against.
    expect(t1.lateralSpreadM).toBeGreaterThan(0);
    expect(t1.lateralSpreadM).toBeLessThan(30);
  });

  test("a too-short lap is dropped from lapLines along with the trace", () => {
    const good = [buildLap(), buildLap(), buildLap()];
    const tooShort = [pkt({ DistanceTraveled: 0, PositionX: 0, PositionZ: 0 })]; // single packet -> resampleLap returns null
    const lapIds = [401, 402, 403, 404];
    const result = computeLineSpreadTrace([...good, tooShort], lapIds, corners);
    expect(result).not.toBeNull();
    expect(result!.lapCount).toBe(3);
    expect(result!.lapLines.length).toBe(3);
    expect(result!.lapLines.map((l) => l.lapId).sort()).toEqual([401, 402, 403]);
  });
});

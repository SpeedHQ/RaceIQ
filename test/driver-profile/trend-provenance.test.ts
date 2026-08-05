import { describe, expect, test } from "bun:test";

import { buildDriverFingerprint } from "../../server/driver-profile/fingerprint";
import { buildDriverTrend, DRIVER_TREND_WINDOW_LAPS } from "../../server/driver-profile/trend";
import { GLOBAL_SCOPE, insight, lap } from "../support/driver-profile/factories";

describe("normalized driver trend", () => {
  test("uses newest-first 70-lap slices and leaves oldest laps for benchmarks", () => {
    const laps = Array.from({ length: 70 }, (_, i) => lap(70 - i, { lapTime: 100 + (70 - i) / 100 }));
    const trend = buildDriverTrend(laps);
    expect(DRIVER_TREND_WINDOW_LAPS).toBe(30);
    expect(trend.recent.laps.map((x) => x.id)).toEqual(Array.from({ length: 30 }, (_, i) => 41 + i));
    expect(trend.previous.laps.map((x) => x.id)).toEqual(Array.from({ length: 30 }, (_, i) => 11 + i));
    expect(trend.recent.total).toBe(30);
    expect(trend.previous.total).toBe(30);
    expect(trend.recent.normalized).toBe(30);
    expect(trend.previous.normalized).toBe(30);
    expect(trend.recent.laps.find((x) => x.id === 70)?.relativePacePct).toBeCloseTo((100.7 / 100.01 - 1) * 100, 8);
  });

  test("keeps dirty laps, lowers clean rate, and includes them in normalized spread", () => {
    const clean = Array.from({ length: 60 }, (_, i) => lap(60 - i, { lapTime: 100 }));
    for (let i = 0; i < 16; i++) {
      clean[i].isValid = false;
      clean[i].lapTime = 130;
    }
    const trend = buildDriverTrend(clean);
    expect(trend.recent.laps.map((x) => x.id)).toContain(60);
    expect(trend.recent.dirty).toBe(16);
    expect(trend.recent.cleanRate).toBeCloseTo(14 / 30, 8);
    expect(trend.recent.normalized).toBe(30);
    expect(trend.recent.medianPacePct).toBeGreaterThan(0);
    expect(trend.recent.spreadPct).toBeGreaterThan(0);
    expect(trend.recent.consistency).toBeLessThan(100);
  });

  test("invalid shortcut faster than valid benchmark clamps relative pace at zero", () => {
    const laps = [
      lap(3, { lapTime: 90, isValid: false }),
      lap(2, { lapTime: 100, isValid: true }),
      lap(1, { lapTime: 110, isValid: true }),
    ];
    const trend = buildDriverTrend(laps);
    expect(trend.recent.laps.find((x) => x.id === 3)?.relativePacePct).toBe(0);
    expect(trend.recent.medianPacePct).toBe(0);
  });

  test("normalizes mixed 90-second and 200-second contexts to percentages", () => {
    const laps = [
      ...Array.from({ length: 3 }, (_, i) => lap(6 - i, { trackOrdinal: 1, lapTime: 90 + i })),
      ...Array.from({ length: 3 }, (_, i) => lap(3 - i, { trackOrdinal: 2, lapTime: 200 + i })),
    ];
    const trend = buildDriverTrend(laps);
    expect(trend.recent.contexts).toBe(2);
    expect(trend.recent.medianPacePct).toBeGreaterThanOrEqual(0);
    expect(trend.recent.spreadPct).toBeLessThan(5);
    expect(JSON.stringify(trend)).not.toContain("90");
    expect(JSON.stringify(trend)).not.toContain("200");
  });

  test("benchmarks stay isolated per game context", () => {
    const trend = buildDriverTrend([
      lap(4, { gameId: "fm-2023", lapTime: 90, isValid: false }),
      lap(3, { gameId: "fm-2023", lapTime: 100 }),
      lap(2, { gameId: "acc", lapTime: 190, isValid: false }),
      lap(1, { gameId: "acc", lapTime: 200 }),
    ]);
    expect(trend.recent.contexts).toBe(2);
    expect(trend.recent.laps.find((x) => x.id === 4)?.relativePacePct).toBe(0);
    expect(trend.recent.laps.find((x) => x.id === 2)?.relativePacePct).toBe(0);
  });

  test("missing valid benchmark keeps lap totals and produces null pace", () => {
    const laps = [lap(2, { trackOrdinal: 99, lapTime: 90, isValid: false }), lap(1, { trackOrdinal: 1, lapTime: 100 })];
    const trend = buildDriverTrend(laps);
    expect(trend.recent.total).toBe(2);
    expect(trend.recent.dirty).toBe(1);
    expect(trend.recent.laps.find((x) => x.id === 2)?.relativePacePct).toBeNull();
    expect(trend.recent.normalized).toBe(1);
  });

  test("builds baseline when each window has only one normalized lap", () => {
    const recentPadding = Array.from({ length: 29 }, (_, i) => lap(100 + i, { trackOrdinal: 900 + i, isValid: false, lapTime: 90 }));
    const trend = buildDriverTrend([
      lap(2, { lapTime: 100 }),
      ...recentPadding,
      lap(1, { lapTime: 100 }),
    ]);
    expect(trend.recent.normalized).toBe(1);
    expect(trend.previous.normalized).toBe(1);
    expect(trend.recent.consistency).toBeNull();
    expect(trend.previous.consistency).toBeNull();
    expect(trend.advice[0].id).toBe("build-baseline");
  });

  test("direction boundaries are inclusive and advice covers every branch", () => {
    const make = (recentPace: number, previousPace: number, recentSpread: number, previousSpread: number, recentValid = true, previousValid = true) => {
      const recent = Array.from({ length: 30 }, (_, i) => lap(60 - i, { lapTime: recentPace + (i === 0 ? recentSpread : 0), isValid: recentValid }));
      const previous = Array.from({ length: 30 }, (_, i) => lap(30 - i, { lapTime: previousPace + (i === 0 ? previousSpread : 0), isValid: previousValid }));
      return buildDriverTrend([...recent, ...previous]);
    };
    const improving = make(90, 90.225, 0, 10);
    expect(improving.paceDirection).toBe("improving");
    const declining = make(90.225, 90, 0, 0);
    expect(declining.paceDirection).toBe("declining");
    const steady = make(90.1, 90, 0, 0);
    expect(steady.paceDirection).toBe("steady");
    expect(buildDriverTrend([]).advice[0].id).toBe("build-baseline");
    expect(improving.advice[0].id).toBe("keep-approach");
    expect(make(90, 90.3, 10, 0).advice[0].id).toBe("stabilize-pace");
    expect(make(90.1, 90, 0, 10).advice[0].id).toBe("add-pace");
    expect(make(90.2, 90, 10, 0).advice[0].id).toBe("reset-baseline");
    expect(steady.advice[0].id).toBe("hold-steady");
    expect(make(90, 90, 0, 0, false, true).advice.map((a) => a.id)).toContain("protect-validity");
  });
});

describe("trend provenance", () => {
  test("dirty telemetry contributes evidence; missing telemetry changes provenance only", () => {
    const metadata = [lap(2, { isValid: false, lapTime: 110 }), lap(1, { lapTime: 100 })];
    const trend = buildDriverTrend(metadata);
    const withDirtyTelemetry = buildDriverFingerprint({
      scope: GLOBAL_SCOPE,
      laps: [metadata[0]],
      perLapInsights: [[insight("driving-coasting")]],
      trend,
      pool: { candidates: 2, droppedNoTelemetry: 1 },
    });
    const withoutTelemetry = buildDriverFingerprint({
      scope: GLOBAL_SCOPE,
      laps: [],
      perLapInsights: [],
      trend,
      pool: { candidates: 2, droppedNoTelemetry: 2 },
    });
    expect(withDirtyTelemetry.detectors.map((d) => d.id)).toContain("driving-coasting");
    expect(withDirtyTelemetry.trend).toEqual(withoutTelemetry.trend);
    expect(withDirtyTelemetry.laps.droppedNoTelemetry).toBe(1);
    expect(withoutTelemetry.laps.droppedNoTelemetry).toBe(2);
    expect(withoutTelemetry.ok).toBe(true);
  });
});

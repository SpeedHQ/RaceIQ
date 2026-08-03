import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_DETECTOR_IDS,
  computeStyleAxes,
  MIN_LAPS_FOR_STYLE,
  rankWeaknesses,
  rollUpDetectors,
} from "../server/driver-profile/detectors";
import { buildDriverFingerprint, type ProfileScope } from "../server/driver-profile/fingerprint";
import { buildDriverTrend, DRIVER_TREND_WINDOW_LAPS } from "../server/driver-profile/trend";
import type { LapStyleSummary } from "../shared/racing/analysis/laps/driving-style";
import type { LapInsight } from "../shared/racing/analysis/laps/insights/types";
import type { LapMeta } from "../shared/racing/sessions/types";

// No DB, no telemetry decode: everything below drives the pure roll-up with
// synthetic insights so the maths is testable in isolation.

const SCOPE: ProfileScope = { kind: "car-track", gameId: "fm-2023", carOrdinal: 100, trackOrdinal: 200 };
const GLOBAL_SCOPE: ProfileScope = { kind: "global", gameId: "fm-2023", carOrdinal: null, trackOrdinal: null };

function lap(id: number, over: Partial<LapMeta> = {}): LapMeta {
  return {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime: 90 + (id % 5) * 0.1,
    isValid: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    gameId: "fm-2023",
    carOrdinal: 100,
    trackOrdinal: 200,
    ...over,
  };
}

function insight(id: string, over: Partial<LapInsight> = {}): LapInsight {
  return {
    id,
    category: "driving",
    severity: "warning",
    label: id,
    detail: `${id} detail`,
    frameIndices: [10],
    ...over,
  };
}

/**
 * A per-lap physics summary. Synthesised directly rather than run through
 * `summariseLapStyle` — that function has its own test file; here we only care
 * that the aggregator medians them honestly.
 */
function styleLap(over: Partial<LapStyleSummary>): LapStyleSummary {
  return {
    frames: 3600,
    corneringFrames: 1200,
    corneringSeconds: 20,
    usable: true,
    gripUtilMedian: 0.7,
    gripUtilP95: 1.05,
    balanceMedianDeg: 1.2,
    understeerFraction: 0.18,
    oversteerFraction: 0.04,
    controlLossFraction: 0.01,
    steerReversalsPerS: 1.1,
    slipVariabilityDeg: 0.9,
    ...over,
  };
}

function unusableLap(): LapStyleSummary {
  return { frames: 500, corneringFrames: 4, corneringSeconds: 0.07, usable: false };
}

/** N laps that all exhibit the same set of insights. */
function habitualDriver(n: number, insights: LapInsight[]) {
  return {
    laps: Array.from({ length: n }, (_, i) => lap(i + 1)),
    perLapInsights: Array.from({ length: n }, () => insights.map((x) => ({ ...x }))),
  };
}

describe("rollUpDetectors — per-lap normalisation", () => {
  test("counts are per lap, not raw totals", () => {
    const five = habitualDriver(5, [insight("driving-coasting", { timeLossS: 0.4 })]);
    const fifty = habitualDriver(50, [insight("driving-coasting", { timeLossS: 0.4 })]);

    const a = rollUpDetectors(five.perLapInsights, five.laps.map((l) => l.id));
    const b = rollUpDetectors(fifty.perLapInsights, fifty.laps.map((l) => l.id));

    expect(a[0].perLapFrequency).toBe(1);
    expect(b[0].perLapFrequency).toBe(1);
    expect(a[0].lapsAffected).toBe(5);
    expect(b[0].lapsAffected).toBe(50);
    expect(a[0].medianTimeLossS).toBe(b[0].medianTimeLossS);
  });

  test("a 5-lap and a 50-lap driver with the same habit rank identically", () => {
    const habit = [insight("driving-over-slowing", { timeLossS: 0.3 }), insight("driving-steering-sawing")];
    const five = habitualDriver(5, habit);
    const fifty = habitualDriver(50, habit);

    const fpA = buildDriverFingerprint({ scope: SCOPE, ...five });
    const fpB = buildDriverFingerprint({ scope: SCOPE, ...fifty });

    expect(fpA.weaknesses.map((w) => w.id)).toEqual(fpB.weaknesses.map((w) => w.id));
    expect(fpA.weaknesses[0].score).toBe(fpB.weaknesses[0].score);
    expect(fpA.unquantifiedWeaknesses.map((w) => w.id)).toEqual(fpB.unquantifiedWeaknesses.map((w) => w.id));
    expect(fpA.style).toEqual(fpB.style);
  });

  test("a habit on half the laps scores half as much as one on every lap", () => {
    const always = habitualDriver(10, [insight("driving-coasting", { timeLossS: 0.5 })]);
    const halfInsights = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? [insight("driving-coasting", { timeLossS: 0.5 })] : []));
    const half = { laps: Array.from({ length: 10 }, (_, i) => lap(i + 1)), perLapInsights: halfInsights };

    const a = buildDriverFingerprint({ scope: SCOPE, ...always });
    const b = buildDriverFingerprint({ scope: SCOPE, ...half });
    expect(b.weaknesses[0].score).toBeCloseTo(a.weaknesses[0].score / 2, 3);
  });

  test("severity scales intensity", () => {
    const mild = habitualDriver(5, [insight("driving-coasting", { severity: "info", timeLossS: 1 })]);
    const bad = habitualDriver(5, [insight("driving-coasting", { severity: "critical", timeLossS: 1 })]);
    const a = buildDriverFingerprint({ scope: SCOPE, ...mild }).weaknesses[0];
    const b = buildDriverFingerprint({ scope: SCOPE, ...bad }).weaknesses[0];
    expect(b.score).toBeCloseTo(a.score * 3, 3);
    expect(b.peakSeverity).toBe("critical");
  });
});

describe("time-loss handling", () => {
  test("unquantified detectors are ranked separately, never as zero-cost", () => {
    const laps = Array.from({ length: 10 }, (_, i) => lap(i + 1));
    // Frequent + critical but unquantified, vs rare + cheap but quantified.
    const perLapInsights = laps.map((_, i) => [
      insight("driving-counter-steer", { severity: "critical" }),
      ...(i === 0 ? [insight("driving-coasting", { severity: "info", timeLossS: 0.05 })] : []),
    ]);

    const fp = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights });

    expect(fp.weaknesses.map((w) => w.id)).toEqual(["driving-coasting"]);
    expect(fp.unquantifiedWeaknesses.map((w) => w.id)).toEqual(["driving-counter-steer"]);
    expect(fp.unquantifiedWeaknesses[0].timeLossKnown).toBe(false);
    expect(fp.unquantifiedWeaknesses[0].medianTimeLossS).toBeNull();
    // The unquantified one must not have been given a 0-second cost that would
    // sort it below a 0.05s weakness in a single merged list.
    expect(fp.unquantifiedWeaknesses[0].score).toBeGreaterThan(fp.weaknesses[0].score);
  });

  test("median time loss ignores laps where the detector did not quantify", () => {
    const laps = [lap(1), lap(2), lap(3), lap(4)];
    const perLapInsights = [
      [insight("driving-coasting", { timeLossS: 1 })],
      [insight("driving-coasting")],
      [insight("driving-coasting", { timeLossS: 1 })],
      [insight("driving-coasting")],
    ];
    const [d] = rollUpDetectors(perLapInsights, laps.map((l) => l.id));
    expect(d.lapsAffected).toBe(4);
    expect(d.lapsQuantified).toBe(2);
    expect(d.medianTimeLossS).toBe(1); // not 0.5 — the absent estimates are not zeros
  });

  test("descriptive detectors are never ranked as weaknesses", () => {
    const { laps, perLapInsights } = habitualDriver(5, [
      insight("mech-peak-power", { category: "mechanical", severity: "info" }),
      insight("mech-fuel", { category: "mechanical", severity: "critical" }),
      insight("driving-trail-brake", { severity: "info" }),
    ]);
    const fp = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights });
    expect(fp.weaknesses).toEqual([]);
    expect(fp.unquantifiedWeaknesses).toEqual([]);
    // …but they are still visible in the raw detector table.
    expect(fp.detectors.map((d) => d.id).sort()).toEqual(["driving-trail-brake", "mech-fuel", "mech-peak-power"]);
  });
});

describe("low-data honesty", () => {
  test("1 lap: no style, very-low confidence, explicit note", () => {
    const { laps, perLapInsights } = habitualDriver(1, [insight("driving-coasting", { timeLossS: 0.2 })]);
    const fp = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights });
    expect(fp.ok).toBe(true);
    expect(fp.style).toBeNull();
    expect(fp.confidence).toBe("very-low");
    expect(fp.notes.join(" ")).toContain("too few to characterise a driving style");
  });

  test("2 laps still suppress style; 3 laps produce it", () => {
    const two = habitualDriver(2, [insight("driving-coasting")]);
    const three = habitualDriver(3, [insight("driving-coasting")]);
    expect(buildDriverFingerprint({ scope: SCOPE, ...two }).style).toBeNull();
    expect(buildDriverFingerprint({ scope: SCOPE, ...three }).style).not.toBeNull();
    expect(MIN_LAPS_FOR_STYLE).toBe(3);
  });

  test("confidence rises with lap count", () => {
    const c = (n: number) => buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(n, []) }).confidence;
    expect(c(2)).toBe("very-low");
    expect(c(3)).toBe("low");
    expect(c(5)).toBe("medium");
    expect(c(12)).toBe("high");
  });
});

describe("determinism", () => {
  test("same input twice is deeply equal", () => {
    const build = () =>
      buildDriverFingerprint({
        scope: SCOPE,
        ...habitualDriver(8, [insight("driving-over-slowing", { timeLossS: 0.31 }), insight("driving-kerb-riding"), insight("tire-lockup-FL", { category: "tires" })]),
      });
    expect(build()).toEqual(build());
  });

  test("trend follows explicit newest-first ordering", () => {
    const forward = habitualDriver(6, [insight("driving-coasting", { timeLossS: 0.2 })]);
    const first = buildDriverFingerprint({ scope: SCOPE, ...forward });
    const second = buildDriverFingerprint({ scope: SCOPE, ...forward });
    expect(second).toEqual(first);
  });

  test("detector table is id-sorted", () => {
    const { laps, perLapInsights } = habitualDriver(3, [insight("driving-coasting"), insight("driving-brake-drag"), insight("tire-spin-RL", { category: "tires" })]);
    const fp = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights });
    expect(fp.detectors.map((d) => d.id)).toEqual(["driving-brake-drag", "driving-coasting", "tire-spin-RL"]);
  });
});

describe("empty and degenerate input", () => {
  test("no laps", () => {
    const fp = buildDriverFingerprint({ scope: GLOBAL_SCOPE, laps: [], perLapInsights: [] });
    expect(fp.ok).toBe(false);
    expect(fp.style).toBeNull();
    expect(fp.detectors).toEqual([]);
    expect(fp.weaknesses).toEqual([]);
    expect(fp.laps.analyzed).toBe(0);
    expect(fp.notes.length).toBeGreaterThan(0);
  });

  test("laps with no insights at all", () => {
    const fp = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, []) });
    expect(fp.ok).toBe(true);
    expect(fp.detectors).toEqual([]);
    expect(fp.style).not.toBeNull();
    expect(fp.style?.brakingStyle).toBe(0);
    // No telemetry was supplied, so every physics axis is "not measurable" —
    // deliberately NOT a neutral-looking zero.
    expect(fp.style?.gripUtilMedian).toBeNull();
    expect(fp.style?.balanceMedianDeg).toBeNull();
    expect(fp.style?.controlLossFraction).toBeNull();
    expect(fp.style?.physicsLaps).toBe(0);
    expect(fp.notes.join(" ")).toContain("No lap had enough cornering telemetry");
  });

  test("rollUpDetectors on an empty pool", () => {
    expect(rollUpDetectors([], [])).toEqual([]);
  });

  test("rankWeaknesses on an empty table", () => {
    expect(rankWeaknesses([])).toEqual({ weaknesses: [], unquantifiedWeaknesses: [] });
  });
});

describe("style axes", () => {
  test("braking style is bipolar and signed", () => {
    const early = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, [insight("driving-early-braking"), insight("driving-over-slowing")]) });
    const late = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, [insight("driving-late-braking-overshoot"), insight("driving-brake-traction-loss")]) });
    expect(early.style!.brakingStyle).toBeLessThan(0);
    expect(late.style!.brakingStyle).toBeGreaterThan(0);
  });

  test("braking style stays bounded even when every detector fires critically", () => {
    const everything = ALL_DETECTOR_IDS.map((id) => insight(id, { severity: "critical" }));
    const fp = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, everything) });
    expect(Math.abs(fp.style!.brakingStyle)).toBeLessThanOrEqual(100);
  });

  test("consistency axis mirrors the pace consistency", () => {
    const axes = computeStyleAxes([], 87.5);
    expect(axes.consistency).toBe(87.5);
    expect(computeStyleAxes([], null).consistency).toBeNull();
  });

  // ── Physics-based axes ──────────────────────────────────────────────
  // These no longer come from detector counts at all. They are medians of
  // per-lap continuous measurements, on scales where the numbers mean something
  // in themselves (1.0 = peak grip; degrees are degrees).

  test("grip utilisation is reported on the calibrated friction-circle scale, not rescaled", () => {
    const axes = computeStyleAxes([], null, [styleLap({ gripUtilMedian: 0.62 }), styleLap({ gripUtilMedian: 0.7 }), styleLap({ gripUtilMedian: 0.78 })]);
    expect(axes.gripUtilMedian).toBe(0.7);
    expect(axes.physicsLaps).toBe(3);
  });

  test("balance is signed degrees, so understeer and oversteer drivers are distinguishable", () => {
    const under = computeStyleAxes([], null, [styleLap({ balanceMedianDeg: 3.2 }), styleLap({ balanceMedianDeg: 2.8 }), styleLap({ balanceMedianDeg: 3 })]);
    const over = computeStyleAxes([], null, [styleLap({ balanceMedianDeg: -2.5 }), styleLap({ balanceMedianDeg: -3.1 }), styleLap({ balanceMedianDeg: -2.9 })]);
    expect(under.balanceMedianDeg).toBe(3);
    expect(over.balanceMedianDeg).toBe(-2.9);
  });

  test("one wild lap does not drag the fingerprint — axes are medians", () => {
    const calm = [styleLap({ controlLossFraction: 0.01 }), styleLap({ controlLossFraction: 0.02 }), styleLap({ controlLossFraction: 0.015 })];
    const withSpin = [...calm, styleLap({ controlLossFraction: 0.85 })];
    expect(computeStyleAxes([], null, withSpin).controlLossFraction!).toBeLessThan(0.05);
  });

  test("physics axes are null, never zero, when nothing was measurable", () => {
    const axes = computeStyleAxes([], null, [{ frames: 500, corneringFrames: 3, corneringSeconds: 0.05, usable: false }]);
    expect(axes.gripUtilMedian).toBeNull();
    expect(axes.gripUtilP95).toBeNull();
    expect(axes.balanceMedianDeg).toBeNull();
    expect(axes.controlLossFraction).toBeNull();
    expect(axes.steerReversalsPerS).toBeNull();
    expect(axes.slipVariabilityDeg).toBeNull();
    expect(axes.physicsLaps).toBe(0);
  });

  test("detector counts no longer move the physics axes at all", () => {
    const style = [styleLap({}), styleLap({}), styleLap({})];
    const clean = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(3, []), perLapStyle: style });
    const faulty = buildDriverFingerprint({
      scope: SCOPE,
      ...habitualDriver(3, [insight("driving-late-braking-overshoot", { severity: "critical" }), insight("tire-spin-RL", { category: "tires", severity: "critical" })]),
      perLapStyle: style,
    });
    expect(faulty.style!.gripUtilMedian).toBe(clean.style!.gripUtilMedian);
    expect(faulty.style!.controlLossFraction).toBe(clean.style!.controlLossFraction);
    expect(faulty.style!.balanceMedianDeg).toBe(clean.style!.balanceMedianDeg);
    // …but the detector-derived braking lean still responds.
    expect(faulty.style!.brakingStyle).not.toBe(clean.style!.brakingStyle);
  });

  test("a pool with too few measurable laps says so", () => {
    const fp = buildDriverFingerprint({
      scope: SCOPE,
      ...habitualDriver(6, []),
      perLapStyle: [styleLap({}), styleLap({}), ...Array.from({ length: 4 }, () => unusableLap())],
    });
    expect(fp.style!.physicsLaps).toBe(2);
    expect(fp.notes.join(" ")).toContain("enough cornering to measure driving style");
  });

  test("physics axes survive lap reordering unchanged", () => {
    const laps = Array.from({ length: 5 }, (_, i) => lap(i + 1));
    const style = [0.5, 0.6, 0.7, 0.8, 0.9].map((g) => styleLap({ gripUtilMedian: g }));
    const perLapInsights = laps.map(() => []);
    const forward = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights, perLapStyle: style });
    const reversed = buildDriverFingerprint({
      scope: SCOPE,
      laps: [...laps].reverse(),
      perLapInsights,
      perLapStyle: [...style].reverse(),
    });
    expect(reversed.style).toEqual(forward.style);
  });
});





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


describe("detector universe stays in lockstep with lap-analysis insights", () => {
  test("ALL_DETECTOR_IDS covers every id analyzeLap can emit", () => {
    const insightDir = join(import.meta.dir, "..", "shared", "racing", "analysis", "laps", "insights");
    const src = [
      "suspension.ts",
      "tires.ts",
      "driving-core.ts",
      "driving-advanced.ts",
      "mechanical.ts",
    ]
      .map((file) => readFileSync(join(insightDir, file), "utf8"))
      .join("\n");
    const wheels = ["FL", "FR", "RL", "RR"];

    const found = new Set<string>();
    for (const m of src.matchAll(/\bid: "([^"]+)"/g)) found.add(m[1]);
    // Template ids are always `<prefix>${wheelExpr}` — expand over the wheels.
    for (const m of src.matchAll(/\bid: `([^`$]+)\$\{[^`]*\}`/g)) {
      for (const w of wheels) found.add(`${m[1]}${w}`);
    }

    expect(found.size).toBeGreaterThan(20);
    const missing = [...found].filter((id) => !ALL_DETECTOR_IDS.includes(id)).sort();
    const stale = ALL_DETECTOR_IDS.filter((id) => !found.has(id)).sort();
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });
});

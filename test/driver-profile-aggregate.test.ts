import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_DETECTOR_IDS,
  buildDriverFingerprint,
  computePace,
  computeStyleAxes,
  findStrengths,
  MAX_PROFILE_LAPS,
  MIN_LAPS_FOR_STYLE,
  rankWeaknesses,
  rollUpDetectors,
  sampleProfileLaps,
  type ProfileScope,
} from "../server/ai/driver-profile-aggregate";
import { selectCleanLaps } from "../server/ai/clean-lap-aggregate";
import type { LapStyleSummary } from "../shared/lib/driving-style";
import type { LapInsight } from "../shared/lib/lap-insights";
import type { LapMeta } from "../shared/types";

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
    expect(fp.strengths).toEqual([]);
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

  test("lap ordering does not affect the fingerprint", () => {
    const habit = [insight("driving-coasting", { timeLossS: 0.2 })];
    const forward = habitualDriver(6, habit);
    const reversed = {
      laps: [...forward.laps].reverse(),
      perLapInsights: [...forward.perLapInsights].reverse(),
    };
    expect(buildDriverFingerprint({ scope: SCOPE, ...reversed })).toEqual(buildDriverFingerprint({ scope: SCOPE, ...forward }));
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
    // Every driver fault is a strength when none of them ever fired.
    expect(fp.strengths.every((s) => s.basis === "absent")).toBe(true);
    expect(fp.strengths.length).toBeGreaterThan(15);
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

describe("strengths", () => {
  test("require enough laps to mean anything", () => {
    expect(findStrengths([], MIN_LAPS_FOR_STYLE - 1)).toEqual([]);
    expect(findStrengths([], MIN_LAPS_FOR_STYLE).length).toBeGreaterThan(0);
  });

  test("a frequent fault is not a strength; a rare info-only one is", () => {
    const laps = Array.from({ length: 10 }, (_, i) => lap(i + 1));
    const perLapInsights = laps.map((_, i) => [
      insight("driving-coasting", { severity: "warning" }),
      ...(i === 0 ? [insight("driving-kerb-riding", { severity: "info" })] : []),
    ]);
    const fp = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights });
    const ids = fp.strengths.map((s) => s.id);
    expect(ids).not.toContain("driving-coasting");
    expect(ids).toContain("driving-kerb-riding");
    expect(fp.strengths.find((s) => s.id === "driving-kerb-riding")!.basis).toBe("rare");
  });

  test("setup symptoms are not credited as driver strengths", () => {
    const fp = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, []) });
    const ids = fp.strengths.map((s) => s.id);
    expect(ids.some((id) => id.startsWith("susp-"))).toBe(false);
    expect(ids.some((id) => id.startsWith("mech-"))).toBe(false);
    expect(ids).toContain("tire-lockup-FL");
  });
});

describe("pace", () => {
  test("single car+track context keeps seconds-valued stats", () => {
    const laps = [lap(1, { lapTime: 90 }), lap(2, { lapTime: 90.5 }), lap(3, { lapTime: 91 }), lap(4, { lapTime: 91.5 })];
    const pace = computePace(laps);
    expect(pace.basis).toBe("single-context");
    expect(pace.contexts).toBe(1);
    expect(pace.n).toBe(4);
    expect(pace.bestS).toBe(90);
    expect(pace.degSlopeSPerLap).toBeCloseTo(0.5, 6);
  });

  test("multi-context pools drop incomparable seconds and median the unitless stats", () => {
    const laps = [
      lap(1, { trackOrdinal: 1, lapTime: 90, lapNumber: 1 }),
      lap(2, { trackOrdinal: 1, lapTime: 90.5, lapNumber: 2 }),
      lap(3, { trackOrdinal: 1, lapTime: 91, lapNumber: 3 }),
      lap(4, { trackOrdinal: 2, lapTime: 200, lapNumber: 1 }),
      lap(5, { trackOrdinal: 2, lapTime: 201, lapNumber: 2 }),
      lap(6, { trackOrdinal: 2, lapTime: 202, lapNumber: 3 }),
    ];
    const pace = computePace(laps);
    expect(pace.basis).toBe("median-of-contexts");
    expect(pace.contexts).toBe(2);
    expect(pace.meanS).toBeNull();
    expect(pace.bestS).toBeNull();
    expect(pace.sdS).toBeNull();
    expect(pace.consistency).not.toBeNull();
    expect(pace.n).toBe(6);
  });

  test("out-lap is not dropped — the pool is already curated", () => {
    const laps = [lap(1, { lapNumber: 1, lapTime: 90 }), lap(2, { lapNumber: 2, lapTime: 91 })];
    expect(computePace(laps).n).toBe(2);
  });
});

describe("sampleProfileLaps", () => {
  test("passes small pools through, id-ascending", () => {
    const laps = [lap(3), lap(1), lap(2)];
    const { selected, droppedByCap } = sampleProfileLaps(laps);
    expect(selected.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(droppedByCap).toBe(0);
  });

  test("caps large pools, keeping both the fastest and the most recent", () => {
    // Lap 1 is by far the fastest; laps 900+ are the most recent.
    const laps = Array.from({ length: 200 }, (_, i) => lap(i + 1, { lapTime: 100 - (i === 0 ? 50 : 0) + i * 0.01 }));
    const { selected, droppedByCap } = sampleProfileLaps(laps);
    expect(selected.length).toBe(MAX_PROFILE_LAPS);
    expect(droppedByCap).toBe(200 - MAX_PROFILE_LAPS);
    expect(selected.map((l) => l.id)).toContain(1); // fastest
    expect(selected.map((l) => l.id)).toContain(200); // most recent
    expect([...selected].sort((a, b) => a.id - b.id).map((l) => l.id)).toEqual(selected.map((l) => l.id));
  });

  test("selection is independent of input order", () => {
    const laps = Array.from({ length: 120 }, (_, i) => lap(i + 1, { lapTime: 90 + ((i * 7) % 13) * 0.1 }));
    const a = sampleProfileLaps(laps).selected.map((l) => l.id);
    const b = sampleProfileLaps([...laps].reverse()).selected.map((l) => l.id);
    expect(a).toEqual(b);
  });
});

describe("selectCleanLaps user-exclusion opt-out", () => {
  const pool: LapMeta[] = [lap(1, { lapTime: 90 }), lap(2, { lapTime: 90.2, tuningExcluded: true }), lap(3, { lapTime: 90.4 })];

  test("default behaviour is unchanged — excluded laps are dropped", () => {
    const { clean, breakdown } = selectCleanLaps(pool);
    expect(clean.map((l) => l.id)).toEqual([1, 3]);
    expect(breakdown.find((r) => r.lapId === 2)!.reason).toBe("user-excluded");
  });

  test("applyUserExclusions: false keeps laps the driver actually drove", () => {
    const { clean, breakdown } = selectCleanLaps(pool, { applyUserExclusions: false });
    expect(clean.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(breakdown.every((r) => r.reason !== "user-excluded")).toBe(true);
  });

  test("invalid laps are still dropped either way", () => {
    const withInvalid = [...pool, lap(4, { isValid: false })];
    const { clean } = selectCleanLaps(withInvalid, { applyUserExclusions: false });
    expect(clean.map((l) => l.id)).not.toContain(4);
  });
});

describe("detector universe stays in lockstep with lap-insights", () => {
  test("ALL_DETECTOR_IDS covers every id analyzeLap can emit", () => {
    const src = readFileSync(join(import.meta.dir, "..", "shared", "lib", "lap-insights.ts"), "utf8");
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

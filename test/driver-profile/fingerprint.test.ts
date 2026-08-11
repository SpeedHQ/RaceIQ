import { describe, expect, test } from "bun:test";

import { rankWeaknesses, rollUpDetectors, MIN_LAPS_FOR_STYLE } from "../../server/driver-profile/detectors";
import { buildDriverFingerprint } from "../../server/driver-profile/fingerprint";
import { GLOBAL_SCOPE, SCOPE, habitualDriver, insight, lap } from "../support/driver-profile/factories";

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

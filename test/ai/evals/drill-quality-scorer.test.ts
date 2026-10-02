import { describe, expect, test } from "bun:test";
import { SCORER_THRESHOLDS, scoreOutput } from "../../../mastra/evals";
import { drillQualityScorer } from "../../../mastra/evals/scorers/drill-quality";

/**
 * `drill-quality` is the gate that stops the Driver Coach recording coaching
 * that cannot be measured.
 *
 * A setup recommendation is anchored by the deterministic rules engine — the
 * model picks a direction, code computes the number. A drill has no such
 * anchor, so "be smoother through the middle sector" would sail into the
 * version tree as an arm and then be judged on lap-time spread it can never
 * meaningfully move.
 *
 * These cases are the scorer's own spec: they pin what it rewards and what it
 * refuses, independent of any model. (The fixture-driven eval that runs a real
 * agent lives in test/ai/evals/ai-quality.ai-eval.ts and needs an API key.)
 */

const TRACK = { trackCorners: ["Les Combes", "Eau Rouge", "Stavelot"] };

const score = async (output: unknown, groundTruth: unknown = TRACK) =>
  (await scoreOutput(drillQualityScorer, output, groundTruth)).score;

describe("drill-quality: what a good drill looks like", () => {
  test("a located, actionable, concrete, single-change drill scores 1.0", async () => {
    const drill = {
      title: "Brake 10m later into Les Combes",
      instruction: "Hold the brake to the 40m board instead of the 50m, then release progressively to the apex.",
      corners: ["Les Combes"],
    };
    expect(await score(drill)).toBe(1);
  });

  test("turn numbers count as a location — half the paddock names corners that way", async () => {
    const drill = {
      title: "Trail brake into T4",
      instruction: "Carry 10 bar of brake pressure past turn-in and release to zero at the apex.",
      corners: [],
    };
    expect(await score(drill)).toBe(1);
  });

  test("clears the shipped threshold", async () => {
    const drill = {
      title: "Later brake release at Stavelot",
      instruction: "Release the brake 5m later, aiming for the apex kerb.",
      corners: ["Stavelot"],
    };
    expect(await score(drill)).toBeGreaterThanOrEqual(SCORER_THRESHOLDS["drill-quality"]);
  });
});

describe("drill-quality: what it refuses", () => {
  test("vague coaching scores low — it is not repeatable and not measurable", async () => {
    // The exact failure mode the coach's prompt calls out as NOT a drill.
    const vague = { title: "Be smoother", instruction: "Try to be smoother and more consistent through the middle sector.", corners: [] };
    const s = await score(vague);
    expect(s).toBeLessThan(SCORER_THRESHOLDS["drill-quality"]);
  });

  // ⚠️ Weighting regression guard. Under equal weights (0.25 each) both of the
  // next two cases scored exactly 0.75 — the pass mark — so the two failures
  // that most destroy measurability slipped through. LOCATED / ACTIONABLE /
  // SINGULAR are 0.3 each precisely so any one of them missing fails.
  test("two changes stapled together are refused — the result would be unreadable", async () => {
    const doubled = {
      title: "Braking and throttle",
      instruction:
        "Brake 10m later into Les Combes at the 40m board. And also squeeze the throttle 20m earlier on exit.",
      corners: ["Les Combes"],
    };
    const s = await score(doubled);
    expect(s).toBeLessThan(SCORER_THRESHOLDS["drill-quality"]);
    // Specifically the singular signal, not the others.
    const { reason } = await scoreOutput(drillQualityScorer, doubled, TRACK);
    expect(reason).toContain("more than one change");
  });

  test("a drill with no action to perform is refused, however well located", async () => {
    const inert = { title: "Les Combes", instruction: "Think about being more committed through Les Combes.", corners: ["Les Combes"] };
    expect(await score(inert)).toBeLessThan(SCORER_THRESHOLDS["drill-quality"]);
  });

  test("numbered steps are two drills wearing one coat", async () => {
    const steps = {
      title: "Entry work at T1",
      instruction: "1. Brake at the 50m board.\n2. Release to the apex over 20m.",
      corners: ["T1"],
    };
    expect(await score(steps)).toBeLessThan(SCORER_THRESHOLDS["drill-quality"]);
  });

  test("a drill with nowhere to run it loses the located signal", async () => {
    const nowhere = { title: "Brake later", instruction: "Brake 10m later than you have been.", corners: [] };
    const { score: s, reason } = await scoreOutput(drillQualityScorer, nowhere, TRACK);
    expect(s).toBeLessThan(SCORER_THRESHOLDS["drill-quality"]);
    expect(reason).toContain("no corner named");
  });

  test("empty output scores zero rather than passing on a technicality", async () => {
    expect(await score({ title: "", instruction: "", corners: [] })).toBe(0);
    expect(await score("")).toBe(0);
  });
});

describe("drill-quality: input shapes", () => {
  test("scores the DrillChange object record_drill actually writes", async () => {
    // Same shape as shared/racing/experiments/types.ts DrillChange, which is what lands in
    // experiment_versions.appliedChanges.
    const change = {
      kind: "drill",
      title: "Later brake release at Eau Rouge",
      instruction: "Release the brake 5m earlier and let the car run to the exit kerb.",
      corners: ["Eau Rouge"],
      reason: "Eau Rouge is the widest line spread in the stint",
    };
    expect(await score(change)).toBe(1);
  });

  test("also scores raw text, so a proposal in chat can be graded before it is recorded", async () => {
    const text = "Brake 10m later into Les Combes — hold to the 40m board, then release to the apex.";
    expect(await score(text)).toBe(1);
  });

  test("two actions at two different corners is two drills, and must fail", async () => {
    // The bundling form a model actually produces: one fluent sentence, no
    // "and also", two separate places to do something. It scores full marks on
    // LOCATED / ACTIONABLE / CONCRETE, so only SINGULAR can catch it — and if it
    // does not, the arm gets judged on a spread that two changes moved together.
    const bundled = {
      title: "Braking and throttle",
      instruction: "Brake 10m later at T4 and get on the throttle earlier at T7.",
      corners: [],
    };
    expect(await score(bundled)).toBeLessThan(SCORER_THRESHOLDS["drill-quality"]);
  });

  test("but two verbs at ONE corner is still a single drill", async () => {
    // The conservative half of the rule: a described action can have parts.
    const single = {
      title: "Trail brake into T4",
      instruction: "Brake at the 100m board and release progressively to the apex at T4.",
      corners: ["T4"],
    };
    expect(await score(single)).toBe(1);
  });

  test("mentioning a second corner as context does not make it two drills", async () => {
    const withContext = {
      title: "Earlier brake release at T4",
      instruction: "Release the brake 5m earlier at T4; you are losing the exit onto the T5 straight.",
      corners: ["T4"],
    };
    expect(await score(withContext)).toBeGreaterThanOrEqual(SCORER_THRESHOLDS["drill-quality"]);
  });

  test("a lap-wide drill is legitimately located", async () => {
    const lapWide = {
      title: "Eyes up",
      instruction: "Look to the apex before turn-in on every corner, not at the braking point.",
      corners: [],
    };
    // Deliberately allowed to clear the threshold without a numeric reference —
    // CONCRETE is the one signal weighted low (0.1) for exactly this case.
    expect(await score(lapWide)).toBeGreaterThanOrEqual(SCORER_THRESHOLDS["drill-quality"]);
  });
});

import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { buildSpectateFocus, focusRuns, inputFocusColor } from "../../ui/spectate-focus"
import type { SpectateLap, SpectatePair, SpectateSample } from "../../contracts/spectate"

initGameAdapters({ f1Experiments: true, iracingAdapter: true, ams2Adapter: true });

function sample(time: number, values: Record<string, unknown> = {}, run = 0): SpectateSample {
  return { time, distance: time, run, values };
}
function lap(samples: SpectateSample[]): SpectateLap {
  return { samples, duration: 10, distance: 10, hasProgress: true, replay: { lapId: 1, envelopes: [], requestedSemanticIds: [] } };
}
function pair(a: SpectateSample[], b: SpectateSample[] = []): SpectatePair {
  return { gameId: "f1-2025" as SpectatePair["gameId"], comparison: {} as SpectatePair["comparison"], a: lap(a), b: lap(b) };
}

describe("spectate focus classification", () => {
  test("brake takes precedence over throttle; absent or invalid controls are unavailable", () => {
    expect(inputFocusColor(sample(0, { "inputs.brake": 1, "inputs.accel": 1 }))).toBe("--ch-brake");
    expect(inputFocusColor(sample(0, { "inputs.brake": 0, "inputs.accel": 0.4 }))).toBe("--ch-throttle");
    expect(inputFocusColor(sample(0, { "inputs.brake": NaN, "inputs.accel": Infinity }))).toBe("--app-text-muted");
    expect(inputFocusColor(sample(0))).toBe("--app-text-muted");
  });

  test("ERS accepts numeric and digit-string modes only", () => {
    const focus = buildSpectateFocus(pair([]), "ers");
    const modes = ["none", "medium", "hotlap", "overtake"];
    modes.forEach((name, value) => {
      expect(focus.color(sample(0, { "fuel.ers-deploy-mode": value }))).toBe(`--telemetry-ers-mode-${name}`);
      expect(focus.color(sample(0, { "fuel.ers-deploy-mode": String(value) }))).toBe(`--telemetry-ers-mode-${name}`);
    });
    for (const value of [-1, 4, 1.5, "1.0", "", null, undefined]) {
      expect(focus.color(sample(0, { "fuel.ers-deploy-mode": value }))).toBe("--app-text-muted");
    }
  });

  test("balance distinguishes unavailable signals from neutral balance", () => {
    const focus = buildSpectateFocus(pair([]), "balance");
    expect(focus.color(sample(0))).toBe("--app-text-muted");
    expect(focus.color(sample(0, {
      "motion.speed": 20,
      "motion.acceleration-x": 0,
      "motion.angular-velocity-y": 0,
      "tires.tire-slip-angle": [0, 0, 0, 0],
    }))).toBe("--balance-neutral");
  });

  test("speed uses one A/B maximum and rejects invalid or negative speed", () => {
    const focus = buildSpectateFocus(pair(
      [sample(0, { "motion.speed": 29 }), sample(1, { "motion.speed": 59 })],
      [sample(0, { "motion.speed": 90 })],
    ), "speed");
    expect(focus.color(sample(0, { "motion.speed": 29 }))).toBe(focus.legend[0].token);
    expect(focus.color(sample(0, { "motion.speed": 59 }))).toBe(focus.legend[1].token);
    expect(focus.color(sample(0, { "motion.speed": 30 }))).toBe(focus.legend[1].token);
    expect(focus.color(sample(0, { "motion.speed": 60 }))).toBe(focus.legend[2].token);
    expect(focus.color(sample(0, { "motion.speed": 90 }))).toBe(focus.legend[2].token);
    for (const value of [-1, NaN, Infinity, "30", undefined]) {
      expect(focus.color(sample(0, { "motion.speed": value }))).toBe("--app-text-muted");
    }
  });

  test("focus runs split on telemetry gaps, native run changes, time gaps, and invalid positions", () => {
    const focus = buildSpectateFocus(pair([]), "speed");
    const runs = focusRuns([
      sample(0, { "motion.position-x": 0, "motion.position-z": 0, "motion.speed": 1 }),
      sample(0.05, { "motion.position-x": 1, "motion.position-z": 0, "motion.speed": 1 }),
      sample(0.1, { "motion.position-x": 2, "motion.position-z": 0, "motion.speed": 2 }),
      sample(0.15, { "motion.position-x": 3, "motion.position-z": 0, "motion.speed": 2 }),
      sample(0.2, { "motion.position-x": NaN, "motion.position-z": 0, "motion.speed": 2 }),
      sample(0.25, { "motion.position-x": 5, "motion.position-z": 0, "motion.speed": 2 }),
      sample(0.3, { "motion.position-x": 6, "motion.position-z": 0, "motion.speed": 2 }),
      sample(0.5, { "motion.position-x": 7, "motion.position-z": 0, "motion.speed": 2 }),
      sample(0.55, { "motion.position-x": 8, "motion.position-z": 0, "motion.speed": 2 }, 1),
      sample(0.6, { "motion.position-x": 9, "motion.position-z": 0, "motion.speed": 2 }, 1),
    ], focus);
    expect(runs.map((run) => run.points.map((point) => point.x))).toEqual([[0, 1, 2, 3], [5, 6], [8, 9]]);
  });
});

test("reduced-rate racing lines join valid intervals but keep missing positions and run boundaries", () => {
  const points = [0, 0.108, 0.217, 0.326, 0.65, 0.758, 0.866, 0.974].map((time, index) =>
    sample(time, { "motion.position-x": index, "motion.position-z": 0, "inputs.accel": 255, "inputs.brake": 0 }, index >= 6 ? 1 : 0));
  const focus = buildSpectateFocus(pair(points), "inputs");
  expect(focusRuns(points, focus, 0.162).map(run => run.points.map(point => point.x))).toEqual([[0, 1, 2, 3], [4, 5], [6, 7]]);
  points[1]!.values = { ...points[1]!.values, "motion.position-x": null };
  expect(focusRuns(points, focus, 0.162).map(run => run.points.map(point => point.x))).toEqual([[2, 3], [4, 5], [6, 7]]);
  expect(focusRuns(points, focus)).toHaveLength(0);
});

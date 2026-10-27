import { expect, test } from "bun:test";
import { normalizeSuspensionTravel, sceneSuspensionRange } from "../src/suspension";
import type { SemanticAnalysisFrame } from "../src/semantic-frame";

const frame = (values: unknown[]): SemanticAnalysisFrame => ({
  values: { "suspension.suspension-travel-m": values }, states: {}, freshness: {},
});

test("unspecified game ranges span the lap and preserve differences between wheels", () => {
  const frames = [frame([-.02, -.01, 0, .01]), frame([0, .01, .02, .03])];
  for (const game of ["ams2", "lmu", "ac-evo", "fm-2023", "f1-2025"]) {
    const range = sceneSuspensionRange(frames, game);
    expect(range).toEqual({ min: -20, max: 30 });
    expect(normalizeSuspensionTravel(frames[0]!.values["suspension.suspension-travel-m"] as number[], range)).toEqual([0, .2, .4, .6]);
    expect(normalizeSuspensionTravel(frames[1]!.values["suspension.suspension-travel-m"] as number[], range)).toEqual([.4, .6, .8, 1]);
  }
});

test("specified ranges do not change with observed extrema", () => {
  const frames = [frame([-.1, 0, .1, .2])];
  expect(sceneSuspensionRange(frames, "acc")).toEqual({ min: 0, max: 50 });
  expect(sceneSuspensionRange(frames, "iracing")).toEqual({ min: 0, max: 100 });
});

test("constant travel stays centered; invalid and absent readings do not define extrema", () => {
  const frames = [frame([NaN, null, Infinity]), frame([.004, .004, .004, .004])];
  const range = sceneSuspensionRange(frames, "ams2");
  expect(normalizeSuspensionTravel([.004, .004, .004, .004], range)).toEqual([.5, .5, .5, .5]);
  expect(normalizeSuspensionTravel(undefined, sceneSuspensionRange([], "ams2"))).toEqual([0, 0, 0, 0]);
});

test("range remains stable while seeking and resets for replacement or appended telemetry", () => {
  const frames = [frame([.001, .002, .003, .004])];
  const first = sceneSuspensionRange(frames, "ams2");
  expect(sceneSuspensionRange(frames, "ams2")).toBe(first);
  frames.push(frame([.005, .006, .007, .008]));
  expect(sceneSuspensionRange(frames, "ams2")).toEqual({ min: 1, max: 8 });
  expect(sceneSuspensionRange([frame([.010, .020, .030, .040])], "ams2")).toEqual({ min: 10, max: 40 });
});

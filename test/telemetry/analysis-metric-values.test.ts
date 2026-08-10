import { describe, expect, test } from "bun:test";
import { resolveBalance, resolveGripDemand, resolveWheelMetric, resolveWheelStates } from "../../shared/racing/analysis/metric-values";

const frame = (values: Record<string, unknown>) => ({ values });

describe("analysis metric value resolvers", () => {
  test("preserves Forza combined slip Grip Ask", () => {
    expect(resolveWheelMetric(frame({ "tires.tire-combined-slip": [0.72, 0.75, 1.08, 1.12] }), { kind: "value", semanticId: "tires.tire-combined-slip" })).toEqual([0.72, 0.75, 1.08, 1.12]);
  });
  test("derives physical friction-circle from ratio and angle", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "friction-circle-v1", requires: ["tires.tire-slip-ratio", "tires.tire-slip-angle"] } } as const;
    expect(resolveGripDemand(frame({ "tires.tire-slip-ratio": [0.12, 0, 0, 0], "tires.tire-slip-angle": [0, 0, 0, 0] }), metric)[0]).toBe(1);
  });
  test("returns nulls for missing or unavailable inputs", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "friction-circle-v1", requires: ["tires.tire-slip-ratio", "tires.tire-slip-angle"] } } as const;
    expect(resolveGripDemand(frame({ "tires.tire-slip-ratio": [0.1] }), metric)).toEqual([null, null, null, null]);
    expect(resolveGripDemand(frame({}), { source: "unavailable", reason: "source-limitation" })).toEqual([null, null, null, null]);
  });
  test("keeps normalized lateral slip dimensionless", () => {
    expect(resolveWheelMetric(frame({ "tires.normalized-tire-slip-angle": [0.1, 0.2, 0.3, 0.4] }), { kind: "value", semanticId: "tires.normalized-tire-slip-angle" })).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
  test("resolves traction only from declared physical channels", () => {
    const metric = { source: "derived", confidence: "exact", binding: { kind: "derived", derivation: "traction-v1", requires: ["tires.tire-slip-ratio", "tires.tire-slip-angle"] } } as const;
    expect(resolveWheelStates(frame({ "tires.tire-slip-ratio": [-0.3, 0, 0.2, 0] }), metric).map((s) => s?.state)).toEqual(["lockup", "grip", "spin", "grip"]);
  });
  test("balance unavailable without complete physical signals", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["tires.tire-slip-angle"] } } as const;
    expect(resolveBalance(frame({ "tires.tire-slip-angle": [0, 0, 0, 0] }), metric)).toBeNull();
  });
});

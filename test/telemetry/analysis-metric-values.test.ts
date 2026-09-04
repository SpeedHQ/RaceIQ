import { describe, expect, test } from "bun:test";
import { resolveBalance, resolveGripDemand, resolveWheelMetric, resolveWheelStates } from "../../shared/racing/analysis/metric-values";

const frame = (values: Record<string, unknown>, states: Record<string, string> = {}) => ({ values, states });

describe("analysis metric value resolvers", () => {
  test("preserves Forza combined slip Grip Ask", () => {
    expect(resolveWheelMetric(frame({ "tires.tire-combined-slip": [0.72, 0.75, 1.08, 1.12] }), { kind: "value", semanticId: "tires.tire-combined-slip" })).toEqual([0.72, 0.75, 1.08, 1.12]);
  });
  test("derives physical friction-circle from wheel rotation and ground speed", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "friction-circle-v1", requires: ["motion.speed", "tires.wheel-rotation-speed", "tires.tire-slip-angle"] } } as const;
    const grip = resolveGripDemand(frame({
      "motion.speed": 30,
      "inputs.steer": -32,
      "tires.wheel-rotation-speed": [100, 101, 102, 103],
      "tires.tire-slip-angle": [0.01, 0.02, 0.03, 0.04],
    }), metric);
    expect(grip.map((value) => value == null ? null : Math.round(value * 100))).toEqual([8, 15, 25, 35]);
  });
  test("returns nulls for missing or unavailable physical inputs", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "friction-circle-v1", requires: ["motion.speed", "tires.wheel-rotation-speed", "tires.tire-slip-angle"] } } as const;
    expect(resolveGripDemand(frame({ "tires.tire-slip-angle": [0.1, 0.1, 0.1, 0.1] }), metric)).toEqual([null, null, null, null]);
    expect(resolveGripDemand(frame({}), { source: "unavailable", reason: "source-limitation" })).toEqual([null, null, null, null]);
  });
  test("keeps normalized lateral slip dimensionless", () => {
    expect(resolveWheelMetric(frame({ "tires.normalized-tire-slip-angle": [0.1, 0.2, 0.3, 0.4] }), { kind: "value", semanticId: "tires.normalized-tire-slip-angle" })).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
  test("derives traction and SAE slip ratios from wheel rotation", () => {
    const metric = { source: "derived", confidence: "exact", binding: { kind: "derived", derivation: "traction-v1", requires: ["motion.speed", "inputs.steer", "tires.wheel-rotation-speed"] } } as const;
    const states = resolveWheelStates(frame({
      "motion.speed": 30,
      "inputs.steer": -32,
      "tires.wheel-rotation-speed": [100, 101, 102, 103],
    }), metric);
    expect(states.map((state) => state?.state)).toEqual(["grip", "grip", "grip", "grip"]);
    expect(states.map((state) => state == null ? null : Math.round(state.slipRatio * 100))).toEqual([-0, 0, 1, 2]);
  });
  test("resolves yaw-only balance without tire slip angles", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y"] } } as const;
    const understeer = resolveBalance(frame({
      "motion.speed": 30,
      "motion.acceleration-x": -9.81,
      "motion.angular-velocity-y": 0.1,
    }), metric);
    const oversteer = resolveBalance(frame({
      "motion.speed": 30,
      "motion.acceleration-x": -9.81,
      "motion.angular-velocity-y": 0.6,
    }), metric);
    expect(understeer?.state).toBe("understeer");
    expect(oversteer?.state).toBe("oversteer");
    expect(understeer?.slipAvailable).toBe(false);
  });
  test("returns unavailable when a required balance signal is missing", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.tire-slip-angle"] } } as const;
    expect(resolveBalance(frame({
      "motion.speed": 30,
      "motion.acceleration-x": -9.81,
      "motion.angular-velocity-y": 0.1,
    }), metric)).toBeNull();
  });
  test("rejects invalid required balance signals", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.tire-slip-angle"] } } as const;
    expect(resolveBalance(frame({
      "motion.speed": 30,
      "motion.acceleration-x": -9.81,
      "motion.angular-velocity-y": 0.1,
      "tires.tire-slip-angle": [0.1, 0.1, 0.1, 0.1],
    }, { "tires.tire-slip-angle": "invalid" }), metric)).toBeNull();
  });
  test("resolves balance from canonical semantic motion IDs", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.tire-slip-angle"] } } as const;
    expect(resolveBalance(frame({
      "motion.speed": 30,
      "motion.acceleration-x": 1,
      "motion.angular-velocity-y": 0.2,
      "tires.tire-slip-angle": [0.1, 0.1, 0.1, 0.1],
    }), metric)).not.toBeNull();
  });
  test("resolves Forza balance from its normalized slip-angle channel", () => {
    const metric = { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y", "tires.normalized-tire-slip-angle"] } } as const;
    const balance = resolveBalance(frame({
      "motion.speed": 30,
      "motion.acceleration-x": 1,
      "motion.angular-velocity-y": 0.2,
      "tires.normalized-tire-slip-angle": [0.1, 0.1, 0.1, 0.1],
    }), metric);
    expect(balance?.slipAvailable).toBe(true);
  });
});

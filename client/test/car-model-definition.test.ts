import { describe, expect, test } from "bun:test";
import { DEFAULT_CAR, DEFAULT_SPRING, resolveCarModelDefinition } from "../src/data/car-models";

describe("car model definitions", () => {
  test("fills complete running gear defaults", () => {
    const model = resolveCarModelDefinition();

    expect(model.frontTireRadius).toBe(DEFAULT_CAR.frontTireRadius);
    expect(model.rearTireWidth).toBe(DEFAULT_CAR.rearTireWidth);
    expect(model.suspStroke).toBe(DEFAULT_CAR.suspStroke);
    expect(model.frontSpring).toEqual(DEFAULT_SPRING);
    expect(model.rearSpring).toEqual(DEFAULT_SPRING);
    expect(model.frontSpring).not.toBe(model.rearSpring);
  });

  test("merges per-model and per-axle spring overrides independently", () => {
    const model = resolveCarModelDefinition({
      modelPath: "/models/custom.glb",
      frontTireRadius: 0.38,
      rearTireWidth: 0.42,
      suspStroke: 0.11,
      frontSpring: { coilRadius: 0.024, coils: 8 },
      rearSpring: { bodyMountHeight: 0.27, inboardOffset: 0.3, damperExtension: 0.065 },
    });

    expect(model.frontTireRadius).toBe(0.38);
    expect(model.rearTireWidth).toBe(0.42);
    expect(model.suspStroke).toBe(0.11);
    expect(model.frontSpring).toEqual({ ...DEFAULT_SPRING, coilRadius: 0.024, coils: 8 });
    expect(model.rearSpring).toEqual({ ...DEFAULT_SPRING, bodyMountHeight: 0.27, inboardOffset: 0.3, damperExtension: 0.065 });
  });
});

import { describe, expect, test } from "bun:test";
import { steeringAngleRadians } from "../src/lib/wireframe-utils";

describe("steeringAngleRadians", () => {
  test("normalizes signed int8 steering input before converting to wheel angle", () => {
    expect(steeringAngleRadians(127)).toBeCloseTo(-0.35);
    expect(steeringAngleRadians(-127)).toBeCloseTo(0.35);
    expect(steeringAngleRadians(0)).toBe(0);
  });
});

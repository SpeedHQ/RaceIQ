import { describe, expect, test } from "bun:test";
import { steeringAngleRadians } from "../src/lib/wireframe-utils";

describe("steeringAngleRadians", () => {
  test("converts normalized steering input to wheel angle", () => {
    expect(steeringAngleRadians(1)).toBeCloseTo(-0.35);
    expect(steeringAngleRadians(-1)).toBeCloseTo(0.35);
    expect(steeringAngleRadians(0)).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { steeringAngleRadians } from "@raceiq/scene-3d/wireframe-utils";

describe("steeringAngleRadians", () => {
  test("centers steering and maps positive input to positive angle", () => {
    const metadata = { steeringCenter: 0, steeringRange: 127 };
    expect(steeringAngleRadians(0, metadata)).toBeCloseTo(0);
    expect(steeringAngleRadians(127, metadata)).toBeCloseTo(0.35);
    expect(steeringAngleRadians(-127, metadata)).toBeCloseTo(-0.35);
  });
});

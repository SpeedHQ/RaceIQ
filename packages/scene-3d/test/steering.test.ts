import { describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import { steeringAngleRadians } from "@raceiq/scene-3d/wireframe-utils";
import { accAdapter } from "@raceiq/game-acc-metadata/index";
import { acEvoAdapter } from "@raceiq/game-ac-evo-metadata/index";
import { forzaAdapter } from "@raceiq/game-fm-2023-metadata/index";
import { f1Adapter } from "@raceiq/game-f1-2025-metadata/index";
import { iracingAdapter } from "@raceiq/game-iracing-metadata/index";
import { lmuAdapter } from "@raceiq/game-lmu-metadata/index";

const adapters = [accAdapter, acEvoAdapter, forzaAdapter, f1Adapter, iracingAdapter, lmuAdapter];

function worldHeading(angle: number): Vector3 {
  return new Vector3(1, 0, 0)
    .applyAxisAngle(new Vector3(0, 1, 0), angle)
    .applyAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
}

describe("steeringAngleRadians", () => {
  for (const adapter of adapters) {
    test(`${adapter.id} adapter metadata centers steering and gives canonical input correct heading`, () => {
      const metadata = { steeringCenter: adapter.steeringCenter, steeringRange: adapter.steeringRange };
      expect(steeringAngleRadians(metadata.steeringCenter, metadata)).toBeCloseTo(0);
      expect(worldHeading(steeringAngleRadians(metadata.steeringCenter, metadata)).x).toBeCloseTo(0);
      expect(worldHeading(steeringAngleRadians(metadata.steeringCenter + metadata.steeringRange, metadata)).x).toBeGreaterThan(0);
      expect(worldHeading(steeringAngleRadians(metadata.steeringCenter - metadata.steeringRange, metadata)).x).toBeLessThan(0);
    });
  }

  test("uses metadata center and range rather than assuming zero and 127", () => {
    const metadata = { steeringCenter: 12, steeringRange: 40 };
    expect(steeringAngleRadians(12, metadata)).toBeCloseTo(0);
    expect(steeringAngleRadians(52, metadata)).toBeGreaterThan(0);
    expect(steeringAngleRadians(-28, metadata)).toBeLessThan(0);
  });

  test("bounds asymmetric signed input to steering limit", () => {
    const metadata = { steeringCenter: 0, steeringRange: 127 };
    expect(steeringAngleRadians(-128, metadata)).toBeCloseTo(-0.35);
    expect(steeringAngleRadians(127, metadata)).toBeCloseTo(0.35);
  });

  test.each([
    [Number.NaN, { steeringCenter: 0, steeringRange: 127 }],
    [Number.POSITIVE_INFINITY, { steeringCenter: 0, steeringRange: 127 }],
    [0, { steeringCenter: Number.NaN, steeringRange: 127 }],
    [0, { steeringCenter: 0, steeringRange: Number.POSITIVE_INFINITY }],
    [1, { steeringCenter: 0, steeringRange: 0 }],
  ] as const)("returns safe straight angle for invalid input or metadata", (input, metadata) => {
    expect(steeringAngleRadians(input, metadata)).toBe(0);
  });
});

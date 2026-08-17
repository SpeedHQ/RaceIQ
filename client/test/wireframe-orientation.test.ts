import { describe, expect, test } from "bun:test";
import { Euler, Vector3 } from "three";
import { buildTrackIndex, filterByDistanceIndexed, setBodyAttitudeRotation } from "../src/lib/wireframe-utils";

describe("3D Analyse orientation", () => {
  test("maps raw roll to +X and raw pitch to +Z without changing heading axis", () => {
    const rotation = new Euler();

    setBodyAttitudeRotation(rotation, 0.21, -0.13, -0.4, 0.5);

    expect(rotation.x).toBeCloseTo(0.21);
    expect(rotation.y).toBe(0);
    expect(rotation.z).toBeCloseTo(-0.13);
    expect(rotation.order).toBe("YXZ");
  });

  test("positive semantic pitch raises nose and positive roll lowers right side", () => {
    const pitchRotation = new Euler();
    setBodyAttitudeRotation(pitchRotation, 0, 0.2, 0, 0);
    const forward = new Vector3(1, 0, 0).applyEuler(pitchRotation);
    expect(forward.y).toBeGreaterThan(0);

    const rollRotation = new Euler();
    setBodyAttitudeRotation(rollRotation, 0.2, 0, 0, 0);
    const right = new Vector3(0, 0, 1).applyEuler(rollRotation);
    expect(right.y).toBeLessThan(0);
  });

  test("uses suspension attitude independently for each missing raw channel", () => {
    const rotation = new Euler();

    setBodyAttitudeRotation(rotation, 0.12, null, -0.08, 0.04);
    expect(rotation.x).toBeCloseTo(0.12);
    expect(rotation.z).toBeCloseTo(0.04);

    setBodyAttitudeRotation(rotation, null, -0.03, -0.08, 0.04);
    expect(rotation.x).toBeCloseTo(-0.08);
    expect(rotation.z).toBeCloseTo(-0.03);

    setBodyAttitudeRotation(rotation, 0, 0, -0.08, 0.04);
    expect(rotation.x).toBe(0);
    expect(rotation.z).toBe(0);
  });

  test("aligns canonical yaw forward [sin(yaw), cos(yaw)] with car-local +X", () => {
    const yaw = 0.73;
    const distance = 12;
    const car = { x: 18, z: -9 };
    const forward = {
      x: car.x + Math.sin(yaw) * distance,
      z: car.z + Math.cos(yaw) * distance,
    };

    const segments = filterByDistanceIndexed(buildTrackIndex([car, forward]), car.x, car.z, yaw, -0.44);

    expect(segments).toHaveLength(1);
    expect(segments[0].points[0][0]).toBeCloseTo(0);
    expect(segments[0].points[0][2]).toBeCloseTo(0);
    expect(segments[0].points[1][0]).toBeCloseTo(distance);
    expect(segments[0].points[1][2]).toBeCloseTo(0);
  });
});

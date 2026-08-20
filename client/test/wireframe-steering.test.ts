import { describe, expect, test } from "bun:test";
import { Euler, Vector3 } from "three";
import { setVehicleAttitudeRotations, steeringAngleRadians } from "../src/lib/wireframe-utils";

describe("steeringAngleRadians", () => {
  test("converts normalized steering input to wheel angle", () => {
    expect(steeringAngleRadians(1)).toBeCloseTo(-0.35);
    expect(steeringAngleRadians(-1)).toBeCloseTo(0.35);
    expect(steeringAngleRadians(0)).toBe(0);
  });
});

describe("setVehicleAttitudeRotations", () => {
  test("applies raw roll and pitch to complete vehicle", () => {
    const vehicle = new Euler();
    const chassis = new Euler();

    setVehicleAttitudeRotations(vehicle, chassis, 0.21, -0.13, -0.4, 0.5);

    expect(vehicle.x).toBeCloseTo(0.21);
    expect(vehicle.y).toBe(0);
    expect(vehicle.z).toBeCloseTo(-0.13);
    expect(vehicle.order).toBe("YXZ");
    expect(chassis.x).toBe(0);
    expect(chassis.z).toBe(0);
  });

  test("raises nose for positive pitch and lowers right side for positive roll", () => {
    const pitchRotation = new Euler();
    setVehicleAttitudeRotations(pitchRotation, new Euler(), 0, 0.2, 0, 0);
    expect(new Vector3(1, 0, 0).applyEuler(pitchRotation).y).toBeGreaterThan(0);

    const rollRotation = new Euler();
    setVehicleAttitudeRotations(rollRotation, new Euler(), 0.2, 0, 0, 0);
    expect(new Vector3(0, 0, 1).applyEuler(rollRotation).y).toBeLessThan(0);
  });

  test("uses suspension fallback only on chassis axes missing raw attitude", () => {
    const vehicle = new Euler();
    const chassis = new Euler();

    setVehicleAttitudeRotations(vehicle, chassis, 0.12, null, -0.08, 0.04);
    expect(vehicle.x).toBeCloseTo(0.12);
    expect(vehicle.z).toBe(0);
    expect(chassis.x).toBe(0);
    expect(chassis.z).toBeCloseTo(0.04);

    setVehicleAttitudeRotations(vehicle, chassis, null, -0.03, -0.08, 0.04);
    expect(vehicle.x).toBe(0);
    expect(vehicle.z).toBeCloseTo(-0.03);
    expect(chassis.x).toBeCloseTo(-0.08);
    expect(chassis.z).toBe(0);
  });
});

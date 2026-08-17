import { describe, expect, test } from "bun:test";
import { Euler, Vector3 } from "three";
import { buildTrackIndex, filterByDistanceIndexed, makeSuspensionSpringGeometry, setVehicleAttitudeRotations } from "../src/lib/wireframe-utils";

describe("3D Analyse orientation", () => {
  test("applies raw roll and pitch to complete vehicle while chassis stays aligned", () => {
    const vehicle = new Euler();
    const chassis = new Euler();

    setVehicleAttitudeRotations(vehicle, chassis, 0.21, -0.13, -0.4, 0.5);

    expect(vehicle.x).toBeCloseTo(0.21);
    expect(vehicle.y).toBe(0);
    expect(vehicle.z).toBeCloseTo(-0.13);
    expect(vehicle.order).toBe("YXZ");
    expect(chassis.x).toBe(0);
    expect(chassis.z).toBe(0);
    expect(chassis.order).toBe("YXZ");
  });

  test("positive semantic pitch raises nose and positive roll lowers complete vehicle right side", () => {
    const vehicle = new Euler();
    const chassis = new Euler();
    setVehicleAttitudeRotations(vehicle, chassis, 0, 0.2, 0, 0);
    const forward = new Vector3(1, 0, 0).applyEuler(vehicle);
    expect(forward.y).toBeGreaterThan(0);

    setVehicleAttitudeRotations(vehicle, chassis, 0.2, 0, 0, 0);
    const right = new Vector3(0, 0, 1).applyEuler(vehicle);
    expect(right.y).toBeLessThan(0);
  });

  test("uses suspension attitude on chassis only for each missing raw channel", () => {
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

    setVehicleAttitudeRotations(vehicle, chassis, 0, 0, -0.08, 0.04);
    expect(vehicle.x).toBe(0);
    expect(vehicle.z).toBe(0);
    expect(chassis.x).toBe(0);
    expect(chassis.z).toBe(0);
  });

  test("builds suspension springs along transformed 3D hardpoint axes", () => {
    const wheel: [number, number, number] = [1, 0, 0.2];
    const body: [number, number, number] = [1.1, 0.3, 0.4];
    const { coilPoints, rodPoints } = makeSuspensionSpringGeometry(body, wheel, 0.032, 6, 0.07);
    const bottom = new Vector3(...wheel);
    const top = new Vector3(...body);
    const direction = top.clone().sub(bottom).normalize();
    const height = top.distanceTo(bottom);

    expect(coilPoints).toHaveLength(73);
    expect(new Vector3(...coilPoints[0]).sub(bottom).dot(direction)).toBeCloseTo(0);
    expect(new Vector3(...coilPoints.at(-1)!).sub(bottom).dot(direction)).toBeCloseTo(height);
    expect(new Vector3(...rodPoints[0]).distanceTo(bottom)).toBeCloseTo(0.07);
    expect(new Vector3(...rodPoints[1]).distanceTo(top)).toBeCloseTo(0.07);
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

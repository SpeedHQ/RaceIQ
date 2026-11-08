import { expect, test } from "bun:test";
import { Vector3 } from "three";
import { createWheelResource, disposeWheelResource, updateWheelResource } from "../src/wireframe/Wheel";

for (const side of ["left", "right"] as const) {
  for (const isRear of [false, true]) {
    test(`${isRear ? "rear" : "front"} ${side} surface bands place inner toward the chassis and clear stale bands`, () => {
      const wheel = createWheelResource();
      const lateralPosition = side === "left" ? -0.8 : 0.8;
      try {
        for (const kind of ["outer", "inner", "middle"] as const) {
          updateWheelResource(wheel, {
            position: [isRear ? -1.4 : 1.4, 0, lateralPosition], steerAngle: 0,
            rimColor: "#ffffff", temperatureReadings: [{ kind, value: null }],
            temperatureThresholds: { cold: 60, warm: 90, hot: 110 },
            brakeTemp: 0, side, isRear, onCurb: false, puddleDepth: 0,
          });
          const visibleBands = wheel.meshes.slice(2, 5).filter((mesh) => mesh.visible);
          expect(visibleBands).toHaveLength(1);
          const band = visibleBands[0]!;
          band.geometry.computeBoundingBox();
          wheel.root.updateMatrixWorld(true);
          const center = band.localToWorld(band.geometry.boundingBox!.getCenter(new Vector3()));
          if (kind === "inner") expect(Math.abs(center.z)).toBeLessThan(Math.abs(lateralPosition));
          else if (kind === "outer") expect(Math.abs(center.z)).toBeGreaterThan(Math.abs(lateralPosition));
          else expect(center.z).toBeCloseTo(lateralPosition);
        }
      } finally {
        disposeWheelResource(wheel);
      }
    });
  }
}

import type { Point } from "../../../contracts/types";
import type { CalibrationTransform } from "../../../contracts/calibration";

export function transformCalibrationPath(points: Point[], transform: CalibrationTransform): Point[] {
  const inverseScale = 1 / transform.scale;
  const inverseRotation = -transform.rotation;
  const cos = Math.cos(inverseRotation);
  const sin = Math.sin(inverseRotation);

  return points.map(({ x, z }) => {
    const translatedX = x - transform.tx;
    const translatedZ = z - transform.tz;
    return {
      x: inverseScale * (cos * translatedX - sin * translatedZ),
      z: inverseScale * (sin * translatedX + cos * translatedZ),
    };
  });
}

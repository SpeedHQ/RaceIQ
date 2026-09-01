import type { InferResponseType } from "hono/client";
import { client } from "@/lib/rpc";
import type { Point } from "../types";

type ComparisonRequest = typeof client.api["track-calibration"][":ordinal"]["comparison"]["$get"];

export type CalibrationComparison = InferResponseType<ComparisonRequest, 200>;
export type CalibrationTransform = NonNullable<CalibrationComparison["current"]>;

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

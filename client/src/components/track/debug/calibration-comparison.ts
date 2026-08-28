import type { InferResponseType } from "hono/client";
import { client } from "@/lib/rpc";
import type { Point } from "../types";

type ComparisonRequest = typeof client.api["track-calibration"][":ordinal"]["comparison"]["$get"];

export type CalibrationComparison = InferResponseType<ComparisonRequest, 200>;
export type CalibrationTransform = NonNullable<CalibrationComparison["current"]>;

export function transformCalibrationPath(points: Point[], transform: CalibrationTransform): Point[] {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);

  return points.map(({ x, z }) => ({
    x: transform.scale * (cos * x - sin * z) + transform.tx,
    z: transform.scale * (sin * x + cos * z) + transform.tz,
  }));
}

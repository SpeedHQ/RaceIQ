/**
 * Track geometry: where each segment sits along one game's lap.
 *
 * Classification-free — a name never appears in a geometry file. Segments key
 * into `shared/racing/tracks/facts.ts` by the keys in `shared/racing/tracks/keys.ts`. Each game
 * digitises its own centerline, so one file exists per (track, game) pair.
 */
import { z } from "zod";
import { cornerKey, parseCornerKey, parseStraightKey, straightKey } from "./keys";

const SegmentKeySchema = z.string().refine((key) => {
  if (key.startsWith("t")) {
    const numbers = parseCornerKey(key);
    return numbers.length > 0
      && numbers.every((number) => Number.isInteger(number) && number > 0)
      && new Set(numbers).size === numbers.length
      && cornerKey(numbers) === key;
  }
  const after = parseStraightKey(key);
  return after !== null && Number.isInteger(after) && after > 0 && straightKey(after) === key;
}, "Invalid track geometry segment key");

export const GeometrySegmentSchema = z.object({
  key: SegmentKeySchema,
  startFrac: z.number().min(0).max(1),
  endFrac: z.number().min(0).max(1),
});

export const TrackGeometrySchema = z.object({
  sectors: z
    .object({
      s1End: z.number().gt(0).lt(1),
      s2End: z.number().gt(0).lt(1),
      source: z.string().optional(),
    })
    .refine(({ s1End, s2End }) => s1End < s2End, "Sector 1 must end before sector 2")
    .optional(),
  segments: z.array(GeometrySegmentSchema),
});

/** Where one segment sits along this game's lap. Classification-free. */
export type GeometrySegment = z.infer<typeof GeometrySegmentSchema>;

export type TrackGeometry = z.infer<typeof TrackGeometrySchema>;

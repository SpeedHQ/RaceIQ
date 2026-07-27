/**
 * Track geometry: where each segment sits along one game's lap.
 *
 * Classification-free — a name never appears in a geometry file. Segments key
 * into `shared/track-facts.ts` by the keys in `shared/track-keys.ts`. Each game
 * digitises its own centerline, so one file exists per (track, game) pair.
 */
import type { TrackSectors } from "./track-sectors";
import type { Verification } from "./track-verification";

/** Where one segment sits along this game's lap. Classification-free. */
export interface GeometrySegment {
  /** `t3` / `t10-11` for corners, `s3` for the gap after turn 3. */
  key: string;
  startFrac: number;
  endFrac: number;
}

export interface TrackGeometry {
  sectors?: TrackSectors & { source?: string };
  /**
   * Human sign-off on where these segments sit in *this game's* lap. Separate
   * from the facts sign-off because they are separate claims: the turn list can
   * be right while the fractions are half a lap out, and each game digitises
   * its own centerline, so checking one game's geometry says nothing about
   * another's.
   */
  verified?: Verification;
  segments: GeometrySegment[];
}

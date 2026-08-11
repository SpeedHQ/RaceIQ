/**
 * The labelled-segment shape consumers receive: a corner or straight with both
 * its label and its position along one game's lap.
 *
 * Nothing is stored in this shape. Facts live in `shared/data/tracks/meta/<slug>.json`
 * and fractions in `shared/data/tracks/<gameId>/<slug>-segments.json`; `joinSegments`
 * in `shared/racing/tracks/curation/join.ts` combines them on the way out, and
 * `splitSegments` takes it apart again on the way back in.
 */

export interface NamedSegment {
  type: "corner" | "straight";
  name: string;
  direction?: "left" | "right";
  startFrac: number;
  endFrac: number;
  /**
   * Official turn number of this section (corners only). One entry per turn —
   * a corner that officially spans several numbers (Pouhon is T10-T11) is the
   * lowest number, with the rest listed in `covers`.
   */
  number?: number;
  /**
   * Extra official turn numbers this one section subsumes (corners only), for
   * corners the detector can't split (Pouhon: number 10, covers [11]).
   */
  covers?: number[];
  /**
   * Sections that belong together as one named piece of track: a complex
   * (Rivazza, Les Combes) whose apexes are separate entries so the editor can
   * nudge one at a time, and the start/finish straight, which the line cuts
   * into the lap's first and last segment. Members share this key so consumers
   * can label the piece once instead of once per entry.
   */
  group?: string;
}

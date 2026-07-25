/**
 * Moved to @shared/track-coords so test renderers can apply the identical flip
 * the UI applies before projecting. Re-exported here to keep existing client
 * import paths (`../lib/track-coords`) working.
 */
export { needsTrackFlip, flipPoints, flipBoundaries } from "@shared/track-coords";
export type { Pt } from "@shared/track-coords";

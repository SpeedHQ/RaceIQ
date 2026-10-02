/**
 * Single source of truth for projecting track-space points into SVG space.
 *
 * Before this existed there were two independent implementations with opposite
 * conventions: the UI (`client/src/components/tunes/track-map-geometry.ts`)
 * projected `(maxX - x, z - minZ)` while the e2e segment renderer
 * (`test/support/tracks/segment-svg.ts`) projected `(x - minX, maxZ - z)`. Those are
 * exact negations of each other, so the same track came out rotated 180°
 * between the app and the generated SVGs.
 *
 * The canonical orientation is the UI's, which itself matches TrackDetail /
 * `lib/canvas/draw-track.ts` with `flipX=true`:
 *   - X is mirrored with (maxX - x), because inputs are in negated-X
 *     telemetry space.
 *   - Z maps straight down, NOT inverted.
 * Do not "fix" one axis in isolation — that mirrors the map on one axis
 * relative to track detail.
 */

export interface Pt {
  x: number;
  z: number;
}

export interface ProjectionOptions {
  /** Output box width in SVG units. */
  width: number;
  /** Output box height in SVG units. */
  height: number;
  /** Padding in SVG units, applied to both axes. */
  padPx?: number;
  /**
   * Padding as a fraction of the larger world-space span. Applied in world
   * units before scaling. Mutually exclusive with padPx.
   */
  padFrac?: number;
}

export interface TrackProjection {
  project: (p: Pt) => { x: number; y: number };
  /** SVG units per world unit. */
  scale: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/**
 * Build a projector from the points that define the extent of the drawing.
 *
 * Pass every point that must be visible (line + track edges), not just the
 * subset being drawn, or the bounds — and therefore the scale and centring —
 * will differ between callers rendering the same track.
 *
 * Returns null when the points are empty or degenerate (zero span).
 */
export function makeTrackProjection(points: Iterable<Pt>, opts: ProjectionOptions): TrackProjection | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    count++;
  }
  if (count === 0) return null;

  let spanX = maxX - minX;
  let spanZ = maxZ - minZ;
  if (!(Math.max(spanX, spanZ) > 0)) return null;

  const { width, height, padPx = 0, padFrac } = opts;

  // World-space padding widens the span before scaling; pixel padding shrinks
  // the usable box instead. Both end up as uniform slack on all four sides.
  if (padFrac !== undefined) {
    const padWorld = Math.max(spanX, spanZ) * padFrac;
    spanX += padWorld * 2;
    spanZ += padWorld * 2;
  }

  const usableW = width - padPx * 2;
  const usableH = height - padPx * 2;
  if (!(usableW > 0 && usableH > 0)) return null;

  // Uniform scale on both axes so the track keeps its true aspect ratio.
  const scale = Math.min(usableW / spanX, usableH / spanZ);

  // Centre the drawn extent in the box.
  const offX = (width - (maxX - minX) * scale) / 2;
  const offZ = (height - (maxZ - minZ) * scale) / 2;

  return {
    scale,
    bounds: { minX, maxX, minZ, maxZ },
    project: (p: Pt) => ({
      x: offX + (maxX - p.x) * scale,
      y: offZ + (p.z - minZ) * scale,
    }),
  };
}

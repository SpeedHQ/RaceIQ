import type { TrackCorner } from "../../../hooks/queries";
import type { LapTrace } from "../../../lib/stint-traces";

/** Half-width (in lap-distance fraction) of the window around a corner's apex
 *  fraction used to pull zone samples out of each lap's trace. Matches the
 *  design mockup's `0.045` band (~9% of lap total). Shared by the corner
 *  ledger, the track map's corner annotations, and chart tooltips so "nearest
 *  corner" reads identically everywhere. */
export const ZONE_HALF_WIDTH = 0.045;

/** Minimum lap-fraction separation between two detected apexes. */
const DETECT_MIN_GAP = 0.03;
/** Max corners synthesized when the track has no corner metadata. */
const DETECT_MAX_CORNERS = 14;

/** Fallback for tracks without corner metadata: detect apex zones as local
 *  minima of the best lap's (lightly smoothed) speed trace, mirroring how the
 *  `4-corner-ledger.html` mockup derived corners purely from telemetry.
 *  Shared by the corner ledger and the track map so both surfaces agree on
 *  the same synthesized corners. */
export function detectCorners(trace: LapTrace): { corners: TrackCorner[]; fracs: number[] } {
  const n = trace.speedKmh.length;
  if (n < 16) return { corners: [], fracs: [] };
  // Light box smoothing to suppress sample noise.
  const smooth = new Float32Array(n);
  const W = 5;
  for (let i = 0; i < n; i++) {
    let sum = 0,
      cnt = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) {
      sum += trace.speedKmh[j];
      cnt++;
    }
    smooth[i] = sum / cnt;
  }
  let vMax = 0;
  for (let i = 0; i < n; i++) if (smooth[i] > vMax) vMax = smooth[i];
  if (vMax <= 0) return { corners: [], fracs: [] };

  // Local minima that dip meaningfully below top speed.
  const cands: { frac: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (smooth[i] <= smooth[i - 1] && smooth[i] < smooth[i + 1] && smooth[i] < vMax * 0.85) {
      cands.push({ frac: trace.frac[i], v: smooth[i] });
    }
  }
  // Keep the slowest apex within each MIN_GAP window.
  cands.sort((a, b) => a.v - b.v);
  const kept: { frac: number; v: number }[] = [];
  for (const c of cands) {
    if (kept.length >= DETECT_MAX_CORNERS) break;
    if (kept.every((k) => Math.abs(k.frac - c.frac) >= DETECT_MIN_GAP)) kept.push(c);
  }
  kept.sort((a, b) => a.frac - b.frac);

  const corners = kept.map((k, i) => ({
    index: i,
    label: `T${i + 1}`,
    distanceStart: Math.max(0, k.frac - ZONE_HALF_WIDTH),
    distanceEnd: Math.min(1, k.frac + ZONE_HALF_WIDTH),
    apexDistance: k.frac,
  }));
  return { corners, fracs: kept.map((k) => k.frac) };
}

/** Label of the corner whose apex fraction is nearest `f`, within
 *  `halfWidth` — or null when nothing is close enough. Used to annotate
 *  chart tooltips and the track-map cursor chip with "which corner am I
 *  hovering". */
export function nearestCornerLabel(corners: TrackCorner[], fracs: number[], f: number, halfWidth: number = ZONE_HALF_WIDTH): string | null {
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < corners.length; i++) {
    const cf = fracs[i];
    if (cf == null) continue;
    const d = Math.abs(cf - f);
    if (d < halfWidth && d < bestD) {
      bestD = d;
      best = corners[i].label;
    }
  }
  return best;
}

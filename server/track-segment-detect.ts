/**
 * Auto-detection of corner / straight segments from a track centerline outline.
 *
 * Two implementations are exposed: the original (v1) and a curvature-based
 * rewrite (v2) that handles long, complex tracks like the Nordschleife.
 * Both produce segments with the same shape so callers can swap freely.
 */

export type SegmentType = "corner" | "straight";

export interface DetectedSegment {
  type: SegmentType;
  startIdx: number;
  endIdx: number;
  startFrac: number;
  endFrac: number;
  distStart: number;
  distEnd: number;
  name: string;
  direction: "left" | "right" | null;
}

export interface OutlinePoint {
  x: number;
  z: number;
}

export interface SegmentDetectionResult {
  segments: DetectedSegment[];
  totalDist: number;
}

function cumulativeDistance(outline: OutlinePoint[]): number[] {
  const dists = [0];
  for (let i = 1; i < outline.length; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  return dists;
}

/**
 * Curvature-based segmentation: identify true straights and group everything
 * else into "section" segments (each section can contain many corners). Tuned
 * against FM/AC Evo Nordschleife, Brands Hatch GP, and short circuits.
 *
 * - Straight = peak |κ| stays under STRAIGHT_IN over a 40 m window
 * - Hysteresis on enter/exit of straight state to avoid flicker
 * - Sign-change splits separate L/R complexes
 * - Peak-split separates same-direction sections with deep valleys between apexes
 * - Turning-budget split (~120°) splits technical sections short, leaves sweepers long
 * - Cuts snap to local |κ| valleys so they land between corners, not on apexes
 */
export function detectSegments(outline: OutlinePoint[]): SegmentDetectionResult {
  const n = outline.length;
  if (n < 20) return { segments: [], totalDist: 0 };

  const dists = cumulativeDistance(outline);
  const totalDist = dists[n - 1];
  const meanSpacing = totalDist / n;

  const CURV_WINDOW_M = 15;
  const PEAK_WINDOW_M = 40;    // straight = no noticeable corner within 40 m of every point
  const STRAIGHT_IN = 0.0005;  // enter "straight": peak |κ| must stay below this (~2000 m radius)
  const STRAIGHT_OUT = 0.0010; // leave "straight": peak |κ| must rise above this (~1000 m radius)
  const MAX_STRAIGHT_M = 1800; // refuse to glue a short section into a straight that would exceed this
  // Straights are sacred — a 100 m gap in the corner barrage still gets to be a
  // straight. Sections need more substance (tiny squiggles aren't their own section).
  const MIN_STRAIGHT_M = 100;
  const MIN_SECTION_M = Math.max(200, Math.min(400, totalDist * 0.015));

  const winIdx = Math.max(2, Math.round(CURV_WINDOW_M / meanSpacing));
  const peakIdx = Math.max(2, Math.round(PEAK_WINDOW_M / meanSpacing));

  const signedKappa: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - winIdx + n) % n;
    const b = (i + winIdx) % n;
    const a1 = Math.atan2(outline[i].z - outline[a].z, outline[i].x - outline[a].x);
    const a2 = Math.atan2(outline[b].z - outline[i].z, outline[b].x - outline[i].x);
    let dTheta = a2 - a1;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const arc = (dists[b] >= dists[a] ? dists[b] - dists[a] : dists[b] + totalDist - dists[a]) || 1;
    signedKappa[i] = dTheta / arc;
  }

  // Peak |κ| within ±PEAK_WINDOW_M — any nearby corner disqualifies this point
  // from being "straight." This avoids averaging a short corner into invisibility.
  const smooth: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let j = -peakIdx; j <= peakIdx; j++) {
      const k = Math.abs(signedKappa[(i + j + n) % n]);
      if (k > peak) peak = k;
    }
    smooth[i] = peak;
  }

  // Walk with hysteresis to avoid flicker near the threshold.
  type Raw = { type: SegmentType; startIdx: number; endIdx: number };
  const raw: Raw[] = [];
  let runStart = 0;
  let inStraight = Math.abs(smooth[0]) < STRAIGHT_IN;

  for (let i = 1; i < n; i++) {
    const absK = Math.abs(smooth[i]);
    const flip = inStraight ? absK > STRAIGHT_OUT : absK < STRAIGHT_IN;
    if (flip) {
      raw.push({ type: inStraight ? "straight" : "corner", startIdx: runStart, endIdx: i });
      runStart = i;
      inStraight = !inStraight;
    }
  }
  raw.push({ type: inStraight ? "straight" : "corner", startIdx: runStart, endIdx: n - 1 });

  // Iteratively absorb segments shorter than MIN_SEG_M into their larger neighbour,
  // flipping type as needed. Repeat until stable.
  let merged: Raw[] = raw.map((r) => ({ ...r }));
  const lenOf = (r: Raw) => dists[r.endIdx] - dists[r.startIdx];

  const minLenFor = (t: SegmentType) => t === "straight" ? MIN_STRAIGHT_M : MIN_SECTION_M;
  for (let pass = 0; pass < 2000; pass++) {
    // Find the worst under-length segment (most-below-its-minimum, by ratio)
    let worstIdx = -1;
    let worstRatio = 1;
    for (let i = 0; i < merged.length; i++) {
      const ratio = lenOf(merged[i]) / minLenFor(merged[i].type);
      if (ratio < 1 && ratio < worstRatio) { worstRatio = ratio; worstIdx = i; }
    }
    if (worstIdx < 0) break;

    const r = merged[worstIdx];
    const rLen = lenOf(r);
    const prev = worstIdx > 0 ? merged[worstIdx - 1] : null;
    const next = worstIdx + 1 < merged.length ? merged[worstIdx + 1] : null;
    const prevLen = prev ? lenOf(prev) : -1;
    const nextLen = next ? lenOf(next) : -1;
    // Never merge a corner-section into a straight that would exceed MAX_STRAIGHT_M
    // (keeps genuine corners from disappearing into long flat-out sections).
    const prevOK = !!prev && !(prev.type === "straight" && r.type === "corner" && prevLen + rLen > MAX_STRAIGHT_M);
    const nextOK = !!next && !(next.type === "straight" && r.type === "corner" && nextLen + rLen > MAX_STRAIGHT_M);
    const preferPrev = prevOK && (prevLen >= nextLen || !nextOK);
    const preferNext = nextOK && !preferPrev;
    if (preferPrev && prev) {
      prev.endIdx = r.endIdx;
      merged.splice(worstIdx, 1);
    } else if (preferNext && next) {
      next.startIdx = r.startIdx;
      merged.splice(worstIdx, 1);
    } else {
      // Can't safely absorb — promote the short section to sit on its own.
      // Stretch to the minimum length by borrowing evenly from neighbours.
      break;
    }

    // Consolidate adjacent same-type runs after merge
    const consolidated: Raw[] = [];
    for (const x of merged) {
      const p = consolidated[consolidated.length - 1];
      if (p && p.type === x.type) p.endIdx = x.endIdx;
      else consolidated.push({ ...x });
    }
    merged = consolidated;
  }

  // Split any section longer than MAX_SECTION_M until all sections fit under the cap.
  // Preferred split: sustained signed-κ sign change; fallback: lowest-|κ| point near middle.
  const RUN_THRESHOLD = Math.max(4, Math.round(50 / meanSpacing));
  // Cleanup: short straights wedged between two corner sections aren't real
  // straights — they're connecting tissue inside one larger corner complex.
  const INTRA_STRAIGHT_M = 300;
  for (let i = 1; i < merged.length - 1; i++) {
    const s = merged[i];
    if (s.type !== "straight") continue;
    const prev = merged[i - 1];
    const next = merged[i + 1];
    if (prev.type !== "corner" || next.type !== "corner") continue;
    if (dists[s.endIdx] - dists[s.startIdx] >= INTRA_STRAIGHT_M) continue;
    s.type = "corner";
  }
  const consolidated2: Raw[] = [];
  for (const r of merged) {
    const prev = consolidated2[consolidated2.length - 1];
    if (prev && prev.type === r.type) prev.endIdx = r.endIdx;
    else consolidated2.push({ ...r });
  }
  merged = consolidated2;

  // Pass A: split every corner section at sustained signed-κ direction changes.
  const signSplit = (r: Raw): Raw[] => {
    if (r.type !== "corner") return [r];
    const signs: number[] = [];
    for (let i = r.startIdx; i <= r.endIdx; i++) signs.push(smooth[i] < STRAIGHT_IN ? 0 : Math.sign(signedKappa[i]));
    const cuts: number[] = [r.startIdx];
    let currentSign = 0, runLen = 0;
    for (let k = 0; k < signs.length; k++) {
      const s = signs[k];
      if (s === 0) { runLen = 0; continue; }
      if (s === currentSign) { runLen++; continue; }
      if (runLen >= RUN_THRESHOLD && currentSign !== 0) cuts.push(r.startIdx + k);
      currentSign = s;
      runLen = 1;
    }
    cuts.push(r.endIdx);
    if (cuts.length <= 2) return [r];
    const pieces: Raw[] = [];
    for (let k = 0; k < cuts.length - 1; k++) pieces.push({ type: "corner", startIdx: cuts[k], endIdx: cuts[k + 1] });
    // Only keep the split if every piece is above MIN_SECTION_M; else leave as one
    if (!pieces.every((p) => dists[p.endIdx] - dists[p.startIdx] >= MIN_SECTION_M)) return [r];
    return pieces;
  };
  // Pass B: split sections that contain too much total turning. A "technical"
  // section (hairpins, esses, lots of direction change) accumulates radians
  // quickly — those split into smaller pieces so each can be focused on. A
  // long gentle sweeper stays as one long segment because it accumulates slowly.
  const TURN_BUDGET_RAD = (2 * Math.PI) / 3; // ~120° of integrated turning per segment
  const sizeSplit = (r: Raw): Raw[] => {
    if (r.type !== "corner") return [r];
    const totalTurn = (() => {
      let t = 0;
      for (let i = r.startIdx; i <= r.endIdx; i++) t += Math.abs(signedKappa[i]) * meanSpacing;
      return t;
    })();
    if (totalTurn <= TURN_BUDGET_RAD) return [r];
    // Find the index where half the turning has accumulated, then snap to the
    // nearest local |κ| minimum so the cut lands between corners, not mid-apex.
    const half = totalTurn / 2;
    let acc = 0;
    let halfIdx = Math.floor((r.startIdx + r.endIdx) / 2);
    for (let i = r.startIdx; i <= r.endIdx; i++) {
      acc += Math.abs(signedKappa[i]) * meanSpacing;
      if (acc >= half) { halfIdx = i; break; }
    }
    const search = Math.max(5, Math.round(150 / meanSpacing));
    let splitIdx = halfIdx;
    let bestK = smooth[halfIdx];
    for (let k = halfIdx - search; k <= halfIdx + search; k++) {
      if (k <= r.startIdx + 1 || k >= r.endIdx - 1) continue;
      if (smooth[k] < bestK) { bestK = smooth[k]; splitIdx = k; }
    }
    if (splitIdx <= r.startIdx + 1 || splitIdx >= r.endIdx - 1) return [r];
    if (dists[splitIdx] - dists[r.startIdx] < MIN_SECTION_M) return [r];
    if (dists[r.endIdx] - dists[splitIdx] < MIN_SECTION_M) return [r];
    return [
      { type: "corner", startIdx: r.startIdx, endIdx: splitIdx },
      { type: "corner", startIdx: splitIdx, endIdx: r.endIdx },
    ];
  };
  // Pass A2: split a section at deep valleys between two distinct curvature peaks.
  // (catches cases where the section is one direction but has two clear apexes)
  const peakSplit = (r: Raw): Raw[] => {
    if (r.type !== "corner") return [r];
    const len = dists[r.endIdx] - dists[r.startIdx];
    if (len < 2 * MIN_SECTION_M) return [r];
    // Find local maxima ≥ ENTER thresh, separated by ≥ MIN_SECTION_M arc length
    const peaks: { idx: number; k: number }[] = [];
    for (let i = r.startIdx + 2; i < r.endIdx - 2; i++) {
      const v = smooth[i];
      if (v < STRAIGHT_OUT) continue;
      if (v >= smooth[i - 1] && v >= smooth[i + 1] && v >= smooth[i - 2] && v >= smooth[i + 2]) {
        if (peaks.length === 0 || dists[i] - dists[peaks[peaks.length - 1].idx] >= MIN_SECTION_M) {
          peaks.push({ idx: i, k: v });
        } else if (v > peaks[peaks.length - 1].k) {
          peaks[peaks.length - 1] = { idx: i, k: v };
        }
      }
    }
    if (peaks.length < 2) return [r];
    // For each pair of adjacent peaks, find the deepest valley between them
    const cuts: number[] = [r.startIdx];
    for (let p = 0; p < peaks.length - 1; p++) {
      let valIdx = peaks[p].idx;
      let valK = Infinity;
      for (let i = peaks[p].idx; i <= peaks[p + 1].idx; i++) {
        if (smooth[i] < valK) { valK = smooth[i]; valIdx = i; }
      }
      // Only split if the valley is meaningfully lower than peaks (≤60% of avg peak)
      const avgPeak = (peaks[p].k + peaks[p + 1].k) / 2;
      // Valley must be very deep AND sit well below the straight threshold —
      // we only split a same-direction section when there's a clear gap.
      if (valK < avgPeak * 0.25 && valK < STRAIGHT_IN) cuts.push(valIdx);
    }
    cuts.push(r.endIdx);
    if (cuts.length <= 2) return [r];
    const pieces: Raw[] = [];
    for (let k = 0; k < cuts.length - 1; k++) pieces.push({ type: "corner", startIdx: cuts[k], endIdx: cuts[k + 1] });
    if (!pieces.every((p) => dists[p.endIdx] - dists[p.startIdx] >= MIN_SECTION_M)) return [r];
    return pieces;
  };
  let splitSections: Raw[] = merged.flatMap(signSplit).flatMap(peakSplit);
  for (let iter = 0; iter < 10; iter++) {
    const next: Raw[] = [];
    let changed = false;
    for (const r of splitSections) {
      const parts = sizeSplit(r);
      if (parts.length > 1) changed = true;
      next.push(...parts);
    }
    splitSections = next;
    if (!changed) break;
  }

  // Name and report direction for sections (sum signed κ across the section)
  const segments: DetectedSegment[] = splitSections.map((r, idx) => {
    let direction: "left" | "right" | null = null;
    if (r.type === "corner") {
      let sumKappa = 0;
      for (let i = r.startIdx; i <= Math.min(r.endIdx, n - 1); i++) sumKappa += signedKappa[i];
      direction = sumKappa > 0.5 ? "right" : sumKappa < -0.5 ? "left" : null;
    }
    const name = String(idx + 1);
    return {
      type: r.type,
      startIdx: r.startIdx,
      endIdx: r.endIdx,
      startFrac: r.startIdx / n,
      endFrac: r.endIdx / n,
      distStart: dists[r.startIdx],
      distEnd: dists[r.endIdx],
      name,
      direction,
    };
  });

  return { segments, totalDist };
}

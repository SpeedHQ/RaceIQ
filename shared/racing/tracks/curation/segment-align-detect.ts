/**
 * Alignment of curvature-detected corners against a track's shared facts.
 *
 * The geometry (extracted from game files) is authoritative for WHERE corners
 * are; the facts file (from official circuit maps) is authoritative for WHAT
 * they are called. This module matches the two ordered sequences and produces
 * named segments, refusing to guess when they disagree.
 *
 * Facts themselves carry no detector tolerances — a corner is either in the
 * numbering or it isn't. Where a centerline genuinely resolves one official
 * turn into two arcs, or skips a kink entirely, the allowance arrives as
 * DetectHints (shared/data/tracks/detect-hints.json) from the caller; omit them and
 * every corner must match exactly once.
 *
 * Locale note: proper nouns ("Eau Rouge") are canonical and never translated.
 * Corners without a real name get the machine token "T<number>" and straights
 * get "" — the client localizes those generically via Paraglide.
 */


/** A single detected corner region on the centerline. */
export interface CornerRegion {
  startFrac: number;
  endFrac: number;
  apexFrac: number;
  direction: "left" | "right";
  /** Peak |curvature| (1/m) at the apex. */
  peakKappa: number;
  lengthM: number;
  /** Integrated turn angle across the region (radians). */
  turnRad: number;
  /**
   * Bends too little to be a corner on its own (< MIN_TURN_RAD), so alignment
   * only claims it when a curated name says a corner is there — otherwise it
   * is skipped for free and stays part of the surrounding straight.
   */
  weak?: boolean;
}

interface Pt { x: number; z: number }

/**
 * ~11.5° of heading change required for a region to stand alone as a corner.
 * Shared with the aligner, which prices weak-region skips against it.
 */
export const MIN_TURN_RAD = 0.20;

/**
 * Fine-grained corner detection from a centerline (unlike detectSegments,
 * which groups corners into coarse "sections" for the map overlay UI).
 *
 * A corner is a contiguous run where smoothed |κ| exceeds a radius threshold,
 * with hysteresis, split at direction changes, and merged across short
 * same-direction gaps (double-apex corners stay whole).
 */
export function detectCornerRegions(outline: Pt[]): { corners: CornerRegion[]; totalDist: number } {
  // Strict pass: the corners the detector is confident about on curvature alone.
  const strict = detectPass(outline, STRICT_K_IN, STRICT_K_OUT);

  // Loose pass: a big-radius sweep (Monza's Curva Grande, ~1/450) sits right on
  // the strict entry threshold, so whether it registers at all comes down to how
  // a game sampled its centerline — it exists on F1 and vanishes into a 1.1 km
  // hole on ACC. Re-running detection looser finds those, but its output may NOT
  // replace the strict regions: entering runs earlier lengthens them, which fuses
  // same-direction neighbours across MERGE_GAP_M and pushes borderline regions
  // past MIN_TURN_RAD (turnRad integrates the untrimmed run), silently reshaping
  // corners the name lists already align against. So only sweeps in the gaps the
  // strict pass left behind are taken, and always as weak — never asserting a
  // corner, just offering one a curated name may claim.
  const loose = detectPass(outline, LOOSE_K_IN, LOOSE_K_OUT);
  const extra = loose.corners.filter(
    (l) => !strict.corners.some((s) => l.rawStartFrac < s.rawEndFrac && l.rawEndFrac > s.rawStartFrac),
  );

  const corners = [...strict.corners, ...extra.map((c) => ({ ...c, weak: true as const }))]
    .sort((a, b) => a.startFrac - b.startFrac)
    .map(({ rawStartFrac, rawEndFrac, ...c }) => c);
  return { corners, totalDist: strict.totalDist };
}

const STRICT_K_IN = 1 / 450;
const STRICT_K_OUT = 1 / 700;
const LOOSE_K_IN = 1 / 650;
const LOOSE_K_OUT = 1 / 900;

/** A region plus its untrimmed extent, used to test overlap between passes. */
type PassRegion = CornerRegion & { rawStartFrac: number; rawEndFrac: number };

function detectPass(outline: Pt[], K_IN: number, K_OUT: number): { corners: PassRegion[]; totalDist: number } {
  const n = outline.length;
  if (n < 20) return { corners: [], totalDist: 0 };

  const dists: number[] = [0];
  for (let i = 1; i < n; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalDist = dists[n - 1];
  const meanSpacing = totalDist / n;

  const CURV_WINDOW_M = 12;
  const MIN_CORNER_M = 15;
  const WEAK_TURN_RAD = 0.10;  // below ~5.7° it's noise, not a corner anyone names
  const WEAK_LENGTH_M = 25;    // shorter than this can't stand alone as a corner
  const MERGE_GAP_M = 50;      // same-direction regions closer than this merge
  const SIGN_RUN_M = 25;       // sustained opposite sign for this long = split
  // K_OUT is deliberately loose so a corner's declining curvature tail bridges
  // MERGE_GAP_M gaps into the next apex (double-apex corners, chicanes) instead
  // of splitting. That same looseness makes regions overshoot into adjacent
  // straights. TRIM_FRAC re-tightens the rendered/timed boundary of an already
  // merged region without touching detection or merge decisions above — trim
  // is relative to each corner's OWN peak curvature (not a fixed radius),
  // since a fixed cutoff shrinks large-radius sustained-curvature corners
  // (banked oval turns, near-constant radius throughout) down to a sliver:
  // their interior never exceeds a fixed tight threshold, only their own peak.
  const TRIM_FRAC = 0.5;

  const winIdx = Math.max(2, Math.round(CURV_WINDOW_M / meanSpacing));
  const kappa: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - winIdx + n) % n;
    const b = (i + winIdx) % n;
    const a1 = Math.atan2(outline[i].z - outline[a].z, outline[i].x - outline[a].x);
    const a2 = Math.atan2(outline[b].z - outline[i].z, outline[b].x - outline[i].x);
    let dTheta = a2 - a1;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const arc = (dists[b] >= dists[a] ? dists[b] - dists[a] : dists[b] + totalDist - dists[a]) || 1;
    kappa[i] = dTheta / arc;
  }

  // Raw above-threshold runs with hysteresis
  type Run = { start: number; end: number };
  const runs: Run[] = [];
  let inCorner = false;
  let runStart = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(kappa[i]);
    if (!inCorner && k >= K_IN) { inCorner = true; runStart = i; }
    else if (inCorner && k < K_OUT) { inCorner = false; runs.push({ start: runStart, end: i - 1 }); }
  }
  if (inCorner) runs.push({ start: runStart, end: n - 1 });

  // Split runs at sustained direction changes
  const split: Run[] = [];
  const signRunIdx = Math.max(2, Math.round(SIGN_RUN_M / meanSpacing));
  for (const r of runs) {
    let segStart = r.start;
    let currentSign = 0;
    let flipStart = -1;
    for (let i = r.start; i <= r.end; i++) {
      const s = Math.sign(kappa[i]);
      if (s === 0) continue;
      if (currentSign === 0) { currentSign = s; continue; }
      if (s !== currentSign) {
        if (flipStart < 0) flipStart = i;
        if (i - flipStart + 1 >= signRunIdx) {
          split.push({ start: segStart, end: flipStart - 1 });
          segStart = flipStart;
          currentSign = s;
          flipStart = -1;
        }
      } else {
        flipStart = -1;
      }
    }
    split.push({ start: segStart, end: r.end });
  }

  // Direction + peak per run
  const regions = split.map((r) => {
    let sum = 0;
    let peak = 0;
    let apexIdx = r.start;
    for (let i = r.start; i <= r.end; i++) {
      sum += kappa[i];
      if (Math.abs(kappa[i]) > peak) { peak = Math.abs(kappa[i]); apexIdx = i; }
    }
    return {
      start: r.start,
      end: r.end,
      direction: (sum >= 0 ? "right" : "left") as "left" | "right",
      peak,
      apexIdx,
      // This sub-run's own peak, kept even after merging swallows a bigger
      // neighbour — trimming the merged region's outer edges against the
      // (possibly much taller) OTHER apex would walk right past a weak one
      // (e.g. a long fast entry into a hairpin) and erase it entirely.
      firstPeak: peak,
      lastPeak: peak,
    };
  });

  // Merge same-direction neighbours across short gaps (double-apex corners)
  const mergedRegions: typeof regions = [];
  for (const r of regions) {
    const prev = mergedRegions[mergedRegions.length - 1];
    if (prev && prev.direction === r.direction && dists[r.start] - dists[prev.end] <= MERGE_GAP_M) {
      prev.end = r.end;
      prev.lastPeak = r.peak;
      if (r.peak > prev.peak) { prev.peak = r.peak; prev.apexIdx = r.apexIdx; }
    } else {
      mergedRegions.push({ ...r });
    }
  }

  const corners: PassRegion[] = mergedRegions
    .map((r) => {
      // Existence (count, merge/split) is decided on the full K_OUT-bounded
      // region above; turn/length here filter that same untrimmed region so
      // trimming the exported boundary below can never change corner count.
      let turn = 0;
      for (let i = r.start; i <= r.end; i++) turn += Math.abs(kappa[i]) * meanSpacing;
      const untrimmedLengthM = dists[r.end] - dists[r.start];

      // Trim the loose K_OUT tail off each side, back to where curvature
      // drops below a fraction of the LOCAL sub-run's own peak on that side
      // (not the merged region's overall peak) — never looser than K_IN —
      // bounded so it never crosses the apex. Using the region-wide peak here
      // would, in an asymmetric compound corner (e.g. a long fast entry into
      // a much tighter hairpin), walk the weaker side's trim straight past
      // its own real apex and erase that whole half. Clamped at that side's
      // own peak too: a direction-split sub-run's peak can itself be under
      // K_IN (it only needs a sustained sign flip to split, not a fresh
      // K_IN crossing) — without the clamp the K_IN floor would reintroduce
      // the exact same "walk past a weak apex" bug it's meant to prevent.
      const kTrimStart = Math.min(r.firstPeak, Math.max(K_IN, r.firstPeak * TRIM_FRAC));
      const kTrimEnd = Math.min(r.lastPeak, Math.max(K_IN, r.lastPeak * TRIM_FRAC));
      let start = r.start;
      while (start < r.apexIdx && Math.abs(kappa[start]) < kTrimStart) start++;
      let end = r.end;
      while (end > r.apexIdx && Math.abs(kappa[end]) < kTrimEnd) end--;

      return {
        startFrac: dists[start] / totalDist,
        endFrac: dists[end] / totalDist,
        apexFrac: dists[r.apexIdx] / totalDist,
        direction: r.direction,
        peakKappa: r.peak,
        lengthM: dists[end] - dists[start],
        turnRad: turn,
        untrimmedLengthM,
        // Pre-trim extent: overlap between passes is tested on this, since a
        // loose region can clear a strict region's trimmed bounds while sitting
        // squarely inside the curvature it was trimmed from.
        rawStartFrac: dists[r.start] / totalDist,
        rawEndFrac: dists[r.end] / totalDist,
      };
    })
    .filter((c) => c.untrimmedLengthM >= MIN_CORNER_M && c.turnRad >= WEAK_TURN_RAD)
    // Runs that bend too little to be a corner on their own are kept as weak
    // regions rather than dropped. Geometry alone can't tell Spa's Raidillon
    // (~0.19 rad, just under the cutoff) from a meaningless kink — but the
    // track facts file can, so alignment claims a weak region when a name
    // says a corner is there and skips it for free otherwise. A very short run
    // is weak on the same grounds regardless of how hard it bends: a 20 m blip
    // is as often a centerline wobble on a hairpin exit as it is a real kink,
    // and only the roster knows which. Weak is not "ignorable" though — the
    // skip price scales with turn angle (see WEAK_SKIP), so a short-but-sharp
    // bend like Melbourne T1 (17 m, 1.9 rad) is still expensive to leave out.
    .map(({ untrimmedLengthM, ...c }) =>
      c.turnRad < MIN_TURN_RAD || c.lengthM < WEAK_LENGTH_M ? { ...c, weak: true } : c);

  return { corners, totalDist };
}

/**
 * Alignment of curvature-detected corners against curated corner-name lists.
 *
 * The geometry (extracted from game files) is authoritative for WHERE corners
 * are; the curated name list (from official circuit maps) is authoritative for
 * WHAT they are called. This module matches the two ordered sequences and
 * produces named segments, refusing to guess when they disagree.
 *
 * Locale note: proper nouns ("Eau Rouge") are canonical and never translated.
 * Corners without a real name get the machine token "T<number>" and straights
 * get "" — the client localizes those generically via Paraglide.
 */

import type { NamedSegment } from "./track-named-segments";

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
  const MIN_TURN_RAD = 0.20;   // ~11.5° of heading change required to stand alone
  const WEAK_TURN_RAD = 0.10;  // below ~5.7° it's noise, not a corner anyone names
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
    // curated name list can, so alignment claims a weak region when a name
    // says a corner is there and skips it for free otherwise.
    .map(({ untrimmedLengthM, ...c }) => (c.turnRad < MIN_TURN_RAD ? { ...c, weak: true } : c));

  return { corners, totalDist };
}

// ─── Name-list types ─────────────────────────────────────────────────────────

export interface CornerNameEntry {
  /** Official turn number (1-based, in racing order). */
  number: number;
  /** Canonical proper name; "" if the corner has no real name (renders as T<number>). */
  name: string;
  direction?: "left" | "right";
  /**
   * Corners sharing a group label form a complex (e.g. a chicane) that the
   * detector may merge into a single region. When merged, the region is named
   * after the group.
   */
  group?: string;
  /**
   * Max detected regions this corner alone may span (default 1). Long
   * multi-apex corners occasionally split in two.
   */
  spans?: number;
  /**
   * A shallow/fast corner (big radius, small heading change) that some games'
   * centerlines don't register as a corner at all. May match zero regions.
   */
  optional?: boolean;
  /**
   * Additional official turn numbers subsumed by this entry (e.g. Pouhon is
   * officially T10-T11 but modelled as one entry: number 10, covers [11]).
   */
  covers?: number[];
}

export interface StraightNameEntry {
  /** The straight directly after this corner number gets this name. */
  after: number;
  name: string;
}

export interface SectorAnchors {
  /** Sector 1 ends at the exit of this corner number. */
  s1EndAfterCorner?: number;
  /** Sector 2 ends at the exit of this corner number. */
  s2EndAfterCorner?: number;
  /** Optional meters past the anchored corner exit. */
  s1OffsetM?: number;
  s2OffsetM?: number;
  /** Explicit researched fractions — used verbatim when anchors are absent. */
  s1End?: number;
  s2End?: number;
}

export interface CornerNameList {
  circuit: string;
  /** Provenance of the naming/sector data (circuit map, wiki, FIA doc). */
  source?: string;
  /** Official number of turns — corner entries must account for 1..turnCount. */
  turnCount: number;
  corners: CornerNameEntry[];
  straights?: StraightNameEntry[];
  sectors?: SectorAnchors;
}

/**
 * Validate a curated name list against its declared official turn count:
 * every turn number 1..turnCount must be accounted for exactly once (via
 * `number` or `covers`), in strictly increasing order around the lap.
 */
export function validateNameList(list: CornerNameList): AlignmentIssue[] {
  const issues: AlignmentIssue[] = [];
  if (!Number.isInteger(list.turnCount) || list.turnCount < 1) {
    issues.push({ severity: "error", message: `turnCount missing or invalid (${list.turnCount})` });
    return issues;
  }
  const seen = new Set<number>();
  let prevMax = 0;
  for (const c of list.corners) {
    const nums = [c.number, ...(c.covers ?? [])];
    for (const n of nums) {
      if (!Number.isInteger(n) || n < 1 || n > list.turnCount) {
        issues.push({ severity: "error", message: `turn ${n} outside 1..${list.turnCount}` });
        continue;
      }
      if (seen.has(n)) issues.push({ severity: "error", message: `turn ${n} listed twice` });
      seen.add(n);
    }
    const lo = Math.min(...nums);
    if (lo <= prevMax) issues.push({ severity: "error", message: `turn ${c.number} out of racing order` });
    prevMax = Math.max(prevMax, ...nums);
  }
  for (let n = 1; n <= list.turnCount; n++) {
    if (!seen.has(n)) issues.push({ severity: "error", message: `turn ${n} unaccounted for (add an entry or covers)` });
  }
  return issues;
}

// ─── Alignment ───────────────────────────────────────────────────────────────

/** One name-list "unit" to match: a single corner or a grouped complex. */
interface Unit {
  members: CornerNameEntry[];
  group?: string;
  maxSpan: number;
}

export interface AlignmentIssue {
  severity: "error" | "warning";
  message: string;
}

export interface AlignedCorner {
  /** Index into the detected corner-region list (last region when merged). */
  regionIndex: number;
  /** Corner numbers covered by this section. */
  numbers: number[];
  name: string;
  /** null for mixed-direction complexes (chicanes). */
  direction: "left" | "right" | null;
  startFrac: number;
  endFrac: number;
  /**
   * Complex this turn belongs to (Rivazza, Variante Alta, Les Combes). Each
   * turn is its own section so the debug editor can move a single apex, but
   * consumers that label the map draw the complex once under this name.
   */
  group?: string;
}

export interface AlignmentResult {
  ok: boolean;
  /** Total fuzz cost — 0 means detector and name list agree exactly. */
  cost: number;
  issues: AlignmentIssue[];
  /** Final named segments (corners + straights) covering the whole lap in order. */
  segments: NamedSegment[];
  corners: AlignedCorner[];
}

function displayName(entry: CornerNameEntry): string {
  return entry.name || `T${entry.number}`;
}

/** Collapse consecutive same-group corner entries into matchable units. */
function buildUnits(corners: CornerNameEntry[]): Unit[] {
  const units: Unit[] = [];
  for (const entry of corners) {
    const prev = units[units.length - 1];
    if (entry.group && prev?.group === entry.group) {
      prev.members.push(entry);
      prev.maxSpan += entry.spans ?? 1;
    } else {
      units.push({ members: [entry], group: entry.group, maxSpan: entry.spans ?? 1 });
    }
  }
  for (const u of units) {
    if (u.members.length > 1) u.maxSpan = Math.max(u.maxSpan, u.members.length);
  }
  return units;
}

const HARD_FAIL = Number.POSITIVE_INFINITY;

/**
 * Cost of unit `u` consuming detected regions `segs` (in order).
 * Direction conflicts are hard failures; span mismatches are soft cost.
 */
function unitCost(u: Unit, segs: CornerRegion[]): number {
  const expected = u.members.length;

  // Deviations from a 1:1 mapping that the name list explicitly sanctions
  // (groups may merge, spans may split) carry only a tie-break cost so the
  // DP still prefers 1:1 when both are possible. Costs < 1 therefore mean
  // "aligned exactly as annotated"; costs >= 1 mean unsanctioned fuzz.
  const TIE_BREAK = 0.01;

  if (segs.length === expected) {
    // 1:1 member-to-region — check each direction pair
    for (let i = 0; i < expected; i++) {
      const want = u.members[i].direction;
      if (want && want !== segs[i].direction) return HARD_FAIL;
    }
    return 0;
  }

  if (expected === 1) {
    // One corner split into several regions — all must match its direction
    const want = u.members[0].direction;
    if (want) {
      for (const s of segs) {
        if (s.direction !== want) return HARD_FAIL;
      }
    }
    return segs.length <= u.maxSpan ? (segs.length - 1) * TIE_BREAK : segs.length - 1;
  }

  // Complex merged into fewer regions than members — mixed directions are
  // expected (chicanes), so only enforce direction on single-direction complexes.
  const dirs = new Set(u.members.map((m) => m.direction).filter(Boolean));
  if (dirs.size === 1) {
    const want = u.members[0].direction!;
    for (const s of segs) {
      if (s.direction !== want) return HARD_FAIL;
    }
  }
  return Math.abs(expected - segs.length) * TIE_BREAK;
}

/**
 * Match ordered name-list units onto ordered detected regions via DP.
 * Every unit and every strong region must be consumed; weak regions may be
 * skipped (see WEAK_SKIP) — that is what lets a curated name claim a bend the
 * detector was unwilling to call a corner by itself.
 */
function matchUnits(units: Unit[], detected: CornerRegion[]):
  { cost: number; spansPerUnit: number[]; skipped: boolean[] } | null {
  const nU = units.length;
  const nD = detected.length;
  // Cheaper than any sanctioned mapping (TIE_BREAK), so a unit that can take a
  // weak region 1:1 does, while an unnamed kink is left alone. Non-zero so it
  // never ties with claiming it.
  const WEAK_SKIP = 0.005;
  const dp: number[][] = Array.from({ length: nU + 1 }, () => new Array(nD + 1).fill(HARD_FAIL));
  // How each state was reached, so the walk back knows unit takes from skips.
  const from: ({ pi: number; pj: number; take: number } | null)[][] =
    Array.from({ length: nU + 1 }, () => new Array(nD + 1).fill(null));
  dp[0][0] = 0;
  for (let i = 0; i <= nU; i++) {
    for (let j = 0; j <= nD; j++) {
      if (dp[i][j] === HARD_FAIL) continue;
      // Leave a weak region out of every section — it stays part of the straight
      if (j < nD && detected[j].weak) {
        const total = dp[i][j] + WEAK_SKIP;
        if (total < dp[i][j + 1]) {
          dp[i][j + 1] = total;
          from[i][j + 1] = { pi: i, pj: j, take: -1 };
        }
      }
      if (i === nU) continue;
      // Optional corners (too shallow for some games' centerlines) may match nothing
      if (units[i].members.length === 1 && units[i].members[0].optional) {
        const total = dp[i][j] + 0.01;
        if (total < dp[i + 1][j]) {
          dp[i + 1][j] = total;
          from[i + 1][j] = { pi: i, pj: j, take: 0 };
        }
      }
      const maxTake = Math.min(units[i].maxSpan + 1, nD - j); // allow one over maxSpan at extra cost
      for (let take = 1; take <= maxTake; take++) {
        const c = unitCost(units[i], detected.slice(j, j + take));
        if (c === HARD_FAIL) continue;
        const over = take > units[i].maxSpan ? 2 : 0;
        const total = dp[i][j] + c + over;
        if (total < dp[i + 1][j + take]) {
          dp[i + 1][j + take] = total;
          from[i + 1][j + take] = { pi: i, pj: j, take };
        }
      }
    }
  }
  if (dp[nU][nD] === HARD_FAIL) return null;
  const spansPerUnit: number[] = new Array(nU).fill(0);
  const skipped: boolean[] = new Array(nD).fill(false);
  let i = nU;
  let j = nD;
  while (i > 0 || j > 0) {
    const step = from[i][j];
    if (!step) return null;
    if (step.take === -1) skipped[j - 1] = true;
    else spansPerUnit[i - 1] = step.take;
    i = step.pi;
    j = step.pj;
  }
  return { cost: dp[nU][nD], spansPerUnit, skipped };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Align detected corner regions (in lap order) against a curated name list
 * and build the full named segment sequence (corners + connecting straights).
 *
 * Handedness is auto-detected: some games' coordinate systems mirror the
 * track (a right hairpin reads as "left"), so both polarities are tried and
 * the better-scoring one wins. Output directions are always real-world.
 */
export function alignSegments(
  detected: CornerRegion[],
  nameList: CornerNameList,
  totalDistM?: number,
): AlignmentResult {
  const flip = (c: CornerRegion): CornerRegion => ({
    ...c,
    direction: c.direction === "left" ? "right" : "left",
  });
  const normal = alignOnePolarity(detected, nameList, totalDistM);
  const mirrored = alignOnePolarity(detected.map(flip), nameList, totalDistM);
  if (!normal.ok || (mirrored.ok && mirrored.cost < normal.cost)) {
    if (mirrored.ok) {
      mirrored.issues.push({ severity: "warning", message: "mirrored coordinate system detected — directions flipped to real-world" });
      return mirrored;
    }
  }
  return normal;
}

function alignOnePolarity(
  detected: CornerRegion[],
  nameList: CornerNameList,
  totalDistM?: number,
): AlignmentResult {
  const issues: AlignmentIssue[] = [];
  const units = buildUnits(nameList.corners);

  if (units.length === 0 || detected.length === 0) {
    issues.push({ severity: "error", message: `nothing to align: ${units.length} units vs ${detected.length} detected corners` });
    return { ok: false, cost: HARD_FAIL, issues, segments: [], corners: [] };
  }

  // A game's centerline may start anywhere on the lap (e.g. ACC Silverstone
  // starts at the old pit straight before Copse), so the detected sequence
  // can be rotated relative to the name list. Try every rotation; offset 0
  // is preferred via a tie-break penalty on the others.
  let match: { cost: number; spansPerUnit: number[]; skipped: boolean[] } | null = null;
  let rotation = 0;
  for (let offset = 0; offset < detected.length; offset++) {
    const rotated = offset === 0 ? detected : [...detected.slice(offset), ...detected.slice(0, offset)];
    const m = matchUnits(units, rotated);
    if (!m) continue;
    const cost = m.cost + (offset === 0 ? 0 : 0.05);
    if (!match || cost < match.cost) {
      match = { cost, spansPerUnit: m.spansPerUnit, skipped: m.skipped };
      rotation = offset;
    }
  }
  if (!match) {
    issues.push({
      severity: "error",
      message: `no valid alignment at any lap rotation: ${nameList.corners.length} named corners (${units.length} units) vs ${detected.length} detected regions — check direction fields and grouping`,
    });
    return { ok: false, cost: HARD_FAIL, issues, segments: [], corners: [] };
  }
  if (rotation !== 0) {
    detected = [...detected.slice(rotation), ...detected.slice(0, rotation)];
    issues.push({ severity: "warning", message: `centerline start is mid-lap: matched with rotation offset ${rotation}` });
  }
  if (match.cost >= 1) {
    issues.push({ severity: "warning", message: `fuzzy alignment (cost ${match.cost}): detector segmentation differs from name-list expectation` });
  }

  const corners: AlignedCorner[] = [];
  const lastRegionIdxByCorner = new Map<number, number>();
  let cursor = 0;
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    const take = match.spansPerUnit[ui];
    // Weak regions no unit claimed aren't part of any section — step over them
    while (match.skipped[cursor]) cursor++;
    if (take === 0) {
      issues.push({ severity: "warning", message: `corner ${u.members[0].number} (${displayName(u.members[0])}) not detected on this centerline — omitted` });
      continue;
    }
    const consumed = detected.slice(cursor, cursor + take);
    const baseIdx = cursor;
    cursor += take;

    const regionIdx = baseIdx + take - 1;
    const dirs = new Set(consumed.map((c) => c.direction));
    const numbers = u.members.flatMap((m) => [m.number, ...(m.covers ?? [])]).sort((a, b) => a - b);

    // A grouped complex (Rivazza, Les Combes) is one *name* but several turns.
    // When the detector found exactly one region per member, emit a section per
    // turn — the debug editor can then nudge a single apex, and consumers that
    // label the map draw the complex once via `group`. Only when the mapping is
    // ambiguous (spans-split double-apex, fewer regions than members) does the
    // unit collapse into a single merged section.
    if (u.group && take === u.members.length && u.members.length > 1) {
      for (let k = 0; k < take; k++) {
        const m = u.members[k];
        const memberNumbers = [m.number, ...(m.covers ?? [])].sort((a, b) => a - b);
        corners.push({
          regionIndex: baseIdx + k,
          numbers: memberNumbers,
          name: displayName(m),
          direction: consumed[k].direction,
          startFrac: round4(consumed[k].startFrac),
          endFrac: round4(consumed[k].endFrac),
          group: u.group,
        });
        for (const num of memberNumbers) lastRegionIdxByCorner.set(num, baseIdx + k);
      }
      // Straights anchor to the corner they follow — the complex's last region
      // is what a "straight after Rivazza" anchor means.
      for (const num of numbers) lastRegionIdxByCorner.set(num, regionIdx);
      continue;
    }

    // One unit = one output section: entry to exit, matching how coaches and
    // track maps refer to it. Direction is null when regions disagree (chicanes).
    const name = u.group ?? displayName(u.members[0]);
    corners.push({
      regionIndex: regionIdx,
      numbers,
      name,
      direction: dirs.size === 1 ? consumed[0].direction : null,
      startFrac: round4(consumed[0].startFrac),
      endFrac: round4(consumed[take - 1].endFrac),
      ...(u.group ? { group: u.group } : {}),
    });
    for (const num of numbers) lastRegionIdxByCorner.set(num, regionIdx);
  }

  // Straight names anchor to the corner they follow
  const straightNameAfterRegion = new Map<number, string>();
  for (const s of nameList.straights ?? []) {
    // If the anchor corner wasn't detected (optional kink), fall back to the
    // nearest earlier detected corner — the straight after it is the same one.
    let idx: number | undefined;
    for (let n = s.after; n >= 1 && idx === undefined; n--) {
      idx = lastRegionIdxByCorner.get(n);
    }
    if (idx === undefined) {
      issues.push({ severity: "warning", message: `straight "${s.name}" anchored after unknown corner ${s.after}` });
      continue;
    }
    straightNameAfterRegion.set(idx, s.name);
  }

  // Restore lap order (rotation matching walks the corners mid-lap first)
  corners.sort((a, b) => a.startFrac - b.startFrac);

  // Stretch each corner section over its approach and exit: coaching sections
  // cover the braking zone and corner exit, not just the tight curvature arc
  // (matches how track guides describe corners). Capped at half the gap to
  // the neighbouring corner so real straights (Kemmel) survive intact.
  // The padded fracs ARE the section boundaries — sector anchors resolve
  // against them, so an anchored boundary coincides with the section end.
  const ENTRY_PAD_M = 150;
  // Padding covers the braking zone and exit either side of the detected arc.
  const EXIT_PAD_M = 80;
  // A curated straight is real by declaration, so padding may not consume the
  // whole gap it lives in — Donington's Starkey's Straight sits in a ~140 m gap
  // that entry+exit padding would erase entirely, silently pushing its name
  // onto the next straight down the lap.
  const MIN_NAMED_STRAIGHT_M = 30;
  if (totalDistM) {
    const unpadded = corners.map((c) => ({ start: c.startFrac, end: c.endFrac }));
    // Space each gap must keep, as a fraction: reserved when a name anchors
    // there. Reserving exactly the minimum isn't enough — round4() quantizes
    // both boundaries to 1e-4 of a lap, which can shave the gap back under the
    // cutoff (Brands Hatch's Cooper Straight landed at 29.8 m against 30), so
    // the slack for that rounding is reserved as well.
    const ROUND_SLACK = 4e-4;
    const reserveAfter = (i: number) =>
      i >= 0 && i < corners.length && straightNameAfterRegion.has(corners[i].regionIndex)
        ? MIN_NAMED_STRAIGHT_M / totalDistM + ROUND_SLACK
        : 0;
    for (let i = 0; i < corners.length; i++) {
      const prevEnd = i > 0 ? unpadded[i - 1].end : 0;
      const nextStart = i + 1 < corners.length ? unpadded[i + 1].start : 1;
      const entryRoom = Math.max(0, unpadded[i].start - prevEnd - reserveAfter(i - 1)) / 2;
      const exitRoom = Math.max(0, nextStart - unpadded[i].end - reserveAfter(i)) / 2;
      const entryPad = Math.min(ENTRY_PAD_M / totalDistM, entryRoom);
      const exitPad = Math.min(EXIT_PAD_M / totalDistM, exitRoom);
      corners[i].startFrac = round4(Math.max(0, unpadded[i].start - Math.max(0, entryPad)));
      corners[i].endFrac = round4(Math.min(1, unpadded[i].end + Math.max(0, exitPad)));
    }
  }

  // Build the full lap: straights fill the gaps between corner regions.
  // A straight name whose anchor is followed only by a sliver (the next
  // corner starts immediately) rolls forward to the next real straight —
  // e.g. Wellington Straight anchored after The Loop still lands correctly
  // when Aintree is detected in between.
  const segments: NamedSegment[] = [];
  let pendingName = "";
  // A short gap between two corners is a chute, not a straight — corners that
  // flow into each other (Les Fagnes → Piff Paff) should stay adjacent rather
  // than be split by a segment nobody would call a straight. Absorb the gap
  // instead, which joins the corner sections and keeps the lap contiguous.
  // A fixed lap-fraction (e.g. 0.002) under-absorbs on long tracks now that
  // corner trimming (see detectCornerRegions) produces gaps of tens of meters;
  // anchor the cutoff to an absolute distance instead.
  const MIN_UNNAMED_STRAIGHT_M = 100;
  const fracOf = (m: number) => (totalDistM ? m / totalDistM : m / 15000);
  const pushStraight = (startFrac: number, endFrac: number, afterRegion: number | null) => {
    let anchored: string | undefined;
    if (afterRegion !== null) {
      anchored = straightNameAfterRegion.get(afterRegion);
      if (anchored) pendingName = anchored;
    }
    const minM = anchored ? MIN_NAMED_STRAIGHT_M : MIN_UNNAMED_STRAIGHT_M;
    if (endFrac - startFrac < fracOf(minM)) {
      // Sliver: absorb into the previous segment so the lap stays contiguous
      const prev = segments[segments.length - 1];
      if (prev) prev.endFrac = round4(endFrac);
      return;
    }
    segments.push({
      type: "straight",
      name: pendingName,
      startFrac: round4(startFrac),
      endFrac: round4(endFrac),
    });
    pendingName = "";
  };

  if (corners.length > 0 && corners[0].startFrac > 0) pushStraight(0, corners[0].startFrac, null);
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    const prevEnd = segments.length > 0 ? segments[segments.length - 1].endFrac : 0;
    segments.push({
      type: "corner",
      name: c.name,
      ...(c.direction ? { direction: c.direction } : {}),
      startFrac: Math.max(c.startFrac, prevEnd),
      endFrac: c.endFrac,
      numbers: c.numbers,
      ...(c.group ? { group: c.group } : {}),
    });
    const nextStart = i + 1 < corners.length ? corners[i + 1].startFrac : 1;
    pushStraight(c.endFrac, nextStart, c.regionIndex);
  }
  // Lap must span exactly 0..1 (leading/trailing slivers are absorbed)
  if (segments.length > 0) {
    segments[0].startFrac = 0;
    segments[segments.length - 1].endFrac = 1;
  }

  // The start/finish line sits mid-straight, so the straight named after the
  // last corner (Donington's Wheatcroft Straight) continues past 0 as the
  // lap's leading segment — same tarmac, so it carries the same name. Both
  // halves are grouped: one straight, split by the line, labelled once.
  const first = segments[0];
  const last = segments[segments.length - 1];
  const lastCorner = corners[corners.length - 1];
  if (first?.type === "straight" && !first.name && lastCorner) {
    const wrapped = straightNameAfterRegion.get(lastCorner.regionIndex);
    if (wrapped && last?.type === "straight" && last.name === wrapped && last !== first) {
      first.name = wrapped;
      first.group = wrapped;
      last.group = wrapped;
    }
  }

  // Sliver absorption may have extended corner segments — keep the corners
  // array (used for sector anchoring) in sync with the final section bounds.
  const cornerSegs = segments.filter((s) => s.type === "corner");
  for (let i = 0; i < corners.length && i < cornerSegs.length; i++) {
    corners[i].startFrac = cornerSegs[i].startFrac;
    corners[i].endFrac = cornerSegs[i].endFrac;
  }

  return { ok: true, cost: match.cost, issues, segments, corners };
}

export interface ResolvedSectors {
  s1End: number;
  s2End: number;
  source: "corner-anchored" | "hand-researched";
}

/**
 * Resolve sector boundaries from anchors ("S1 ends after corner N") against
 * aligned corner geometry, or pass through explicit researched fractions.
 */
export function resolveSectors(
  anchors: SectorAnchors,
  corners: AlignedCorner[],
  totalDist: number,
): { sectors: ResolvedSectors | null; issues: AlignmentIssue[] } {
  const issues: AlignmentIssue[] = [];

  const anchored = (cornerNum: number | undefined, offsetM: number | undefined, label: string): number | null => {
    if (cornerNum === undefined) return null;
    const hits = corners.filter((c) => c.numbers.includes(cornerNum));
    if (hits.length === 0) {
      // Not fatal: explicit s1End/s2End fractions may still cover this boundary
      issues.push({ severity: "warning", message: `${label} anchor corner ${cornerNum} not present — falling back to explicit fraction if provided` });
      return null;
    }
    const exit = Math.max(...hits.map((c) => c.endFrac));
    const frac = exit + (offsetM && totalDist > 0 ? offsetM / totalDist : 0);
    return Math.min(0.999, Math.max(0.001, round4(frac)));
  };

  const s1Anchored = anchored(anchors.s1EndAfterCorner, anchors.s1OffsetM, "s1End");
  const s2Anchored = anchored(anchors.s2EndAfterCorner, anchors.s2OffsetM, "s2End");

  const s1 = s1Anchored ?? anchors.s1End ?? null;
  const s2 = s2Anchored ?? anchors.s2End ?? null;
  if (s1 === null || s2 === null) {
    if (anchors.s1EndAfterCorner !== undefined || anchors.s2EndAfterCorner !== undefined
      || anchors.s1End !== undefined || anchors.s2End !== undefined) {
      issues.push({ severity: "error", message: "incomplete sector definition: need both s1 and s2 (anchor or explicit)" });
    }
    return { sectors: null, issues };
  }
  if (!(s1 > 0 && s1 < s2 && s2 < 1)) {
    issues.push({ severity: "error", message: `invalid resolved sectors: s1End=${s1}, s2End=${s2}` });
    return { sectors: null, issues };
  }
  const source: ResolvedSectors["source"] =
    s1Anchored !== null && s2Anchored !== null ? "corner-anchored" : "hand-researched";
  return { sectors: { s1End: s1, s2End: s2, source }, issues };
}

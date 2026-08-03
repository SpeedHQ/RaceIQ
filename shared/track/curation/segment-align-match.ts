import type { DetectHints } from "../detect-hints";
import type { CornerFact, TrackFacts } from "../facts";
import type { NamedSegment } from "../named-segments";
import { MIN_TURN_RAD, type CornerRegion } from "./segment-align-detect";

// ─── Alignment ───────────────────────────────────────────────────────────────

/** One name-list "unit" to match: a single corner or a grouped complex. */
interface Unit {
  members: CornerFact[];
  group?: string;
  maxSpan: number;
  /** Every member is hinted optional, so the whole unit may go unmatched. */
  optional: boolean;
}

export interface AlignmentIssue {
  severity: "error" | "warning";
  message: string;
}

export interface AlignedCorner {
  /** Index into the detected corner-region list (last region when merged). */
  regionIndex: number;
  /** Official number of the turn this section is. One section per turn. */
  number: number;
  /** Extra official numbers this turn subsumes (Pouhon: number 10, covers 11). */
  covers?: number[];
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

function displayName(entry: CornerFact): string {
  return entry.name || `T${entry.number}`;
}

/** Collapse consecutive same-group corner entries into matchable units. */
function buildUnits(corners: CornerFact[], hints: DetectHints): Unit[] {
  const spanOf = (entry: CornerFact) => hints.get(entry.number)?.spans ?? 1;
  const optionalOf = (entry: CornerFact) => hints.get(entry.number)?.optional === true;
  const units: Unit[] = [];
  for (const entry of corners) {
    const prev = units[units.length - 1];
    if (entry.group && prev?.group === entry.group) {
      prev.members.push(entry);
      prev.maxSpan += spanOf(entry);
      prev.optional = prev.optional && optionalOf(entry);
    } else {
      units.push({
        members: [entry],
        group: entry.group,
        maxSpan: spanOf(entry),
        optional: optionalOf(entry),
      });
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

  // A grouped complex merging into fewer regions is expected, so it carries only
  // a tie-break cost and the DP still prefers 1:1 when both are possible. Costs
  // < 1 therefore mean "aligned as the facts describe"; costs >= 1 mean fuzz.
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
  // Weak regions are not equally droppable. One below MIN_TURN_RAD really is a
  // wobble and costs the base price; one that is weak only because it is short
  // (Melbourne T1: 17 m, 1.9 rad) is plainly a corner, and leaving it unnamed
  // has to cost more than the mis-numbering the DP would otherwise buy with it.
  const skipCost = (r: CornerRegion) =>
    WEAK_SKIP + 0.2 * Math.max(0, r.turnRad - MIN_TURN_RAD);
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
        const total = dp[i][j] + skipCost(detected[j]);
        if (total < dp[i][j + 1]) {
          dp[i][j + 1] = total;
          from[i][j + 1] = { pi: i, pj: j, take: -1 };
        }
      }
      if (i === nU) continue;
      // Hinted-optional corners (too shallow for some games' centerlines) may match nothing
      if (units[i].optional) {
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
 * Align detected corner regions (in lap order) against a track facts file
 * and build the full named segment sequence (corners + connecting straights).
 *
 * Handedness is auto-detected: some games' coordinate systems mirror the
 * track (a right hairpin reads as "left"), so both polarities are tried and
 * the better-scoring one wins. Output directions are always real-world.
 */
export function alignSegments(
  detected: CornerRegion[],
  facts: TrackFacts,
  totalDistM?: number,
  hints: DetectHints = new Map(),
): AlignmentResult {
  const flip = (c: CornerRegion): CornerRegion => ({
    ...c,
    direction: c.direction === "left" ? "right" : "left",
  });
  const normal = alignOnePolarity(detected, facts, totalDistM, hints);
  const mirrored = alignOnePolarity(detected.map(flip), facts, totalDistM, hints);
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
  facts: TrackFacts,
  totalDistM: number | undefined,
  hints: DetectHints,
): AlignmentResult {
  const issues: AlignmentIssue[] = [];
  const units = buildUnits(facts.corners, hints);

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
      message: `no valid alignment at any lap rotation: ${facts.corners.length} named corners (${units.length} units) vs ${detected.length} detected regions — check direction fields and grouping`,
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

    // Every turn is its own section, so the debug editor can nudge a single
    // apex and each row carries one official number. A grouped complex
    // (Rivazza, Les Combes) is one *name* over several turns: members keep
    // `group` so consumers that label the map draw it once.
    if (u.members.length > 1) {
      // One detected region per member: each turn takes its own region.
      // Otherwise the mapping is ambiguous (spans-split double-apex, or fewer
      // regions than members) — split the complex's whole span evenly instead,
      // which is the best available guess at where one turn ends and the next
      // begins, and is what the editor exists to correct.
      const perMember = take === u.members.length;
      const spanStart = consumed[0].startFrac;
      const spanEnd = consumed[take - 1].endFrac;
      const step = (spanEnd - spanStart) / u.members.length;
      for (let k = 0; k < u.members.length; k++) {
        const m = u.members[k];
        corners.push({
          regionIndex: perMember ? baseIdx + k : regionIdx,
          number: m.number,
          ...(m.covers?.length ? { covers: [...m.covers].sort((a, b) => a - b) } : {}),
          name: displayName(m),
          direction: perMember ? consumed[k].direction : dirs.size === 1 ? consumed[0].direction : null,
          startFrac: round4(perMember ? consumed[k].startFrac : spanStart + k * step),
          endFrac: round4(perMember ? consumed[k].endFrac : spanStart + (k + 1) * step),
          group: u.group ?? displayName(u.members[0]),
        });
        if (perMember) {
          for (const num of [m.number, ...(m.covers ?? [])]) lastRegionIdxByCorner.set(num, baseIdx + k);
        }
      }
      // Straights anchor to the corner they follow — the complex's last region
      // is what a "straight after Rivazza" anchor means.
      for (const num of numbers) lastRegionIdxByCorner.set(num, regionIdx);
      continue;
    }

    // Single turn: the section runs entry to exit, matching how coaches and
    // track maps refer to it. Direction is null when regions disagree.
    const m = u.members[0];
    corners.push({
      regionIndex: regionIdx,
      number: m.number,
      ...(m.covers?.length ? { covers: [...m.covers].sort((a, b) => a - b) } : {}),
      name: u.group ?? displayName(m),
      direction: dirs.size === 1 ? consumed[0].direction : null,
      startFrac: round4(consumed[0].startFrac),
      endFrac: round4(consumed[take - 1].endFrac),
      ...(u.group ? { group: u.group } : {}),
    });
    for (const num of numbers) lastRegionIdxByCorner.set(num, regionIdx);
  }

  // Straight names anchor to the corner they follow
  const straightNameAfterRegion = new Map<number, string>();
  for (const s of facts.straights ?? []) {
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
      number: c.number,
      ...(c.covers?.length ? { covers: c.covers } : {}),
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

#!/usr/bin/env bun
/**
 * Compare current vs proposed segment-detection algorithms on a track centerline.
 *
 * Usage: bun scripts/prototype-segment-detect.ts <gameId> <ordinal>
 * Example: bun scripts/prototype-segment-detect.ts fm-2023 32
 */
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { initGameAdapters } from "../shared/games/init";
import type { GameId } from "../shared/types";
import { detectSegmentsV1 as v1, detectSegmentsV2 as v2 } from "../server/track-segment-detect";

initGameAdapters();

type Pt = { x: number; z: number };
type Seg = { type: "corner" | "straight"; startMeter: number; endMeter: number; direction?: "left" | "right" | null };

function cumulativeDistance(pts: Pt[]): number[] {
  const d = [0];
  for (let i = 1; i < pts.length; i++) {
    d.push(d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return d;
}

// ---------- CURRENT ALGORITHM (copied from server/routes/track-routes.ts) ----------
function currentAlgo(outline: Pt[]): Seg[] {
  const n = outline.length;
  const dists = cumulativeDistance(outline);
  const totalDist = dists[n - 1];

  const window = Math.max(3, Math.floor(n / 80));
  const signedCurv: number[] = [];
  const curv: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - window + n) % n;
    const next = (i + window) % n;
    const a1 = Math.atan2(outline[i].z - outline[prev].z, outline[i].x - outline[prev].x);
    const a2 = Math.atan2(outline[next].z - outline[i].z, outline[next].x - outline[i].x);
    let diff = a2 - a1;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    signedCurv.push(diff);
    curv.push(Math.abs(diff));
  }
  const sw = Math.max(2, Math.floor(n / 60));
  const smoothed: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -sw; j <= sw; j++) s += curv[(i + j + n) % n];
    smoothed.push(s / (sw * 2 + 1));
  }
  const sorted = [...smoothed].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(n * 0.54)];

  const raw: { type: "corner" | "straight"; startIdx: number; endIdx: number }[] = [];
  let curType: "corner" | "straight" = smoothed[0] > threshold ? "corner" : "straight";
  let segStart = 0;
  for (let i = 1; i < n; i++) {
    const t = smoothed[i] > threshold ? "corner" : "straight";
    if (t !== curType) {
      raw.push({ type: curType, startIdx: segStart, endIdx: i });
      curType = t;
      segStart = i;
    }
  }
  raw.push({ type: curType, startIdx: segStart, endIdx: n - 1 });

  const pass1: typeof raw = [];
  for (const s of raw) {
    const frac = (s.endIdx - s.startIdx) / n;
    if (frac < 0.015 && pass1.length > 0) pass1[pass1.length - 1].endIdx = s.endIdx;
    else pass1.push({ ...s });
  }
  const merged: typeof raw = [];
  for (const s of pass1) {
    if (merged.length > 0 && merged[merged.length - 1].type === s.type) {
      merged[merged.length - 1].endIdx = s.endIdx;
    } else merged.push({ ...s });
  }

  return merged.map((s) => {
    let dir: "left" | "right" | undefined;
    if (s.type === "corner") {
      let sum = 0;
      for (let i = s.startIdx; i <= Math.min(s.endIdx, n - 1); i++) sum += signedCurv[i];
      dir = sum > 0 ? "right" : "left";
    }
    return {
      type: s.type,
      startMeter: dists[s.startIdx],
      endMeter: s.endIdx < n ? dists[s.endIdx] : totalDist,
      direction: dir,
    };
  });
}

// ---------- PROPOSED ALGORITHM ----------
// All thresholds in meters. Sign-aware. Hysteresis. Sign-change splits S-bends.
function proposedAlgo(outline: Pt[]): Seg[] {
  const n = outline.length;
  const dists = cumulativeDistance(outline);
  const totalDist = dists[n - 1];
  const meanSpacing = totalDist / n;

  // Window (meters) for curvature calculation
  const CURV_WINDOW_M = 20;
  const SMOOTH_WINDOW_M = 30;
  const ENTER_KAPPA = 0.0025; // rad/m  (~400m radius — anything tighter than this is a real corner)
  const EXIT_KAPPA = 0.0010;  // rad/m  (~1000m radius — true straights only)
  const MIN_CORNER_M = 30;
  const MIN_STRAIGHT_M = 40;
  const MERGE_GAP_M = 25;

  const winIdx = Math.max(2, Math.round(CURV_WINDOW_M / meanSpacing));
  const smoothIdx = Math.max(2, Math.round(SMOOTH_WINDOW_M / meanSpacing));

  // Signed curvature per meter (rad/m)
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

  // Smooth signed curvature in meters
  const smooth: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -smoothIdx; j <= smoothIdx; j++) s += signedKappa[(i + j + n) % n];
    smooth[i] = s / (smoothIdx * 2 + 1);
  }

  // Hysteresis: walk meter-space, classify with current sign held
  type Raw = { type: "corner" | "straight"; sign: number; startIdx: number; endIdx: number };
  const raw: Raw[] = [];
  let inCorner = Math.abs(smooth[0]) > ENTER_KAPPA;
  let curSign = inCorner ? Math.sign(smooth[0]) : 0;
  let segStart = 0;

  for (let i = 1; i < n; i++) {
    const k = smooth[i];
    const absK = Math.abs(k);
    const sgn = Math.sign(k);
    if (inCorner) {
      // Sign-change split (only if curvature is meaningful — avoids flicker near zero)
      if (sgn !== 0 && sgn !== curSign && absK > ENTER_KAPPA) {
        raw.push({ type: "corner", sign: curSign, startIdx: segStart, endIdx: i });
        segStart = i;
        curSign = sgn;
      } else if (absK < EXIT_KAPPA) {
        raw.push({ type: "corner", sign: curSign, startIdx: segStart, endIdx: i });
        inCorner = false;
        curSign = 0;
        segStart = i;
      }
    } else {
      if (absK > ENTER_KAPPA) {
        raw.push({ type: "straight", sign: 0, startIdx: segStart, endIdx: i });
        inCorner = true;
        curSign = sgn;
        segStart = i;
      }
    }
  }
  raw.push({ type: inCorner ? "corner" : "straight", sign: curSign, startIdx: segStart, endIdx: n - 1 });

  // Merge tiny straights between same-direction corners (gap < MERGE_GAP_M)
  const merged: Raw[] = [];
  for (const s of raw) {
    const lenM = dists[s.endIdx] - dists[s.startIdx];
    if (
      s.type === "straight" &&
      lenM < MERGE_GAP_M &&
      merged.length >= 1 &&
      merged[merged.length - 1].type === "corner"
    ) {
      // Peek ahead later — for now just absorb into prev corner
      merged[merged.length - 1].endIdx = s.endIdx;
      continue;
    }
    merged.push({ ...s });
  }

  // Drop too-short corners and too-short straights (absorb into neighbour straight/corner)
  const cleaned: Raw[] = [];
  for (const s of merged) {
    const lenM = dists[s.endIdx] - dists[s.startIdx];
    const minLen = s.type === "corner" ? MIN_CORNER_M : MIN_STRAIGHT_M;
    if (lenM < minLen && cleaned.length > 0) {
      cleaned[cleaned.length - 1].endIdx = s.endIdx;
    } else {
      cleaned.push({ ...s });
    }
  }

  // Consolidate adjacent same-type+same-sign
  const final: Raw[] = [];
  for (const s of cleaned) {
    const prev = final[final.length - 1];
    if (prev && prev.type === s.type && prev.sign === s.sign) prev.endIdx = s.endIdx;
    else final.push({ ...s });
  }

  return final.map((s) => ({
    type: s.type,
    startMeter: dists[s.startIdx],
    endMeter: dists[s.endIdx],
    direction: s.type === "corner" ? (s.sign > 0 ? "right" : "left") : undefined,
  }));
}

// ---------- COMPARE ----------
function fmt(seg: Seg): string {
  const len = (seg.endMeter - seg.startMeter).toFixed(0).padStart(5);
  if (seg.type === "corner") return `T ${seg.direction === "left" ? "L" : "R"} ${seg.startMeter.toFixed(0).padStart(5)}→${seg.endMeter.toFixed(0).padStart(5)}m  (${len}m)`;
  return `S — ${seg.startMeter.toFixed(0).padStart(5)}→${seg.endMeter.toFixed(0).padStart(5)}m  (${len}m)`;
}
function counts(segs: Seg[]) {
  const c = segs.filter((s) => s.type === "corner").length;
  const s = segs.filter((s) => s.type === "straight").length;
  return { corners: c, straights: s, total: segs.length };
}

const [, , gameIdArg, ordArg] = process.argv;
if (!gameIdArg || !ordArg) {
  console.error("Usage: bun scripts/prototype-segment-detect.ts <gameId> <ordinal>");
  process.exit(1);
}
const outline = getTrackOutlineByOrdinal(parseInt(ordArg, 10), gameIdArg as GameId);
if (!outline) {
  console.error(`No outline for ${gameIdArg}:${ordArg}`);
  process.exit(1);
}
const totalKm = (cumulativeDistance(outline).at(-1)! / 1000).toFixed(2);
console.log(`Track: ${gameIdArg}:${ordArg}  ${outline.length} pts, ${totalKm} km`);
console.log("");

const cur = v1(outline).segments.map((s): Seg => ({ type: s.type, startMeter: s.distStart, endMeter: s.distEnd, direction: s.direction }));
const prop = v2(outline).segments.map((s): Seg => ({ type: s.type, startMeter: s.distStart, endMeter: s.distEnd, direction: s.direction }));
console.log(`Current  → ${JSON.stringify(counts(cur))}`);
console.log(`Proposed → ${JSON.stringify(counts(prop))}`);
console.log("");

const showAll = process.argv.includes("--list");
if (showAll) {
  console.log("\n=== CURRENT ===");
  cur.forEach((s, i) => console.log(`${(i + 1).toString().padStart(3)}: ${fmt(s)}`));
  console.log("\n=== PROPOSED ===");
  prop.forEach((s, i) => console.log(`${(i + 1).toString().padStart(3)}: ${fmt(s)}`));
}

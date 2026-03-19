import { getTrackOutlineByOrdinal } from "./shared/track-outlines/index";

const outline = getTrackOutlineByOrdinal(530);
if (!outline || outline.length < 20) { console.log("No outline for Spa"); process.exit(1); }

const n = outline.length;
console.log(`Outline points: ${n}`);

const dists = [0];
for (let i = 1; i < n; i++) {
  const dx = outline[i].x - outline[i - 1].x;
  const dz = outline[i].z - outline[i - 1].z;
  dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
}
const totalDist = dists[n - 1];
console.log(`Total distance: ${totalDist.toFixed(0)}m`);

const window = Math.max(3, Math.floor(n / 80));
const signedCurvature: number[] = [];
const curvature: number[] = [];
for (let i = 0; i < n; i++) {
  const prev = (i - window + n) % n;
  const next = (i + window) % n;
  const dx1 = outline[i].x - outline[prev].x;
  const dz1 = outline[i].z - outline[prev].z;
  const dx2 = outline[next].x - outline[i].x;
  const dz2 = outline[next].z - outline[i].z;
  const angle1 = Math.atan2(dz1, dx1);
  const angle2 = Math.atan2(dz2, dx2);
  let diff = angle2 - angle1;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  signedCurvature.push(diff);
  curvature.push(Math.abs(diff));
}

const smoothWindow = Math.max(2, Math.floor(n / 60));
const smoothed: number[] = [];
for (let i = 0; i < n; i++) {
  let sum = 0;
  for (let j = -smoothWindow; j <= smoothWindow; j++) {
    sum += curvature[(i + j + n) % n];
  }
  smoothed.push(sum / (smoothWindow * 2 + 1));
}

type Seg = { type: "corner" | "straight"; startIdx: number; endIdx: number; startFrac: number; endFrac: number };

function printSegments(label: string, segs: Seg[]) {
  console.log(`\n--- ${label} ---`);
  let cn = 1, sn = 1;
  for (const seg of segs) {
    let name: string;
    if (seg.type === "corner") {
      let sumCurv = 0;
      for (let i = seg.startIdx; i <= Math.min(seg.endIdx, n - 1); i++) sumCurv += signedCurvature[i];
      name = `T${cn++} ${sumCurv > 0 ? "R" : "L"}`;
    } else {
      name = `S${sn++}`;
    }
    const distStart = dists[seg.startIdx];
    const distEnd = seg.endIdx < n ? dists[seg.endIdx] : totalDist;
    const len = distEnd - distStart;
    const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
    console.log(`${name.padEnd(6)} ${seg.type.padEnd(8)} ${pct.padStart(5)}%  ${distStart.toFixed(0).padStart(5)}m - ${distEnd.toFixed(0).padStart(5)}m  (${len.toFixed(0)}m)`);
  }
  console.log(`Total: ${segs.length} segments (${segs.filter(s => s.type === "corner").length} corners, ${segs.filter(s => s.type === "straight").length} straights)`);
}

// === OLD algorithm (median threshold) ===
const sorted = [...smoothed].sort((a, b) => a - b);
const oldThreshold = sorted[Math.floor(n * 0.5)];
const oldSegments: Seg[] = [];
let oldType: "corner" | "straight" = smoothed[0] > oldThreshold ? "corner" : "straight";
let oldStart = 0;
for (let i = 1; i < n; i++) {
  const type = smoothed[i] > oldThreshold ? "corner" : "straight";
  if (type !== oldType) {
    oldSegments.push({ type: oldType, startFrac: oldStart / n, endFrac: i / n, startIdx: oldStart, endIdx: i });
    oldType = type;
    oldStart = i;
  }
}
oldSegments.push({ type: oldType, startFrac: oldStart / n, endFrac: 1, startIdx: oldStart, endIdx: n - 1 });
const oldMerged: Seg[] = [];
for (const seg of oldSegments) {
  if ((seg.endFrac - seg.startFrac) < 0.02 && oldMerged.length > 0) {
    oldMerged[oldMerged.length - 1].endFrac = seg.endFrac;
    oldMerged[oldMerged.length - 1].endIdx = seg.endIdx;
  } else {
    oldMerged.push({ ...seg });
  }
}
printSegments("OLD (median threshold)", oldMerged);

// === NEW algorithm ===
// Try multiple thresholds to find the sweet spot
for (const pctile of [0.50, 0.52, 0.54]) {
  const newThreshold = sorted[Math.floor(n * pctile)];

  const newSegments: Seg[] = [];
  let curType: "corner" | "straight" = smoothed[0] > newThreshold ? "corner" : "straight";
  let segStart2 = 0;
  for (let i = 1; i < n; i++) {
    const type = smoothed[i] > newThreshold ? "corner" : "straight";
    if (type !== curType) {
      newSegments.push({ type: curType, startFrac: segStart2 / n, endFrac: i / n, startIdx: segStart2, endIdx: i });
      curType = type;
      segStart2 = i;
    }
  }
  newSegments.push({ type: curType, startFrac: segStart2 / n, endFrac: 1, startIdx: segStart2, endIdx: n - 1 });

  // Only merge truly tiny segments < 1.5% into neighbor
  const pass1: Seg[] = [];
  for (const seg of newSegments) {
    if ((seg.endFrac - seg.startFrac) < 0.015 && pass1.length > 0) {
      pass1[pass1.length - 1].endFrac = seg.endFrac;
      pass1[pass1.length - 1].endIdx = seg.endIdx;
    } else {
      pass1.push({ ...seg });
    }
  }

  // Consolidate adjacent same-type
  const merged: Seg[] = [];
  for (const seg of pass1) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].endFrac = seg.endFrac;
      merged[merged.length - 1].endIdx = seg.endIdx;
    } else {
      merged.push({ ...seg });
    }
  }

  printSegments(`${(pctile*100).toFixed(0)}th pctile, 1.5% merge`, merged);
}

// Spa reference for comparison:
console.log(`
--- SPA REAL CORNERS (approximate) ---
La Source (T1)     ~0-800m      hairpin R
Eau Rouge (T2)     ~1000-1100m  fast S-curve L+R
Raidillon          (part of Eau Rouge climb)
Kemmel Straight    ~1100-1800m
Les Combes (T3)    ~1800-2100m  chicane L-R
Malmedy (T4)       ~2200-2400m  left
Rivage (T5)        ~2500-2700m  hairpin R
Long straight      ~2700-3000m
Pouhon (T6)        ~3000-3200m  double apex L
Fagnes (T7)        ~3400-3600m  chicane
Stavelot (T8)      ~3700-3900m  right
Blanchimont (T9)   ~4100-4400m  fast left
Bus Stop (T10)     ~5400-5700m  chicane R-L
`);

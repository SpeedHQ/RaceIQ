/**
 * Extract F1 25 track geometry from game AI spline data for ALL tracks.
 *
 * Reads each track's wep/{track}_common.erp, finds the .aispline resource,
 * parses the BXML gate data, and outputs centerline CSV + boundaries JSON.
 *
 * Usage: bun run scripts/extract-f1-tracks.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import * as fzstd from "fzstd";

const ERP_MAGIC = 0x4b505245;
const OUT_DIR = resolve(__dirname, "../shared/tracks/f1-2025");

/** Detect F1 25 install by reading Steam's libraryfolders.vdf */
function findF1Install(): string | null {
  const vdfPath = "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";
  if (!existsSync(vdfPath)) return null;
  const content = readFileSync(vdfPath, "utf8");
  const pathRegex = /"path"\s+"([^"]+)"/g;
  let match;
  while ((match = pathRegex.exec(content)) !== null) {
    const libPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
    const f1Path = `${libPath}/steamapps/common/F1 25`;
    if (existsSync(f1Path)) return f1Path;
  }
  return null;
}

const F1_DIR = findF1Install();
if (!F1_DIR) {
  console.error("F1 25 not found. Make sure it's installed via Steam.");
  process.exit(1);
}
const TRACKS_DIR = join(F1_DIR, "2025_asset_groups", "environment_package", "tracks");

// Track directory name → F1 track ID (matches shared/f1-tracks.csv)
const TRACK_DIR_TO_ID: Record<string, number> = {
  melbourne: 0, shanghai: 2, bahrain: 3, catalunya: 4, monaco: 5,
  montreal: 6, silverstone: 7, hungaroring: 9, spa_francorchamps: 10,
  monza: 11, singapore: 12, suzuka: 13, abu_dhabi: 14, texas: 15,
  brazil: 16, austria: 17, mexico: 19, baku: 20,
  zandvoort: 26, imola: 27, jeddah: 29, miami: 30, las_vegas: 31, losail: 32,
};

// Track ID → shared file name (from tracks.csv)
const trackIdToName = new Map<number, string>();
try {
  const csv = readFileSync(resolve(__dirname, "../shared/games/f1-2025/tracks.csv"), "utf-8");
  for (const line of csv.trim().split("\n")) {
    const parts = line.split(",");
    const id = parseInt(parts[0], 10);
    const sharedName = parts[6]?.trim();
    if (!isNaN(id) && sharedName) trackIdToName.set(id, sharedName);
  }
} catch {}

function trackFileName(trackId: number): string {
  return trackIdToName.get(trackId) ?? `${trackId}`;
}

// ── ERP reader ──────────────────────────────────────────────────────

interface ErpFragment {
  offset: bigint; size: bigint; packedSize: bigint; compression: number;
}

function readErpAndExtract(erpPath: string, resourcePattern: string): Buffer[] {
  const buffer = Buffer.from(readFileSync(erpPath));
  let pos = 0;
  const readUint32 = () => { const v = buffer.readUInt32LE(pos); pos += 4; return v; };
  const readInt32 = () => { const v = buffer.readInt32LE(pos); pos += 4; return v; };
  const readUint16 = () => { const v = buffer.readUInt16LE(pos); pos += 2; return v; };
  const readByte = () => buffer[pos++];
  const readUint64 = () => { const v = buffer.readBigUInt64LE(pos); pos += 8; return v; };
  const skip = (n: number) => { pos += n; };
  const readStr = (n: number) => {
    const bytes = buffer.subarray(pos, pos + n); pos += n;
    let end = bytes.indexOf(0); if (end === -1) end = n;
    return bytes.subarray(0, end).toString("utf-8");
  };

  const magic = readUint32();
  if (magic !== ERP_MAGIC) throw new Error("Not an ERP file");
  const version = readInt32();
  skip(24);
  const resourceOffset = readUint64();
  skip(8);
  const numFiles = readInt32();
  readInt32();

  const results: Buffer[] = [];

  for (let i = 0; i < numFiles; i++) {
    readUint32();
    const idLen = readUint16();
    const id = readStr(idLen);
    readStr(16);
    readInt32();
    if (version >= 4) readUint16();
    const fragCount = readByte();

    const frags: ErpFragment[] = [];
    for (let j = 0; j < fragCount; j++) {
      readStr(4);
      const offset = readUint64();
      const size = readUint64();
      readInt32();
      let compression = 0, packedSize = 0n;
      if (version > 2) { compression = readByte(); packedSize = readUint64(); }
      frags.push({ offset, size, packedSize, compression });
    }
    if (version > 2) skip(16);

    if (id.toLowerCase().includes(resourcePattern.toLowerCase())) {
      for (const frag of frags) {
        const dataOff = Number(resourceOffset) + Number(frag.offset);
        const dataLen = Number(frag.packedSize || frag.size);
        const raw = buffer.subarray(dataOff, dataOff + dataLen);
        if (frag.compression === 0x11 || frag.compression === 0x10 || frag.compression === 0x03) {
          results.push(Buffer.from(fzstd.decompress(new Uint8Array(raw))));
        } else {
          results.push(Buffer.from(raw));
        }
      }
    }
  }
  return results;
}

// ── BXML parser ─────────────────────────────────────────────────────

interface Gate {
  id: number; name: string;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  waypoints: Array<{ type: string; length: number }>;
}

function parseBXML(data: Buffer): Gate[] {
  const gates: Gate[] = [];
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      if (i > start) {
        const s = data.subarray(start, i).toString("utf-8");
        if (s.length > 0 && s.charCodeAt(0) >= 0x20) parts.push(s);
      }
      start = i + 1;
    } else if (data[i] < 0x20 && data[i] !== 0x09 && data[i] !== 0x0a && data[i] !== 0x0d) {
      if (i > start) {
        const s = data.subarray(start, i).toString("utf-8");
        if (s.length > 0 && s.charCodeAt(0) >= 0x20) parts.push(s);
      }
      start = i + 1;
    }
  }

  let i = 0;
  let currentGate: Partial<Gate> | null = null;
  let inWaypoints = false;

  while (i < parts.length) {
    const p = parts[i];

    if (p === "gate" && i + 1 < parts.length && parts[i + 1] === "id") {
      if (currentGate?.x !== undefined) gates.push(currentGate as Gate);
      currentGate = { id: parseInt(parts[i + 2]), name: "", x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, waypoints: [] };
      if (parts[i + 3] === "name") { currentGate.name = parts[i + 4]; i += 5; }
      else i += 3;
      inWaypoints = false;
      continue;
    }

    if (p === "position" && currentGate && !inWaypoints && parts[i + 1] === "x") {
      currentGate.x = parseFloat(parts[i + 2]);
      currentGate.y = parseFloat(parts[i + 4]);
      currentGate.z = parseFloat(parts[i + 6]);
      i += 7; continue;
    }

    if (p === "normal" && currentGate && !inWaypoints && parts[i + 1] === "x") {
      currentGate.nx = parseFloat(parts[i + 2]);
      currentGate.ny = parseFloat(parts[i + 4]);
      currentGate.nz = parseFloat(parts[i + 6]);
      i += 7; continue;
    }

    if (p === "waypoints" && currentGate) { inWaypoints = true; i++; continue; }

    if (p === "waypoint" && inWaypoints && currentGate && parts[i + 1] === "id") {
      let j = i + 3;
      let wpType = "", wpLength = 0;
      if (parts[j] === "type") { wpType = parts[j + 1]; j += 2; }
      if (parts[j] === "length") { wpLength = parseFloat(parts[j + 1]); j += 2; }
      currentGate.waypoints!.push({ type: wpType, length: wpLength });
      i = j; continue;
    }

    i++;
  }
  if (currentGate?.x !== undefined) gates.push(currentGate as Gate);
  return gates;
}

// ── TrackSpaceSpline parser (actual track centerline) ───────────────

interface TrackSpacePoint { x: number; y: number; z: number }

function parseTrackSpaceSpline(data: Buffer): { maintrack: TrackSpacePoint[]; pit: TrackSpacePoint[] } {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0 || (data[i] < 0x20 && data[i] !== 0x09 && data[i] !== 0x0a && data[i] !== 0x0d)) {
      if (i > start) {
        const s = data.subarray(start, i).toString("utf-8");
        if (s.length > 0 && s.charCodeAt(0) >= 0x20) parts.push(s);
      }
      start = i + 1;
    }
  }

  const splines: Record<string, TrackSpacePoint[]> = {};
  let currentSpline: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "name" && i + 1 < parts.length) {
      currentSpline = parts[i + 1];
      if (!splines[currentSpline]) splines[currentSpline] = [];
      i++;
    } else if (parts[i] === "position" && currentSpline) {
      const next = parts[i + 1];
      if (next?.includes(",")) {
        const [x, y, z] = next.split(",").map((s) => parseFloat(s.trim()));
        if (!isNaN(x) && !isNaN(z)) splines[currentSpline].push({ x, y, z });
        i++;
      }
    }
  }

  return {
    maintrack: splines["maintrack"] ?? [],
    pit: splines["pit_1"] ?? [],
  };
}

// ── Procrustes alignment ────────────────────────────────────────────

interface Point { x: number; z: number }
interface Transform { scale: number; rotation: number; tx: number; tz: number }

function centroid(points: Point[]): Point {
  let sx = 0, sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  return { x: sx / points.length, z: sz / points.length };
}

function downsample(points: Point[], target: number): Point[] {
  if (points.length <= target) return points;
  const step = points.length / target;
  return Array.from({ length: target }, (_, i) => points[Math.floor(i * step)]);
}

function procrustes(source: Point[], target: Point[]): Transform {
  const n = source.length;
  const cSrc = centroid(source);
  const cTgt = centroid(target);
  const srcC = source.map((p) => ({ x: p.x - cSrc.x, z: p.z - cSrc.z }));
  const tgtC = target.map((p) => ({ x: p.x - cTgt.x, z: p.z - cTgt.z }));
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += srcC[i].x * tgtC[i].z - srcC[i].z * tgtC[i].x;
    den += srcC[i].x * tgtC[i].x + srcC[i].z * tgtC[i].z;
  }
  const rotation = Math.atan2(num, den);
  let srcNorm = 0, tgtNorm = 0;
  for (let i = 0; i < n; i++) {
    srcNorm += srcC[i].x ** 2 + srcC[i].z ** 2;
    tgtNorm += tgtC[i].x ** 2 + tgtC[i].z ** 2;
  }
  const scale = srcNorm > 0 ? Math.sqrt(tgtNorm / srcNorm) : 1;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return {
    scale, rotation,
    tx: cTgt.x - scale * (cos * cSrc.x - sin * cSrc.z),
    tz: cTgt.z - scale * (sin * cSrc.x + cos * cSrc.z),
  };
}

function applyTransform(p: Point, t: Transform): Point {
  const cos = Math.cos(t.rotation), sin = Math.sin(t.rotation);
  return {
    x: t.scale * (cos * p.x - sin * p.z) + t.tx,
    z: t.scale * (sin * p.x + cos * p.z) + t.tz,
  };
}

// Load telemetry-recorded outline for alignment (if available).
// Filters out large jumps (formation lap / running start artifacts).
const TEL_DIR = resolve(__dirname, "../shared/track-outlines/f1-2025");
function loadTelemetryOutline(trackId: number): Point[] | null {
  const filePath = join(TEL_DIR, `recorded-${trackId}.csv`);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean).slice(1);
  const pts = lines.map((l) => { const [x, z] = l.split(",").map(Number); return { x, z }; });
  if (pts.length <= 20) return null;

  // Remove duplicate consecutive points
  const deduped: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x !== pts[i - 1].x || pts[i].z !== pts[i - 1].z) deduped.push(pts[i]);
  }

  // Compute median inter-point distance to detect outlier jumps
  const dists: number[] = [];
  for (let i = 1; i < deduped.length; i++) {
    dists.push(Math.sqrt((deduped[i].x - deduped[i - 1].x) ** 2 + (deduped[i].z - deduped[i - 1].z) ** 2));
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length / 2)];
  const jumpThreshold = Math.max(median * 10, 100);

  // Keep longest contiguous segment without jumps
  let bestStart = 0, bestLen = 1, curStart = 0, curLen = 1;
  for (let i = 1; i < deduped.length; i++) {
    const d = Math.sqrt((deduped[i].x - deduped[i - 1].x) ** 2 + (deduped[i].z - deduped[i - 1].z) ** 2);
    if (d > jumpThreshold) {
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
      curStart = i; curLen = 1;
    } else {
      curLen++;
    }
  }
  if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
  const cleaned = deduped.slice(bestStart, bestStart + bestLen);
  return cleaned.length > 20 ? cleaned : null;
}

// Load TUMFTM real-world centerline for alignment (preferred over telemetry).
// These are high-quality, satellite-derived outlines with 1000+ points.
const SHARED_DIR = resolve(__dirname, "../shared/track-outlines/shared");

// F1 track ID → common track name (from tracks.csv commonTrackName column)
const F1_TO_SHARED: Record<number, string> = {};
{
  const csvPath = resolve(__dirname, "../shared/games/f1-2025/tracks.csv");
  if (existsSync(csvPath)) {
    for (const line of readFileSync(csvPath, "utf-8").split("\n").filter(Boolean)) {
      const parts = line.split(",");
      const id = parseInt(parts[0]);
      const shared = parts[6]?.trim();
      if (!isNaN(id) && shared) F1_TO_SHARED[id] = shared;
    }
  }
}

function loadSharedCenterline(trackId: number): Point[] | null {
  const name = F1_TO_SHARED[trackId];
  if (!name) return null;
  const filePath = join(SHARED_DIR, `${name}.csv`);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean).slice(1);
  const pts = lines.map((l) => { const [x, z] = l.split(",").map(Number); return { x, z }; });
  if (pts.length <= 20) return null;
  // TUMFTM outlines trace opposite to racing direction — reverse them
  return [pts[0], ...pts.slice(1).reverse()];
}

// ── Main ────────────────────────────────────────────────────────────

// Clean output directory so re-runs produce identical results
if (existsSync(OUT_DIR)) {
  for (const f of readdirSync(OUT_DIR)) {
    const fp = join(OUT_DIR, f);
    try { if (statSync(fp).isFile()) require("fs").unlinkSync(fp); } catch {}
  }
}
mkdirSync(OUT_DIR, { recursive: true });

const trackDirs = readdirSync(TRACKS_DIR).filter((d) => {
  try { return statSync(join(TRACKS_DIR, d)).isDirectory(); } catch { return false; }
});

console.log(`F1 25 track extraction — ${trackDirs.length} directories found\n`);

let extracted = 0;

for (const trackDir of trackDirs) {
  const trackId = TRACK_DIR_TO_ID[trackDir];
  if (trackId === undefined) {
    console.log(`  [skip] ${trackDir} — no track ID mapping`);
    continue;
  }

  const wepErp = join(TRACKS_DIR, trackDir, "wep", `${trackDir}_common.erp`);
  if (!existsSync(wepErp)) {
    console.log(`  [skip] ${trackDir} — no wep ERP`);
    continue;
  }

  process.stdout.write(`  ${trackDir} (id ${trackId})... `);

  try {
    // Extract AI spline (for track edges) and trackspacespline (for actual centerline)
    const aisplineFrags = readErpAndExtract(wepErp, "aispline");
    const tssFrags = readErpAndExtract(wepErp, "trackspacespline");

    if (aisplineFrags.length === 0) { console.log("no aispline"); continue; }

    const allGates = parseBXML(aisplineFrags[0]);
    const pitGates = allGates.filter((g) => g.name.includes("pit"));
    const trackGates = allGates.filter((g) => !g.name.includes("pit"));

    if (trackGates.length < 10) { console.log(`only ${trackGates.length} gates`); continue; }

    // Parse trackspacespline for the actual track centerline (not AI racing path)
    let tssMain: TrackSpacePoint[] = [];
    let tssPit: TrackSpacePoint[] = [];
    // trackspacespline has 2 fragments: first is BXML data, skip quadtree
    const tssDataFrags = tssFrags.filter((_, i) => i === 0);
    if (tssDataFrags.length > 0) {
      const tss = parseTrackSpaceSpline(tssDataFrags[0]);
      tssMain = tss.maintrack;
      tssPit = tss.pit;
    }

    // Build AI gate boundary data (left/right edges, racing line)
    const gateLeft: Point[] = [];
    const gateRight: Point[] = [];
    const gateCenter: Point[] = [];
    const gateRacingLine: Point[] = [];
    const gateAltitude: number[] = [];

    for (const gate of trackGates) {
      gateCenter.push({ x: gate.x, z: gate.z });
      gateAltitude.push(gate.y);

      const getWp = (type: string) => gate.waypoints.find((w) => w.type === type)?.length ?? 0;

      gateLeft.push({
        x: gate.x + gate.nx * getWp("left_track_limit"),
        z: gate.z + gate.nz * getWp("left_track_limit"),
      });
      gateRight.push({
        x: gate.x + gate.nx * getWp("right_track_limit"),
        z: gate.z + gate.nz * getWp("right_track_limit"),
      });
      gateRacingLine.push({
        x: gate.x + gate.nx * getWp("racing_line"),
        z: gate.z + gate.nz * getWp("racing_line"),
      });
    }

    // Use trackspacespline as centerline if available, otherwise compute
    // from midpoint of left/right edges (geometric center, not AI path)
    let centerline: Point[];
    let leftEdge: Point[];
    let rightEdge: Point[];
    let racingLine: Point[];
    let altitude: number[];

    if (tssMain.length > 20) {
      // Use actual game track centerline from trackspacespline
      centerline = tssMain.map((p) => ({ x: p.x, z: p.z }));
      altitude = tssMain.map((p) => p.y);

      // Interpolate AI gate boundaries onto the denser trackspacespline points.
      // For each TSS point, find the nearest AI gate and use its left/right offset.
      leftEdge = [];
      rightEdge = [];
      racingLine = [];

      for (const tssP of tssMain) {
        // Find nearest gate
        let bestDist = Infinity, bestIdx = 0;
        for (let g = 0; g < trackGates.length; g++) {
          const d = (tssP.x - trackGates[g].x) ** 2 + (tssP.z - trackGates[g].z) ** 2;
          if (d < bestDist) { bestDist = d; bestIdx = g; }
        }

        // Find second-nearest adjacent gate for interpolation
        const g0 = bestIdx;
        const g1Prev = g0 > 0 ? g0 - 1 : trackGates.length - 1;
        const g1Next = g0 < trackGates.length - 1 ? g0 + 1 : 0;
        const dPrev = (tssP.x - trackGates[g1Prev].x) ** 2 + (tssP.z - trackGates[g1Prev].z) ** 2;
        const dNext = (tssP.x - trackGates[g1Next].x) ** 2 + (tssP.z - trackGates[g1Next].z) ** 2;
        const g1 = dPrev < dNext ? g1Prev : g1Next;

        // Interpolate between the two nearest gates
        const d0 = Math.sqrt((tssP.x - trackGates[g0].x) ** 2 + (tssP.z - trackGates[g0].z) ** 2);
        const d1 = Math.sqrt((tssP.x - trackGates[g1].x) ** 2 + (tssP.z - trackGates[g1].z) ** 2);
        const total = d0 + d1;
        const t = total > 0 ? d0 / total : 0;

        const lerp = (a: number, b: number) => a * (1 - t) + b * t;
        leftEdge.push({ x: lerp(gateLeft[g0].x, gateLeft[g1].x), z: lerp(gateLeft[g0].z, gateLeft[g1].z) });
        rightEdge.push({ x: lerp(gateRight[g0].x, gateRight[g1].x), z: lerp(gateRight[g0].z, gateRight[g1].z) });
        racingLine.push({ x: lerp(gateRacingLine[g0].x, gateRacingLine[g1].x), z: lerp(gateRacingLine[g0].z, gateRacingLine[g1].z) });
      }

      process.stdout.write(`tss=${tssMain.length} `);
    } else {
      // Fallback: use geometric midpoint of left/right edges as centerline
      centerline = gateLeft.map((l, i) => ({ x: (l.x + gateRight[i].x) / 2, z: (l.z + gateRight[i].z) / 2 }));
      leftEdge = [...gateLeft];
      rightEdge = [...gateRight];
      racingLine = [...gateRacingLine];
      altitude = [...gateAltitude];
    }

    let pitLane: Point[] | null =
      tssPit.length > 5 ? tssPit.map((p) => ({ x: p.x, z: p.z })) :
      pitGates.length > 5 ? pitGates.map((g) => ({ x: g.x, z: g.z })) : null;

    // Align extracted geometry to telemetry coordinate space.
    // Telemetry recordings are the ground truth — the car dot on the track map
    // uses telemetry coords, so boundaries must be in the same space.
    // If no telemetry exists, leave unaligned — runtime loadExtractedBoundary()
    // will align on-the-fly when a recording becomes available.
    const telOutline = loadTelemetryOutline(trackId);
    const alignTarget = telOutline;
    const alignSource = "tel";
    let aligned = false;
    if (alignTarget) {
      const N = 200;
      const src = downsample(centerline, N);
      const tgt = downsample(alignTarget, N);

      function cumDist(pts: Point[]): number[] {
        const d = [0];
        for (let i = 1; i < pts.length; i++) {
          d.push(d[i - 1] + Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
        }
        return d;
      }
      function sampleAtFracs(pts: Point[], fracs: number[]): Point[] {
        const cd = cumDist(pts);
        const total = cd[cd.length - 1];
        return fracs.map(f => {
          const target = f * total;
          let lo = 0;
          for (let i = 1; i < cd.length; i++) { if (cd[i] >= target) { lo = i - 1; break; } }
          const seg = cd[lo + 1] - cd[lo];
          const t = seg > 0 ? (target - cd[lo]) / seg : 0;
          return { x: pts[lo].x + t * (pts[lo + 1].x - pts[lo].x), z: pts[lo].z + t * (pts[lo + 1].z - pts[lo].z) };
        });
      }

      // Measure closest-point error between two point sets
      function closestPointError(a: Point[], b: Point[]): number {
        let totalErr = 0;
        for (const p of a) {
          let bestD = Infinity;
          for (const q of b) {
            const d = (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
            if (d < bestD) bestD = d;
          }
          totalErr += bestD;
        }
        return Math.sqrt(totalErr / a.length);
      }

      // First check: identity transform (data may already be aligned)
      const identityErr = closestPointError(src, tgt);
      let bestTransform: Transform = { scale: 1, rotation: 0, tx: 0, tz: 0 };
      let bestErr = identityErr;
      let bestFlip = "";

      // Sample both at same fractional distances, try many starting offsets
      const fracs = Array.from({ length: N }, (_, i) => i / N);
      const tgtSampled = sampleAtFracs(tgt, fracs);
      const step = Math.max(1, Math.floor(N / 50));

      // Try all combinations: forward/reversed × none/flipX/flipZ/flipBoth
      const flips: Array<{ name: string; fn: (p: Point) => Point }> = [
        { name: "", fn: (p) => p },
        { name: "flipX", fn: (p) => ({ x: -p.x, z: p.z }) },
        { name: "flipZ", fn: (p) => ({ x: p.x, z: -p.z }) },
        { name: "flipXZ", fn: (p) => ({ x: -p.x, z: -p.z }) },
      ];

      for (const flip of flips) {
        const srcFlipped = src.map(flip.fn);
        for (const srcPts of [srcFlipped, [...srcFlipped].reverse()]) {
          for (let offset = 0; offset < N; offset += step) {
            const shiftedFracs = fracs.map(f => (f + offset / N) % 1);
            const srcSampled = sampleAtFracs(srcPts, shiftedFracs);
            const t = procrustes(srcSampled, tgtSampled);
            const transformed = srcSampled.map(p => applyTransform(p, t));
            let err = 0;
            for (let i = 0; i < N; i++) err += (transformed[i].x - tgtSampled[i].x) ** 2 + (transformed[i].z - tgtSampled[i].z) ** 2;
            err = Math.sqrt(err / N);
            if (err < bestErr) { bestErr = err; bestTransform = t; bestFlip = flip.name; }
          }
        }
      }

      // Apply the best flip + transform combination
      const flipFn = flips.find(f => f.name === bestFlip)!.fn;
      const finalPts = src.map(p => applyTransform(flipFn(p), bestTransform));
      const avgErr = closestPointError(finalPts, tgt);

      if (avgErr > 35) {
        process.stdout.write(`[alignment too poor, skipping] `);
      } else {
        const apply = (p: Point) => applyTransform(flipFn(p), bestTransform);
        for (let i = 0; i < centerline.length; i++) centerline[i] = apply(centerline[i]);
        for (let i = 0; i < leftEdge.length; i++) leftEdge[i] = apply(leftEdge[i]);
        for (let i = 0; i < rightEdge.length; i++) rightEdge[i] = apply(rightEdge[i]);
        for (let i = 0; i < racingLine.length; i++) racingLine[i] = apply(racingLine[i]);
        if (pitLane) pitLane = pitLane.map(apply);
        // When X is flipped, left/right edges swap
        if (bestFlip === "flipX" || bestFlip === "flipXZ") {
          const tmp = [...leftEdge];
          leftEdge.length = 0; leftEdge.push(...rightEdge);
          rightEdge.length = 0; rightEdge.push(...tmp);
        }
        aligned = true;
      }
      const flipStr = bestFlip ? ` ${bestFlip}` : "";
      process.stdout.write(`[${alignSource}] s=${bestTransform.scale.toFixed(3)} r=${(bestTransform.rotation*180/Math.PI).toFixed(1)}°${flipStr} err=${avgErr.toFixed(1)}m `);
    }

    // Trim alternate layout variants: find first jump > 100m that lands
    // within 20m of an earlier point (indicates appended chicane variant)
    let cutIdx = centerline.length;
    for (let i = 1; i < centerline.length; i++) {
      const dx = centerline[i].x - centerline[i - 1].x;
      const dz = centerline[i].z - centerline[i - 1].z;
      if (Math.sqrt(dx * dx + dz * dz) > 100) {
        for (let j = 0; j < i - 5; j++) {
          const dx2 = centerline[i].x - centerline[j].x;
          const dz2 = centerline[i].z - centerline[j].z;
          if (Math.sqrt(dx2 * dx2 + dz2 * dz2) < 20) { cutIdx = i; break; }
        }
        if (cutIdx < centerline.length) break;
      }
    }
    if (cutIdx < centerline.length) {
      centerline.length = cutIdx;
      leftEdge.length = cutIdx;
      rightEdge.length = cutIdx;
      racingLine.length = cutIdx;
      altitude.length = cutIdx;
      if (pitLane && pitLane.length > cutIdx) pitLane.length = cutIdx;
      process.stdout.write(`[trimmed ${cutIdx}] `);
    }

    // Negate X to match F1 telemetry coordinate space.
    // The F1 parser does PositionX: -m.posX, so telemetry X = -game X.
    // The renderer (TrackViewer) expects telemetry coordinates and applies
    // maxX-x inversion for display — so data must be in telemetry space.
    const negX = (p: Point) => ({ x: -p.x, z: p.z });
    for (let i = 0; i < centerline.length; i++) centerline[i] = negX(centerline[i]);
    for (let i = 0; i < leftEdge.length; i++) leftEdge[i] = negX(leftEdge[i]);
    for (let i = 0; i < rightEdge.length; i++) rightEdge[i] = negX(rightEdge[i]);
    for (let i = 0; i < racingLine.length; i++) racingLine[i] = negX(racingLine[i]);
    if (pitLane) pitLane = pitLane.map(negX);
    // Negating X swaps left/right edges
    const tmpEdge = [...leftEdge];
    leftEdge = [...rightEdge];
    rightEdge = tmpEdge;

    const name = trackFileName(trackId);

    writeFileSync(join(OUT_DIR, `${name}-centerline.csv`),
      ["x,z", ...centerline.map((p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`)].join("\n"));

    writeFileSync(join(OUT_DIR, `${name}-boundaries.json`), JSON.stringify({
      waypoints: trackGates.length,
      leftEdge, rightEdge, altitude, pitLane,
    }, null, 2));

    console.log(`${trackGates.length} gates, ${pitGates.length} pit${aligned ? " [aligned]" : ""} → ${name}`);
    extracted++;
  } catch (err) {
    console.log(`error: ${(err as Error).message}`);
  }
}

console.log(`\nExtracted ${extracted} tracks to ${OUT_DIR}`);

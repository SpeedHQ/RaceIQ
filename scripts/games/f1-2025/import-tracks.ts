/**
 * Import F1 track outlines from TUMFTM/racetrack-database.
 * Downloads centerline + widths, normalizes orientation, computes edges,
 * saves shared source geometry at each canonical root venue.
 *
 * Run: bun run scripts/games/f1-2025/import-tracks.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bundledSharedGeometryPath, findTrackAssetIdentities } from "../../../shared/racing/tracks/storage/assets";

const BASE = "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks";

// Map from our track file names to TUMFTM file names
const TRACKS: Record<string, string> = {
  "melbourne": "Melbourne",
  "shanghai": "Shanghai",
  "sakhir": "Sakhir",
  "catalunya": "Catalunya",
  "montreal": "Montreal",
  "silverstone": "Silverstone",
  "budapest": "Budapest",
  "spa": "Spa",
  "monza": "Monza",
  "suzuka": "Suzuka",
  "yas-marina": "YasMarina",
  "austin": "Austin",
  "interlagos": "SaoPaulo",
  "spielberg": "Spielberg",
  "zandvoort": "Zandvoort",
  "nurburgring": "Nuerburgring",
  "mexico-city": "MexicoCity",
  "sochi": "Sochi",
  "sepang": "Sepang",
  "brands-hatch": "BrandsHatch",
  "indianapolis": "IMS",
  "hockenheim": "Hockenheim",
};

interface Point { x: number; z: number; }
interface CenterPoint extends Point { wRight: number; wLeft: number; }

// ── Normalization ─────────────────────────────────────────────────────────

/** Center points at origin. */
function center(pts: Point[]): Point[] {
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p.x; cz += p.z; }
  cx /= pts.length; cz /= pts.length;
  return pts.map(p => ({ x: p.x - cx, z: p.z - cz }));
}

/** Rotate all points by angle (radians). */
function rotate(pts: Point[], angle: number): Point[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map(p => ({
    x: p.x * cos - p.z * sin,
    z: p.x * sin + p.z * cos,
  }));
}

/** Find the start/finish direction — first segment heading. */
function startHeading(pts: Point[]): number {
  // Average direction over first ~2% of points for stability
  const n = Math.max(2, Math.floor(pts.length * 0.02));
  let dx = 0, dz = 0;
  for (let i = 0; i < n; i++) {
    const next = pts[(i + 1) % pts.length];
    dx += next.x - pts[i].x;
    dz += next.z - pts[i].z;
  }
  return Math.atan2(dz, dx);
}

/** Check if winding is clockwise (negative signed area = CW in screen coords). */
function isClockwise(pts: Point[]): boolean {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += (pts[j].x - pts[i].x) * (pts[j].z + pts[i].z);
  }
  return area > 0; // positive = CW in x-right z-down
}

/** Reverse point order to flip winding direction. */
function reverseWinding(pts: Point[]): Point[] {
  return [pts[0], ...pts.slice(1).reverse()];
}

/**
 * Normalize an outline:
 * 1. Center at origin
 * 2. Rotate so start/finish heads rightward (+X)
 * 3. Ensure clockwise winding
 */
function _normalize(pts: Point[]): Point[] {
  let result = center(pts);

  // Rotate so start/finish heads right (+X direction, angle = 0)
  const heading = startHeading(result);
  result = rotate(result, -heading);

  // Ensure clockwise winding
  if (!isClockwise(result)) {
    result = reverseWinding(result);
  }

  return result;
}

/** Apply same normalization to centerline with widths. */
function normalizeCenterline(pts: CenterPoint[]): CenterPoint[] {
  // TUMFTM data traces circuits in the opposite direction to racing direction.
  // Reverse point order so index 0 is start/finish heading in the racing direction.
  const data = [pts[0], ...pts.slice(1).reverse()];

  // Center
  let cx = 0, cz = 0;
  for (const p of data) { cx += p.x; cz += p.z; }
  cx /= data.length; cz /= data.length;
  const centered = data.map(p => ({ ...p, x: p.x - cx, z: p.z - cz }));

  // Rotate so start/finish heads right (+X)
  const heading = startHeading(centered);
  const cos = Math.cos(-heading);
  const sin = Math.sin(-heading);
  const rotated = centered.map(p => ({
    ...p,
    x: p.x * cos - p.z * sin,
    z: p.x * sin + p.z * cos,
  }));

  return rotated;
}

// ── Edge Computation ──────────────────────────────────────────────────────

function computeEdges(
  centerline: CenterPoint[]
): { left: Point[]; right: Point[]; center: Point[] } {
  const n = centerline.length;
  const left: Point[] = [];
  const right: Point[] = [];
  const ctr: Point[] = [];

  for (let i = 0; i < n; i++) {
    const p = centerline[i];
    const prev = centerline[(i - 1 + n) % n];
    const next = centerline[(i + 1) % n];

    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len === 0) continue;

    // Normal (perpendicular, pointing left)
    const nx = -dz / len;
    const nz = dx / len;

    ctr.push({ x: p.x, z: p.z });
    left.push({ x: p.x + nx * p.wLeft, z: p.z + nz * p.wLeft });
    right.push({ x: p.x - nx * p.wRight, z: p.z - nz * p.wRight });
  }

  return { left, right, center: ctr };
}

function pointsToCsv(points: Point[]): string {
  return `x,z\n${points.map(p => `${p.x.toFixed(4)},${p.z.toFixed(4)}`).join("\n")}`;
}

// ── Import ────────────────────────────────────────────────────────────────

async function importTrack(name: string, tumftmName: string): Promise<boolean> {
  const identity = findTrackAssetIdentities(name)[0];
  const centerlinePath = identity && bundledSharedGeometryPath(identity, "tumftm", name, "centerline");
  const boundariesPath = identity && bundledSharedGeometryPath(identity, "tumftm", name, "boundaries");
  if (!identity || !centerlinePath || !boundariesPath) {
    console.log(`[${name}] No canonical registry assignment, skipping`);
    return false;
  }
  mkdirSync(dirname(centerlinePath), { recursive: true });
  const url = `${BASE}/${tumftmName}.csv`;
  console.log(`[${name}] Fetching ${url}...`);

  const res = await fetch(url);
  if (!res.ok) {
    console.log(`[${name}] Not found (${res.status}), skipping`);
    return false;
  }

  const text = await res.text();
  const lines = text.split("\n").filter(l => l.trim() && !l.startsWith("#"));

  const raw: CenterPoint[] = [];
  for (const line of lines) {
    const [xStr, zStr, wrStr, wlStr] = line.split(",");
    const x = parseFloat(xStr);
    const z = parseFloat(zStr);
    const wRight = parseFloat(wrStr);
    const wLeft = parseFloat(wlStr);
    if (!Number.isNaN(x) && !Number.isNaN(z)) {
      raw.push({ x, z, wRight: wRight || 5, wLeft: wLeft || 5 });
    }
  }

  if (raw.length < 10) {
    console.log(`[${name}] Too few points (${raw.length}), skipping`);
    return false;
  }

  // Normalize: center, rotate start→right, ensure clockwise
  const centerline = normalizeCenterline(raw);

  // Save centerline
  const centerCsv = pointsToCsv(centerline.map(p => ({ x: p.x, z: p.z })));
  writeFileSync(centerlinePath, centerCsv);

  // Compute and save edges
  const { left, right, center: ctr } = computeEdges(centerline);
  const boundaryData = {
    leftEdge: left.map(p => ({ x: +p.x.toFixed(4), z: +p.z.toFixed(4) })),
    rightEdge: right.map(p => ({ x: +p.x.toFixed(4), z: +p.z.toFixed(4) })),
    centerLine: ctr.map(p => ({ x: +p.x.toFixed(4), z: +p.z.toFixed(4) })),
    pitLane: null,
    coordSystem: "normalized",
  };
  writeFileSync(boundariesPath, JSON.stringify(boundaryData));

  console.log(`[${name}] Saved: ${centerline.length} center pts, ${left.length} edge pts`);
  return true;
}

async function main() {
  let success = 0;
  let failed = 0;

  for (const [name, tumftmName] of Object.entries(TRACKS)) {
    const ok = await importTrack(name, tumftmName);
    if (ok) success++; else failed++;
  }

  console.log(`\nDone: ${success} tracks imported, ${failed} not available`);
}

main();

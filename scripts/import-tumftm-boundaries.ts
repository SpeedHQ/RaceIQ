/**
 * Import TUMFTM racetrack-database boundary data.
 *
 * Downloads CSVs with center-line + track widths, computes left/right edge
 * points by offsetting perpendicular to the tangent, and writes JSON boundary
 * files to shared/track-outlines/boundaries/.
 *
 * Usage: bun run scripts/import-tumftm-boundaries.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../shared/track-outlines/boundaries");

interface Point {
  x: number;
  z: number;
}

// Map our local CSV filenames → TUMFTM repo filenames
const TUMFTM_TRACKS: Record<string, string> = {
  "brands-hatch": "BrandsHatch",
  "catalunya": "Catalunya",
  "spa": "Spa",
  "hockenheim": "Hockenheim",
  "indianapolis": "IMS",
  "nurburgring": "Nuerburgring",
  "silverstone": "Silverstone",
  "suzuka": "Suzuka",
  "yas-marina": "YasMarina",
};

const BASE_URL =
  "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks";

interface RawRow {
  x: number;
  y: number;
  wRight: number;
  wLeft: number;
}

async function fetchTrackCSV(tumftmName: string): Promise<RawRow[]> {
  const url = `${BASE_URL}/${tumftmName}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();

  const lines = text.trim().split("\n");
  // Header: # x_m,y_m,w_tr_right_m,w_tr_left_m
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map(Number);
    if (parts.length < 4 || parts.some(isNaN)) continue;
    rows.push({ x: parts[0], y: parts[1], wRight: parts[2], wLeft: parts[3] });
  }
  return rows;
}

/**
 * Compute left/right edge points from center-line + widths.
 * At each point, compute the tangent from neighbors, then offset perpendicular.
 */
function computeEdges(rows: RawRow[]): { leftEdge: Point[]; rightEdge: Point[] } {
  const n = rows.length;
  const leftEdge: Point[] = [];
  const rightEdge: Point[] = [];

  for (let i = 0; i < n; i++) {
    // Tangent from neighbors (wrap around for closed circuit)
    const prev = rows[(i - 1 + n) % n];
    const next = rows[(i + 1) % n];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.sqrt(tx * tx + ty * ty);
    if (len === 0) {
      // Degenerate — just duplicate center point
      leftEdge.push({ x: rows[i].x, z: rows[i].y });
      rightEdge.push({ x: rows[i].x, z: rows[i].y });
      continue;
    }

    // Normal (perpendicular to tangent, rotated 90° CCW)
    const nx = -ty / len;
    const ny = tx / len;

    // Left edge: offset in +normal direction by left width
    leftEdge.push({
      x: rows[i].x + nx * rows[i].wLeft,
      z: rows[i].y + ny * rows[i].wLeft,
    });

    // Right edge: offset in -normal direction by right width
    rightEdge.push({
      x: rows[i].x - nx * rows[i].wRight,
      z: rows[i].y - ny * rows[i].wRight,
    });
  }

  return { leftEdge, rightEdge };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let success = 0;
  let failed = 0;

  for (const [localName, tumftmName] of Object.entries(TUMFTM_TRACKS)) {
    try {
      console.log(`Fetching ${tumftmName}...`);
      const rows = await fetchTrackCSV(tumftmName);
      console.log(`  ${rows.length} center-line points`);

      const { leftEdge, rightEdge } = computeEdges(rows);

      const outPath = resolve(OUT_DIR, `${localName}.json`);
      const data = {
        leftEdge: leftEdge.map((p) => ({ x: round(p.x), z: round(p.z) })),
        rightEdge: rightEdge.map((p) => ({ x: round(p.x), z: round(p.z) })),
        pitLane: null,
      };
      writeFileSync(outPath, JSON.stringify(data));
      console.log(`  → ${outPath}`);
      success++;
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} succeeded, ${failed} failed`);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

main();

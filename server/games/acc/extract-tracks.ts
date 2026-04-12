/**
 * ACC track geometry extraction — importable module.
 *
 * Reads each track's fastlane.ai file from the ACC Cache directory,
 * parses the binary racing line and width data, and outputs centerline CSV
 * + boundaries JSON.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const _scriptDir = dirname(fileURLToPath(import.meta.url));

export interface ProgressEvent {
  type: "total" | "extracted" | "skipped";
  track: string;
  count: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

// ── Steam install detection ──────────────────────────────────────────

function findAccInstall(): string | null {
  // Try VDF
  const vdfPath = "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf";
  if (existsSync(vdfPath)) {
    const content = readFileSync(vdfPath, "utf8");
    const pathRegex = /"path"\s+"([^"]+)"/g;
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const libPath = match[1].replace(/\\\\/g, "/").replace(/\\/g, "/");
      const accPath = `${libPath}/steamapps/common/Assetto Corsa Competizione`;
      if (existsSync(accPath)) return accPath;
    }
  }

  // Hardcoded fallbacks
  const fallbacks = [
    "C:/Program Files (x86)/Steam/steamapps/common/Assetto Corsa Competizione",
    "E:/SteamLibrary/steamapps/common/Assetto Corsa Competizione",
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }

  return null;
}

// ── Track directory → ordinal mapping ───────────────────────────────

const ACC_DIR_TO_ORDINAL: Record<string, number> = {
  monza: 0,
  zolder: 1,
  brands_hatch: 2,
  silverstone: 3,
  paul_ricard: 4,
  misano: 5,
  spa: 6,
  nurburgring: 7,
  barcelona: 8,
  hungaroring: 9,
  zandvoort: 10,
  kyalami: 22,
  mount_panorama: 23,
  suzuka: 24,
  laguna_seca: 25,
  oulton_park: 26,
  donington: 27,
  snetterton: 28,
  imola: 29,
  watkins_glen: 30,
  cota: 31,
  indianapolis: 32,
  valencia: 33,
  red_bull_ring: 34,
  nurburgring_24h: 35,
};

// ── CSV track name lookup ────────────────────────────────────────────

function loadTrackNames(): Map<number, string> {
  const map = new Map<number, string>();
  const csvPath = resolve(_scriptDir, "../../../shared/games/acc/tracks.csv");
  try {
    const csv = readFileSync(csvPath, "utf-8");
    for (const line of csv.trim().split("\n")) {
      const parts = line.split(",");
      const id = parseInt(parts[0], 10);
      if (isNaN(id)) continue;
      const commonName = parts[3]?.trim();
      map.set(id, commonName || "");
    }
  } catch (e) {
    console.warn(`[ACC] Could not load tracks.csv: ${(e as Error).message}`);
  }
  return map;
}

function trackOutputName(dirName: string, ordinal: number, trackNames: Map<number, string>): string {
  const commonName = trackNames.get(ordinal);
  if (commonName) return commonName;
  // Fall back to directory name with underscores → hyphens
  return dirName.replace(/_/g, "-");
}

// ── fastlane.ai parser ───────────────────────────────────────────────

/**
 * fastlane.ai binary format (version 8):
 *
 * Header:
 *   Offset 0:  int32  version (= 8)
 *   Offset 4:  int32  nodeCount
 *   Offset 8:  8 bytes padding (zeros)
 *
 * Section 1 — Racing line centerline:
 *   Offset 16: nodeCount × 36-byte records
 *   Each record:
 *     +0  double x
 *     +8  double y
 *     +16 double z
 *     +24 double distFromStart
 *     +32 int32  nodeIndex
 *
 * Section 2 — Track widths:
 *   Starts at: 16 + nodeCount * 36
 *   +0:  int32  nodeCount (same count)
 *   +4:  16 bytes zeros
 *   +20: nodeCount × 80-byte records
 *   Each 80-byte record:
 *     +0  float32  (distance or metadata — not used)
 *     +4  float32  sideLeft  (half-width to left edge in meters)
 *     +8  float32  sideRight (half-width to right edge in meters)
 *     ... remaining bytes (other data we don't need)
 */

interface FastlaneNode {
  x: number;
  y: number;
  z: number;
  distFromStart: number;
  nodeIndex: number;
}

interface WidthRecord {
  sideLeft: number;
  sideRight: number;
}

interface FastlaneData {
  nodes: FastlaneNode[];
  widths: WidthRecord[];
}

function parseFastlane(buf: Buffer): FastlaneData {
  const version = buf.readInt32LE(0);
  if (version !== 8) {
    throw new Error(`Unsupported fastlane.ai version: ${version}`);
  }

  const nodeCount = buf.readInt32LE(4);
  // Offset 8: 8 bytes padding (zeros)
  // Offset 16: nodeCount × 36-byte node records
  const section1Start = 16;
  const NODE_RECORD_SIZE = 36;

  // Parse section 1 — racing line nodes (sequential, already in order)
  const nodes: FastlaneNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const base = section1Start + i * NODE_RECORD_SIZE;
    nodes.push({
      x: buf.readDoubleLE(base + 0),
      y: buf.readDoubleLE(base + 8),
      z: buf.readDoubleLE(base + 16),
      distFromStart: buf.readDoubleLE(base + 24),
      nodeIndex: buf.readInt32LE(base + 32),
    });
  }

  // Parse section 2 — track widths
  const section2Start = section1Start + nodeCount * NODE_RECORD_SIZE;
  const s2NodeCount = buf.readInt32LE(section2Start);
  // 16 bytes zeros at section2Start + 4
  const widthStart = section2Start + 4 + 16;

  const WIDTH_RECORD_SIZE = 80;
  const widths: WidthRecord[] = [];
  const expectedCount = Math.min(s2NodeCount, nodeCount);

  for (let i = 0; i < expectedCount; i++) {
    const base = widthStart + i * WIDTH_RECORD_SIZE;
    if (base + 12 > buf.length) break;

    // +4: sideLeft (half-width to left edge in meters)
    // +8: sideRight (half-width to right edge in meters)
    widths.push({
      sideLeft: buf.readFloatLE(base + 4),
      sideRight: buf.readFloatLE(base + 8),
    });
  }

  return { nodes, widths };
}

/**
 * Validate that sideLeft/sideRight values are within realistic track width range.
 * Allows up to 5% of nodes to be outliers (pit entry/exit, chicanes, etc.).
 */
function validateWidths(widths: WidthRecord[]): boolean {
  if (widths.length === 0) return false;
  let outliers = 0;
  for (const w of widths) {
    if (w.sideLeft < 0.5 || w.sideLeft > 40.0 || w.sideRight < 0.5 || w.sideRight > 40.0) {
      outliers++;
    }
  }
  // Allow up to 10% outliers (pit entry/exit, chicanes; clamped per-node in computeEdges)
  return outliers / widths.length <= 0.10;
}

interface EdgePoint {
  x: number;
  z: number;
}

/**
 * Compute left/right edge coordinates from node positions + perpendicular normals + widths.
 *
 * For each node:
 *   - Compute forward tangent from adjacent nodes in XZ plane
 *   - perpNorm = rotate tangent 90° CCW in XZ: (-tz, tx) normalized
 *   - leftEdge[i]  = node[i] + perpNorm * sideLeft[i]
 *   - rightEdge[i] = node[i] - perpNorm * sideRight[i]
 */
function computeEdges(
  nodes: FastlaneNode[],
  widths: WidthRecord[],
  validWidths: boolean,
): { leftEdge: EdgePoint[]; rightEdge: EdgePoint[] } {
  const n = nodes.length;
  const leftEdge: EdgePoint[] = [];
  const rightEdge: EdgePoint[] = [];
  const DEFAULT_HALF_WIDTH = 7.0;

  for (let i = 0; i < n; i++) {
    const node = nodes[i];

    // Forward tangent from adjacent nodes in XZ plane
    const prev = nodes[(i - 1 + n) % n];
    const next = nodes[(i + 1) % n];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const tLen = Math.sqrt(tx * tx + tz * tz);

    // Perpendicular: rotate tangent 90° CCW → (-tz, tx) normalized
    let perpX = 0;
    let perpZ = 0;
    if (tLen > 0) {
      perpX = -tz / tLen;
      perpZ = tx / tLen;
    }

    // Clamp widths to sane range; fall back to default if out of range
    const rawLeft = validWidths && i < widths.length ? widths[i].sideLeft : DEFAULT_HALF_WIDTH;
    const rawRight = validWidths && i < widths.length ? widths[i].sideRight : DEFAULT_HALF_WIDTH;
    const halfLeft = rawLeft >= 0.5 && rawLeft <= 40.0 ? rawLeft : DEFAULT_HALF_WIDTH;
    const halfRight = rawRight >= 0.5 && rawRight <= 40.0 ? rawRight : DEFAULT_HALF_WIDTH;

    leftEdge.push({
      x: node.x + perpX * halfLeft,
      z: node.z + perpZ * halfLeft,
    });
    rightEdge.push({
      x: node.x - perpX * halfRight,
      z: node.z - perpZ * halfRight,
    });
  }

  return { leftEdge, rightEdge };
}

// ── Main extraction function ─────────────────────────────────────────

export async function extractAccTracks(
  outDir: string,
  onProgress?: ProgressCallback,
): Promise<{ extracted: number }> {
  const accDir = findAccInstall();
  if (!accDir) throw new Error("Assetto Corsa Competizione not found. Is it installed via Steam?");

  const cacheDir = join(accDir, "AC2", "Content", "Cache");
  if (!existsSync(cacheDir)) {
    throw new Error(`ACC Cache directory not found: ${cacheDir}`);
  }

  mkdirSync(outDir, { recursive: true });

  const trackNames = loadTrackNames();

  // Scan cache directory for track subdirectories
  const trackDirs = readdirSync(cacheDir).filter((d) => {
    try { return statSync(join(cacheDir, d)).isDirectory(); } catch { return false; }
  });

  onProgress?.({ type: "total", track: "", count: trackDirs.length });
  console.log(`[ACC] Track extraction — ${trackDirs.length} directories found in Cache`);

  let extracted = 0;

  for (const dirName of trackDirs) {
    const ordinal = ACC_DIR_TO_ORDINAL[dirName];
    if (ordinal === undefined) {
      console.log(`[ACC] ${dirName} — no ordinal mapping, skipping`);
      onProgress?.({ type: "skipped", track: dirName, count: 0 });
      continue;
    }

    const fastlanePath = join(cacheDir, dirName, "fastlane.ai");
    if (!existsSync(fastlanePath)) {
      console.log(`[ACC] ${dirName} — fastlane.ai not found, skipping`);
      onProgress?.({ type: "skipped", track: dirName, count: 0 });
      continue;
    }

    try {
      const buf = Buffer.from(readFileSync(fastlanePath));
      const { nodes, widths } = parseFastlane(buf);

      if (nodes.length < 10) {
        console.log(`[ACC] ${dirName} — too few nodes (${nodes.length}), skipping`);
        onProgress?.({ type: "skipped", track: dirName, count: 0 });
        continue;
      }

      const validWidths = validateWidths(widths);
      if (!validWidths) {
        console.warn(`[ACC] ${dirName} — width values out of expected range, using default 7m half-width`);
      }

      const { leftEdge, rightEdge } = computeEdges(nodes, widths, validWidths);
      const name = trackOutputName(dirName, ordinal, trackNames);

      // Write centerline CSV: header x,z, one point per line
      const centerlineLines = ["x,z"];
      for (const node of nodes) {
        centerlineLines.push(`${node.x.toFixed(4)},${node.z.toFixed(4)}`);
      }
      writeFileSync(join(outDir, `${name}-centerline.csv`), centerlineLines.join("\n"));

      // Write boundaries JSON
      writeFileSync(
        join(outDir, `${name}-boundaries.json`),
        JSON.stringify(
          {
            source: "acc-extracted",
            nodeCount: nodes.length,
            leftEdge,
            rightEdge,
            coordSystem: "acc",
          },
          null,
          2,
        ),
      );

      console.log(
        `[ACC] ${dirName} (ordinal ${ordinal}, name "${name}") — ${nodes.length} nodes${validWidths ? "" : " [default width]"} → OK`,
      );
      extracted++;
      onProgress?.({ type: "extracted", track: dirName, count: extracted });
    } catch (err) {
      console.error(`[ACC] ${dirName} error: ${(err as Error).message}`);
      onProgress?.({ type: "skipped", track: dirName, count: 0 });
    }
  }

  console.log(`[ACC] Extracted ${extracted} tracks to ${outDir}`);
  return { extracted };
}

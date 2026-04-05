/**
 * Extract track centerline outlines from Forza Motorsport 2023 game files.
 *
 * Reads AI/Track.geo from each track's ribbon ZIP, parses the MLP binary
 * format for waypoint coordinates, and writes recorded-{ordinal}.csv files
 * to shared/track-outlines/fm-2023/.
 *
 * Usage: bun scripts/extract-fm2023-tracks.ts
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import {
  findForzaInstall,
  parseForzaZip,
  decompressForzaLZX,
} from "@shared/lib/forza-lzx";

const OUT_DIR = resolve(import.meta.dir, "../shared/tracks/fm-2023");

// ── Load track name mapping from tracks.csv ──
const tracksCSV = resolve(import.meta.dir, "../shared/games/fm-2023/tracks.csv");
const ordinalToName = new Map<number, string>();
try {
  const csv = require("fs").readFileSync(tracksCSV, "utf-8") as string;
  for (const line of csv.trim().split("\n")) {
    const parts = line.split(",");
    const ordinal = parseInt(parts[0], 10);
    const sharedName = parts[6]?.trim();
    if (!isNaN(ordinal)) {
      ordinalToName.set(ordinal, sharedName ? `${sharedName}-${ordinal}` : `${ordinal}`);
    }
  }
} catch {}

function trackFileName(ordinal: number): string {
  return ordinalToName.get(ordinal) ?? `${ordinal}`;
}

// ── Find FM2023 ──

const forzaDir = findForzaInstall();
if (!forzaDir) {
  console.error(
    "Forza Motorsport 2023 not found. Check your Steam installation.",
  );
  process.exit(1);
}
console.log(`[FM2023] Found at: ${forzaDir}`);

// ── Build track-dir → ordinal mapping from tracks.zip ──

const tracksZipPath = `${forzaDir}/media/base/ai/tracks.zip`;
const { entries: trackEntries } = parseForzaZip(tracksZipPath);
const trackOrdinalMap = new Map<string, number[]>();
for (const entry of trackEntries) {
  const match = entry.name.match(
    /^(\w+)\/(ribbon_\d+)\/difficulty\/track_(\d+)_/,
  );
  if (match) {
    const key = `${match[1]}/${match[2]}`;
    const ordinal = parseInt(match[3], 10);
    if (!trackOrdinalMap.has(key)) trackOrdinalMap.set(key, []);
    const ords = trackOrdinalMap.get(key)!;
    if (!ords.includes(ordinal)) ords.push(ordinal);
  }
}

// ── Parse MLP waypoints from Track.geo ──

interface MlpFields {
  [name: string]: { count: number; offset: number };
}

function parseMlpHeader(data: Buffer): { fields: MlpFields; count: number } | null {
  const text = data.toString("utf8", 0, Math.min(4096, data.length));
  const startIdx = text.indexOf("MLPDataStart:");
  if (startIdx === -1) return null;

  const headerEnd = text.indexOf("MLPDataEnd:");
  const header = text.substring(
    startIdx + "MLPDataStart:\n".length,
    headerEnd > 0 ? headerEnd : 4096,
  );

  const fields: MlpFields = {};
  for (const line of header.split("\n")) {
    const m = line.trim().match(/^(\w+):(\w+):(\d+):(\d+):\s+(\d+)$/);
    if (!m) continue;
    fields[m[1]] = { count: parseInt(m[3]), offset: parseInt(m[5]) };
  }

  const wpX = fields.fWaypointX;
  return { fields, count: wpX?.count ?? 0 };
}

function parseMlpWaypoints(
  data: Buffer,
): { x: number[]; z: number[] } | null {
  const parsed = parseMlpHeader(data);
  if (!parsed || !parsed.count) return null;

  const { fields } = parsed;
  let count = parsed.count;
  const wpXOffset = fields.fWaypointX.offset;
  const wpYOffset = fields.fWaypointY?.offset ?? -1;
  if (wpYOffset < 0) return null;

  const needed = Math.max(wpXOffset, wpYOffset) + count * 4;
  if (data.length < needed) {
    count = Math.min(
      Math.floor((data.length - wpXOffset) / 4),
      Math.floor((data.length - wpYOffset) / 4),
    );
    if (count < 50) return null;
  }

  const x: number[] = [],
    z: number[] = [];
  for (let i = 0; i < count; i++) {
    x.push(data.readFloatLE(wpXOffset + i * 4));
    z.push(data.readFloatLE(wpYOffset + i * 4));
  }
  return { x, z };
}

/** Extract track boundary data from TrackLimitsCenter/Normal fields.
 *  The TrackLimitsNormal vector IS the half-width offset — it points from
 *  the track center to one edge, so: leftEdge = TLC + TLN, rightEdge = TLC - TLN. */
function parseMlpBoundaries(
  data: Buffer,
): { leftEdge: {x: number; z: number}[]; rightEdge: {x: number; z: number}[]; altitude: number[] } | null {
  const parsed = parseMlpHeader(data);
  if (!parsed || !parsed.count) return null;

  const { fields, count } = parsed;

  const readField = (name: string): number[] | null => {
    const f = fields[name];
    if (!f || f.offset + count * 4 > data.length) return null;
    const arr: number[] = [];
    for (let i = 0; i < count; i++) arr.push(data.readFloatLE(f.offset + i * 4));
    return arr;
  };

  // Use TrackLimitsCenter + TrackLimitsNormal for actual track edges (full 3D)
  const tlcX = readField("TrackLimitsCenterX");
  const tlcZ = readField("TrackLimitsCenterY"); // Y in geo = Z in telemetry
  const tlcY = readField("TrackLimitsCenterZ"); // Z in geo = Y (altitude)
  const tlnX = readField("TrackLimitsNormalX");
  const tlnZ = readField("TrackLimitsNormalY");
  const tlnY = readField("TrackLimitsNormalZ"); // vertical component = banking
  const alt = readField("fWaypointZ");

  // Fall back to waypoint normals if TrackLimits fields are missing
  if (!tlcX || !tlcZ || !tlnX || !tlnZ) {
    const wpX = readField("fWaypointX");
    const wpZ = readField("fWaypointY");
    const nX = readField("fNormalX");
    const nZ = readField("fNormalY");
    if (!wpX || !wpZ || !nX || !nZ) return null;

    const leftEdge: {x: number; y?: number; z: number}[] = [];
    const rightEdge: {x: number; y?: number; z: number}[] = [];
    for (let i = 0; i < count; i++) {
      leftEdge.push({ x: wpX[i] + nX[i], z: wpZ[i] + nZ[i] });
      rightEdge.push({ x: wpX[i] - nX[i], z: wpZ[i] - nZ[i] });
    }
    return { leftEdge, rightEdge, altitude: alt ?? [] };
  }

  const leftEdge: {x: number; y?: number; z: number}[] = [];
  const rightEdge: {x: number; y?: number; z: number}[] = [];

  for (let i = 0; i < count; i++) {
    const ly = tlcY ? tlcY[i] + (tlnY?.[i] ?? 0) : undefined;
    const ry = tlcY ? tlcY[i] - (tlnY?.[i] ?? 0) : undefined;
    leftEdge.push({ x: tlcX[i] + tlnX[i], ...(ly != null && { y: ly }), z: tlcZ[i] + tlnZ[i] });
    rightEdge.push({ x: tlcX[i] - tlnX[i], ...(ry != null && { y: ry }), z: tlcZ[i] - tlnZ[i] });
  }

  return { leftEdge, rightEdge, altitude: alt ?? [] };
}

/** Parse Track.seg MLP data — corner/straight segments with apex indices and curvature. */
function parseMlpSegments(data: Buffer): {
  type: "corner" | "straight";
  direction: "left" | "right" | null;
  startFrac: number;
  endFrac: number;
  apexFrac: number;
  peakCurvature: number;
  turnType: number;
}[] | null {
  const parsed = parseMlpHeader(data);
  if (!parsed) return null;
  const { fields } = parsed;

  const readInt = (name: string): number | null => {
    const f = fields[name];
    if (!f || f.offset + 4 > data.length) return null;
    return data.readInt32LE(f.offset);
  };
  const readIntArray = (name: string, n: number): number[] | null => {
    const f = fields[name];
    if (!f || f.offset + n * 4 > data.length) return null;
    const arr: number[] = [];
    for (let i = 0; i < n; i++) arr.push(data.readInt32LE(f.offset + i * 4));
    return arr;
  };
  const readFloatArray = (name: string, n: number): number[] | null => {
    const f = fields[name];
    if (!f || f.offset + n * 4 > data.length) return null;
    const arr: number[] = [];
    for (let i = 0; i < n; i++) arr.push(data.readFloatLE(f.offset + i * 4));
    return arr;
  };

  const numSegs = readInt("iNumSegments");
  const trackLen = readInt("iTrackLength");
  if (!numSegs || !trackLen || numSegs < 1 || trackLen < 10) return null;

  const starts = readIntArray("iStart", numSegs);
  const apexes = readIntArray("iApex", numSegs);
  const ends = readIntArray("iEnd", numSegs);
  const curvatures = readFloatArray("fPeakCurvature", numSegs);
  const turnTypes = readIntArray("iTurnType", numSegs);
  if (!starts || !apexes || !ends || !curvatures || !turnTypes) return null;

  const segments: ReturnType<typeof parseMlpSegments> = [];
  for (let i = 0; i < numSegs; i++) {
    const isStraight = turnTypes[i] === 0;
    const wraps = ends[i] < starts[i];
    const seg = {
      type: (isStraight ? "straight" : "corner") as "straight" | "corner",
      direction: (curvatures[i] > 0 ? "right" : curvatures[i] < 0 ? "left" : null) as "left" | "right" | null,
      apexFrac: +(apexes[i] / trackLen).toFixed(6),
      peakCurvature: +curvatures[i].toFixed(6),
      turnType: turnTypes[i],
    };
    if (wraps) {
      // Split wrap-around segment: start→end of track, then 0→end
      segments!.push({ ...seg, startFrac: +(starts[i] / trackLen).toFixed(6), endFrac: 1 });
      segments!.push({ ...seg, startFrac: 0, endFrac: +(ends[i] / trackLen).toFixed(6) });
    } else {
      segments!.push({ ...seg, startFrac: +(starts[i] / trackLen).toFixed(6), endFrac: +(ends[i] / trackLen).toFixed(6) });
    }
  }
  // Sort by startFrac so the 0→x piece comes first
  segments!.sort((a, b) => a!.startFrac - b!.startFrac);
  return segments;
}

/**
 * Handle nested ZIP containers where Track.geo is itself a ZIP.
 * Scans local file headers for an inner Track.geo and decompresses it.
 *
 * Note: Suzuka's AI data uses nested ZIPs but the actual waypoint data
 * (MLPDataStart/fWaypointX) is physically absent — the nested ZIP is a stub
 * with only metadata entries. Suzuka falls back to the shared TUMFTM outline
 * (see TRACK_FILES in track-outlines/index.ts).
 */
function decompressNestedGeo(zipData: Buffer): Buffer {
  let pos = 0;
  while (pos < zipData.length - 30) {
    if (zipData.readUInt32LE(pos) !== 0x04034b50) { pos++; continue; }
    const method = zipData.readUInt16LE(pos + 8);
    const compSize = zipData.readUInt32LE(pos + 18);
    const uncompSize = zipData.readUInt32LE(pos + 22);
    const nameLen = zipData.readUInt16LE(pos + 26);
    const extraLen = zipData.readUInt16LE(pos + 28);
    const name = zipData.subarray(pos + 30, pos + 30 + nameLen).toString("utf8");
    const dataStart = pos + 30 + nameLen + extraLen;

    if (name.endsWith("Track.geo") && method === 21) {
      const inner = zipData.subarray(dataStart, dataStart + compSize);
      return decompressForzaLZX(inner, uncompSize);
    }

    // Recurse into nested ZIPs
    if (dataStart + compSize <= zipData.length) {
      const entryData = zipData.subarray(dataStart, dataStart + compSize);
      if (entryData.length >= 4 && entryData.readUInt32LE(0) === 0x04034b50) {
        try {
          return decompressNestedGeo(entryData);
        } catch { /* try next entry */ }
      }
    }

    pos = dataStart + compSize;
  }
  throw new Error("No Track.geo found in nested ZIP");
}

// ── Extract all tracks ──

mkdirSync(OUT_DIR, { recursive: true });
const tracksDir = `${forzaDir}/media/pcfamily/tracks`;
const trackDirs = readdirSync(tracksDir).filter((d) =>
  readdirSync(resolve(tracksDir, d)).some((f) => /^ribbon_\d+\.zip$/.test(f)),
);

let extracted = 0,
  skipped = 0,
  failed = 0;

for (const trackDir of trackDirs) {
  const ribbonFiles = readdirSync(resolve(tracksDir, trackDir))
    .filter((f) => /^ribbon_\d+\.zip$/.test(f))
    .sort();

  for (const ribbonFile of ribbonFiles) {
    const ribbonName = ribbonFile.replace(".zip", "");
    const mapKey = `${trackDir}/${ribbonName}`;
    const ordinals = trackOrdinalMap.get(mapKey);
    if (!ordinals || ordinals.length === 0) {
      skipped++;
      continue;
    }

    const zipPath = resolve(tracksDir, trackDir, ribbonFile);
    try {
      const { buf, entries } = parseForzaZip(zipPath);
      const geoEntry = entries.find((e) => e.name === "AI/Track.geo");
      if (!geoEntry) {
        skipped++;
        continue;
      }

      let compressed = buf.subarray(
        geoEntry.dataStart,
        geoEntry.dataStart + geoEntry.compSize,
      );
      let decompressed: Buffer;

      // Handle nested ZIP containers (e.g. Suzuka)
      if (compressed.length >= 4 && compressed.readUInt32LE(0) === 0x04034b50) {
        // Track.geo is a nested ZIP — scan for inner Track.geo entry
        decompressed = decompressNestedGeo(compressed);
      } else {
        decompressed = decompressForzaLZX(compressed, geoEntry.uncompSize);
      }
      const waypoints = parseMlpWaypoints(decompressed);
      if (!waypoints) {
        failed++;
        continue;
      }

      // Extract boundary data (TrackLimitsCenter, wall distances, altitude)
      const boundaries = parseMlpBoundaries(decompressed);

      // Extract corner/straight segments from Track.seg
      let segments: ReturnType<typeof parseMlpSegments> = null;
      const segEntry = entries.find((e) => e.name === "AI/Track.seg");
      if (segEntry) {
        try {
          let segCompressed = buf.subarray(segEntry.dataStart, segEntry.dataStart + segEntry.compSize);
          let segData: Buffer;
          if (segCompressed.length >= 4 && segCompressed.readUInt32LE(0) === 0x04034b50) {
            segData = decompressNestedGeo(segCompressed);
          } else {
            segData = decompressForzaLZX(segCompressed, segEntry.uncompSize);
          }
          segments = parseMlpSegments(segData);
        } catch {}
      }

      for (const ordinal of ordinals) {
        const name = trackFileName(ordinal);

        const outPath = resolve(OUT_DIR, `${name}-centerline.csv`);
        const csv =
          "x,z\n" +
          waypoints.x
            .map((x, i) => `${x.toFixed(4)},${waypoints.z[i].toFixed(4)}`)
            .join("\n");
        writeFileSync(outPath, csv);

        if (boundaries) {
          const boundaryPath = resolve(OUT_DIR, `${name}-boundaries.json`);
          writeFileSync(boundaryPath, JSON.stringify({
            waypoints: waypoints.x.length,
            leftEdge: boundaries.leftEdge,
            rightEdge: boundaries.rightEdge,
            ...(boundaries.altitude.length > 0 && { altitude: boundaries.altitude }),
          }, null, 2));
        }

        extracted++;
        console.log(
          `  ✓ ${trackDir}/${ribbonName} → ${name} (${waypoints.x.length} pts${boundaries ? " + boundaries" : ""})`,
        );
      }
    } catch (e: any) {
      console.error(
        `  ✗ ${trackDir}/${ribbonName}: ${e.message?.substring(0, 80)}`,
      );
      failed++;
    }
  }
}

console.log(
  `\n[FM2023] Done: ${extracted} outlines extracted, ${skipped} skipped, ${failed} failed`,
);
console.log(`Output: ${OUT_DIR}`);

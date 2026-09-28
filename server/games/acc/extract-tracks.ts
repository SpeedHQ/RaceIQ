/**
 * ACC fastlane racing-line extraction — importable module.
 *
 * Reads each track's fastlane.ai from the ACC Cache and writes raceline CSVs.
 * Track edges come from bundled map-spline SVGs, never fastlane widths.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findSteamInstall } from "../shared/steam-install";

const _scriptDir = dirname(fileURLToPath(import.meta.url));

export interface ProgressEvent {
  type: "total" | "extracted" | "skipped";
  track: string;
  count: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

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
      if (Number.isNaN(id)) continue;
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

// ── fastlane.ai racing-line parser ──────────────────────────────────

interface FastlaneNode {
  x: number;
  z: number;
}

function parseFastlane(buf: Buffer): FastlaneNode[] {
  const version = buf.readInt32LE(0);
  if (version !== 8) throw new Error(`Unsupported fastlane.ai version: ${version}`);
  const nodeCount = buf.readInt32LE(4);
  const nodes: FastlaneNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const base = 16 + i * 36;
    nodes.push({ x: buf.readDoubleLE(base), z: buf.readDoubleLE(base + 16) });
  }
  return nodes;
}


// ── Main extraction function ─────────────────────────────────────────

export async function extractAccTracks(
  outDir: string,
  onProgress?: ProgressCallback,
): Promise<{ extracted: number }> {
  const accDir = findSteamInstall("Assetto Corsa Competizione", [
    "C:/Program Files (x86)/Steam/steamapps/common/Assetto Corsa Competizione",
    "E:/SteamLibrary/steamapps/common/Assetto Corsa Competizione",
  ]);
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
      const nodes = parseFastlane(buf);

      if (nodes.length < 10) {
        console.log(`[ACC] ${dirName} — too few nodes (${nodes.length}), skipping`);
        onProgress?.({ type: "skipped", track: dirName, count: 0 });
        continue;
      }

      const name = trackOutputName(dirName, ordinal, trackNames);

      // fastlane.ai supplies a driving line, not track edges or a true centre.
      // Keep it as a separate reference artifact; authoritative spline SVGs
      // are bundled directly from SpeedHQ/extractions.
      const racelineLines = ["x,z"];
      for (const node of nodes) {
        racelineLines.push(`${node.x.toFixed(4)},${node.z.toFixed(4)}`);
      }
      writeFileSync(join(outDir, `${name}-raceline.csv`), racelineLines.join("\n"));

      console.log(
        `[ACC] ${dirName} (ordinal ${ordinal}, name "${name}") — ${nodes.length} nodes → OK`,
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

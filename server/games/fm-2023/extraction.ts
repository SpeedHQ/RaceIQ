import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { USER_TRACKS_DIR } from "../../runtime/config/paths";
import { scanRecordedFiles } from "../../../shared/racing/tracks/recording/outlines";
import { findForzaInstall } from "../../../shared/integrations/forza/install";
import { decompressForzaLZX } from "../../../shared/integrations/forza/lzx-decoder";
import { parseForzaZip } from "../../../shared/integrations/forza/zip";
import { createExtractionState } from "../shared/extraction-state";


export const FM2023_OUT_DIR = resolve(USER_TRACKS_DIR, "fm-2023/extracted");

export const extractionState = createExtractionState(!!findForzaInstall(), 0);

// Check if already extracted on startup
try {
  if (existsSync(FM2023_OUT_DIR)) {
    const csvs = readdirSync(FM2023_OUT_DIR).filter(
      (f) => f.startsWith("recorded-") && f.endsWith(".csv"),
    );
    if (csvs.length > 0) {
      extractionState.status = "done";
      extractionState.extracted = csvs.length;
    }
  }
} catch {}

function parseMlpWaypoints(data: Buffer): { x: number[]; z: number[] } | null {
  const text = data.toString("utf8", 0, Math.min(1024, data.length));
  const startIdx = text.indexOf("MLPDataStart:");
  if (startIdx === -1) return null;

  const headerEnd = text.indexOf("MLPDataEnd:");
  const header = text.substring(
    startIdx + "MLPDataStart:\n".length,
    headerEnd > 0 ? headerEnd : 1024,
  );

  let wpXOffset = -1,
    wpYOffset = -1,
    count = 0;

  for (const line of header.split("\n")) {
    const m = line.trim().match(/^(\w+):(\w+):(\d+):(\d+):\s+(\d+)$/);
    if (!m) continue;
    if (m[1] === "fWaypointX") {
      wpXOffset = parseInt(m[5], 10);
      count = parseInt(m[3], 10);
    }
    if (m[1] === "fWaypointY") wpYOffset = parseInt(m[5], 10);
  }

  if (wpXOffset < 0 || wpYOffset < 0 || count === 0) return null;

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

export async function runForzaExtraction(): Promise<void> {
  const forzaDir = findForzaInstall();
  if (!forzaDir) {
    extractionState.status = "error";
    extractionState.error = "Forza Motorsport 2023 not found";
    return;
  }

  extractionState.status = "running";
  extractionState.extracted = 0;
  extractionState.failed = 0;
  extractionState.error = "";

  try {
    const { entries: trackEntries } = parseForzaZip(
      `${forzaDir}/media/base/ai/tracks.zip`,
    );

    const ordinalMap = new Map<string, number[]>();
    for (const entry of trackEntries) {
      const match = entry.name.match(
        /^(\w+)\/(ribbon_\d+)\/difficulty\/track_(\d+)_/,
      );
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        const ordinal = parseInt(match[3], 10);
        if (!ordinalMap.has(key)) ordinalMap.set(key, []);
        const ords = ordinalMap.get(key)!;
        if (!ords.includes(ordinal)) ords.push(ordinal);
      }
    }

    mkdirSync(FM2023_OUT_DIR, { recursive: true });

    const tracksDir = `${forzaDir}/media/pcfamily/tracks`;
    const trackDirs = readdirSync(tracksDir).filter((d) =>
      existsSync(resolve(tracksDir, d, "ribbon_00.zip")),
    );

    const allRibbons: { trackDir: string; ribbonFile: string }[] = [];
    for (const trackDir of trackDirs) {
      const ribbons = readdirSync(resolve(tracksDir, trackDir)).filter((f) =>
        /^ribbon_\d+\.zip$/.test(f),
      );
      for (const ribbonFile of ribbons) allRibbons.push({ trackDir, ribbonFile });
    }

    extractionState.total = allRibbons.length;

    for (const { trackDir, ribbonFile } of allRibbons) {
      const ribbonName = ribbonFile.replace(".zip", "");
      const mapKey = `${trackDir}/${ribbonName}`;
      extractionState.current = `${trackDir}/${ribbonName}`;

      const ordinals = ordinalMap.get(mapKey);
      if (!ordinals || ordinals.length === 0) continue;

      try {
        const { buf, entries } = parseForzaZip(
          resolve(tracksDir, trackDir, ribbonFile),
        );
        const geoEntry = entries.find((e) => e.name === "AI/Track.geo");
        if (!geoEntry) continue;

        const compressed = buf.subarray(
          geoEntry.dataStart,
          geoEntry.dataStart + geoEntry.compSize,
        );
        const decompressed = decompressForzaLZX(
          compressed,
          geoEntry.uncompSize,
        );
        const waypoints = parseMlpWaypoints(decompressed);
        if (!waypoints) {
          extractionState.failed++;
          continue;
        }

        for (const ordinal of ordinals) {
          const csv =
            "x,z\n" +
            waypoints.x
              .map((x, i) => `${x.toFixed(4)},${waypoints.z[i].toFixed(4)}`)
              .join("\n");
          writeFileSync(
            resolve(FM2023_OUT_DIR, `recorded-${ordinal}.csv`),
            csv,
          );
          extractionState.extracted++;
        }
      } catch {
        extractionState.failed++;
      }

      await new Promise((r) => setTimeout(r, 0));
    }

    extractionState.status = "done";
    extractionState.current = "";
    scanRecordedFiles();
  } catch (e: any) {
    extractionState.status = "error";
    extractionState.error = e.message || "Unknown error";
  }
}

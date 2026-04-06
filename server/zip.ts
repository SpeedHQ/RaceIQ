/**
 * Lap data ZIP export/import using fflate.
 */
import { zipSync, unzipSync } from "fflate";
import { getLapsRaw, getLaps, insertSession, insertLapSync, decompressTelemetry, compressTelemetry } from "./db/queries";
import { getCarName, getTrackName } from "../shared/car-data";
import type { GameId } from "../shared/types";

interface LapManifestEntry {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  pi: number | null;
  carOrdinal: number;
  carName: string;
  trackOrdinal: number;
  trackName: string;
  gameId: string;
  createdAt: string;
  file: string;
}

interface Manifest {
  version: 1;
  exportedAt: string;
  lapCount: number;
  laps: LapManifestEntry[];
}

/**
 * Build a zip containing lap telemetry blobs + manifest.
 * Telemetry is stored as-is (already gzip'd CSV), so we use STORE (level 0).
 */
export async function exportLapsZip(ids?: number[]): Promise<Uint8Array> {
  const rows = await getLapsRaw(ids);
  if (rows.length === 0) throw new Error("No laps to export");

  const files: Record<string, Uint8Array> = {};
  const manifestLaps: LapManifestEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    // Deduplicate by car + track + game + lapNumber + lapTime
    const key = `${row.carOrdinal}:${row.trackOrdinal}:${row.gameId}:${row.lapNumber}:${row.lapTime}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fileName = `lap_${row.id}.csv.gz`;
    // Telemetry blob is already gzip'd — store without re-compressing
    files[fileName] = new Uint8Array(row.telemetry as Buffer);
    manifestLaps.push({
      id: row.id,
      lapNumber: row.lapNumber,
      lapTime: row.lapTime,
      isValid: Boolean(row.isValid),
      pi: row.pi,
      carOrdinal: row.carOrdinal,
      carName: getCarName(row.carOrdinal) ?? `Car ${row.carOrdinal}`,
      trackOrdinal: row.trackOrdinal,
      trackName: getTrackName(row.trackOrdinal) ?? `Track ${row.trackOrdinal}`,
      gameId: row.gameId,
      createdAt: row.createdAt,
      file: fileName,
    });
  }

  const manifest: Manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    lapCount: manifestLaps.length,
    laps: manifestLaps,
  };

  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  // Use level 0 (STORE) for .csv.gz files since they're already compressed
  const zipOptions: Record<string, [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]> = {};
  for (const [name, data] of Object.entries(files)) {
    const level = name.endsWith(".gz") ? 0 : 6;
    zipOptions[name] = [data, { level: level as any }];
  }

  return zipSync(zipOptions);
}

/**
 * Import laps from a zip file. Creates new sessions as needed.
 * Returns the number of laps imported.
 */
export async function importLapsZip(zipData: Uint8Array): Promise<{ imported: number; skipped: number }> {
  const extracted = unzipSync(zipData);

  const manifestBytes = extracted["manifest.json"];
  if (!manifestBytes) throw new Error("Invalid zip: missing manifest.json");

  const manifest: Manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (manifest.version !== 1) throw new Error(`Unsupported manifest version: ${manifest.version}`);

  // Build set of existing laps for dedup
  const existingLaps = await getLaps();
  const existingKeys = new Set(
    existingLaps.map((l) => `${l.carOrdinal}:${l.trackOrdinal}:${l.gameId}:${l.lapNumber}:${l.lapTime}`)
  );

  const sessionMap = new Map<string, number>();
  let imported = 0;
  let skipped = 0;

  for (const entry of manifest.laps) {
    // Skip if this lap already exists
    const dedupKey = `${entry.carOrdinal}:${entry.trackOrdinal}:${entry.gameId}:${entry.lapNumber}:${entry.lapTime}`;
    if (existingKeys.has(dedupKey)) {
      skipped++;
      continue;
    }

    const blobData = extracted[entry.file];
    if (!blobData) {
      skipped++;
      continue;
    }

    // Get or create session for this car/track/game combo
    const sessionKey = `${entry.carOrdinal}:${entry.trackOrdinal}:${entry.gameId}`;
    let sessionId = sessionMap.get(sessionKey);
    if (sessionId === undefined) {
      sessionId = await insertSession(
        entry.carOrdinal,
        entry.trackOrdinal,
        entry.gameId as GameId
      );
      sessionMap.set(sessionKey, sessionId);
    }

    // The blob is already gzip'd CSV — decompress to get packets, then re-compress
    // (roundtrip ensures compatibility with current storage format)
    const packets = decompressTelemetry(Buffer.from(blobData));
    await insertLapSync(sessionId, entry.lapNumber, entry.lapTime, entry.isValid, packets);
    existingKeys.add(dedupKey);
    imported++;
  }

  return { imported, skipped };
}

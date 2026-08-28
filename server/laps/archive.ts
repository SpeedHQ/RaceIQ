/**
 * Lap / session ZIP export + import.
 *
 * Telemetry is NOT stored as a per-lap blob any more — the canonical source is
 * the per-session raw capture on disk (`sessions.rawFile`: optional 12-byte
 * meta frame, then repeated `[uint32 LE len][frame bytes]`), with each lap row
 * pointing at a `rawByteOffset` / `rawFrameCount` window inside it.
 *
 * So an export is just a slice of that frame stream, and an import replays the
 * slice through the normal pipeline (`importSessionBin`) — the exact same code
 * path as the single-file `.bin` import. Nothing here re-implements parsing or
 * lap detection, which is what the old CSV-blob format did (and why it rotted).
 *
 * Zip layout:
 *   manifest.json                              — describes every entry
 *   <gameId>-<track>-session<id>.bin.gz        — one gzip'd frame slice per session
 */
import { zipSync, unzipSync } from "fflate";
import type { SessionOwnership } from "../../shared/racing/sessions/types";
import { getLapsRaw } from "../db/lap-read-queries";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import {
  detectGameIdFromBuffer,
  detectGameIdFromFilename,
  importSessionBin,
} from "../session-capture/import-capture";
import type { ImportedLap } from "../session-capture/import-pipeline";
import {
  advanceSessionFrames,
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentBoundaryFrame,
  gunzipBufferSync,
  gzipBufferSync,
  iterateSessionCaptureRecords,
  sessionFrameAt,
} from "../session-capture/framing";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  IRacingSourceFrameEncoder,
  type IRacingSourceFrame,
} from "../games/iracing/source-frame";
import type { GameId } from "../../shared/games/ids";

/** Bumped when the zip layout changes in a way older readers can't handle. */
export const LAPS_ZIP_VERSION = 3;

export interface ManifestLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
}

export interface ManifestEntry {
  /** Zip entry name holding this session's gzip'd frame slice. */
  file: string;
  gameId: GameId;
  /** Session id in the *source* database (informational — import always creates a new session). */
  sessionId: number;
  carOrdinal: number;
  trackOrdinal: number;
  carName: string;
  trackName: string;
  createdAt: string;
  laps: ManifestLap[];
}

export interface LapsZipManifest {
  version: number;
  exportedAt: string;
  entries: ManifestEntry[];
}

type RawLapRow = Awaited<ReturnType<typeof getLapsRaw>>[number];

const MANIFEST_FILE_NAME = "manifest.json";
const manifestTextEncoder = new TextEncoder();
const manifestTextDecoder = new TextDecoder();

function parseManifestFile(files: Record<string, Uint8Array>): LapsZipManifest | null {
  const manifestBytes = files[MANIFEST_FILE_NAME];
  if (!manifestBytes) return null;
  try {
    return JSON.parse(manifestTextDecoder.decode(manifestBytes)) as LapsZipManifest;
  } catch {
    return null;
  }
}

function encodeManifestFile(manifest: LapsZipManifest): Uint8Array {
  return manifestTextEncoder.encode(JSON.stringify(manifest, null, 2));
}

/**
 * Read capture bytes from disk and decompress gzip raw files.
 * Returns null when the file is missing or unreadable.
 */
async function readCapture(rawFile: string): Promise<Buffer | null> {
  try {
    const file = Bun.file(rawFile);
    if (!(await file.exists())) return null;
    const bytes = Buffer.from(await file.arrayBuffer());
    return rawFile.endsWith(".gz") ? gunzipBufferSync(bytes) : bytes;
  } catch {
    return null;
  }
}

function captureFileName(memberName: string): string {
  const idx = memberName.lastIndexOf("/");
  return idx >= 0 ? memberName.slice(idx + 1) : memberName;
}

function fileNamesForZip(files: Record<string, Uint8Array>): string[] {
  return Object.keys(files)
    .filter((name) => name.endsWith(".bin") || name.endsWith(".bin.gz"))
    .sort();
}

function parseCaptureGameId(
  memberName: string,
  bytes: Buffer,
  manifestGame: ReadonlyMap<string, GameId>,
): GameId | null {
  return (
    detectGameIdFromBuffer(bytes) ??
    manifestGame.get(memberName) ??
    detectGameIdFromFilename(captureFileName(memberName))
  );
}
export interface LapsZipDetection {
  isRaceIqArchive: boolean;
  captureCount: number;
  gameIds: GameId[];
}

/** Inspect archive contents without importing any captures. */
export function detectLapsZip(zipData: Uint8Array): LapsZipDetection {
  const files = unzipSync(zipData);
  const names = fileNamesForZip(files);
  const manifest = parseManifestFile(files);
  const manifestGame = new Map<string, GameId>();
  for (const entry of manifest?.entries ?? []) manifestGame.set(entry.file, entry.gameId);
  const gameIds = [...new Set(names.map((name) => parseCaptureGameId(name, Buffer.from(files[name]), manifestGame)).filter((gameId): gameId is GameId => gameId != null))];
  return { isRaceIqArchive: names.length > 0, captureCount: names.length, gameIds };
}

function selectedLapsBySession(
  rows: ReadonlyArray<RawLapRow>,
  wantedIds: ReadonlySet<number>,
): Map<number, RawLapRow[]> {
  const map = new Map<number, RawLapRow[]>();
  for (const row of rows) {
    if (!wantedIds.has(row.id)) continue;
    const sessionRows = map.get(row.sessionId);
    if (sessionRows) sessionRows.push(row);
    else map.set(row.sessionId, [row]);
  }
  return map;
}

function usableRawLaps(rows: RawLapRow[]): RawLapRow[] {
  return rows.filter(
    (row) => row.rawFile && row.rawByteOffset != null && (row.rawFrameCount ?? 0) > 0,
  );
}

/**
 * Re-encode decoder state immediately before a selected iRacing lap as a full
 * session frame. Delta frames then parse identically without earlier laps.
 */
function buildIRacingContextRecord(
  buf: Buffer,
  beforeOffset: number,
): Buffer | null {
  const state = createIRacingSourceDecoderState();
  let latest: IRacingSourceFrame | null = null;
  for (const record of iterateSessionCaptureRecords(buf)) {
    if (record.kind !== "frame") continue;
    if (record.offset >= beforeOffset && latest) break;
    const decoded = decodeIRacingSourceFrame(record.frame, state);
    if (decoded) latest = decoded;
    if (record.offset >= beforeOffset) break;
  }
  if (!latest) return null;
  const context = new IRacingSourceFrameEncoder().encode(latest);
  return Buffer.concat([encodeFrameLength(context.length), context]);
}

function iracingSegmentEnd(
  buf: Buffer,
  start: number,
  frameCount: number,
  sessionPrefix: Buffer | null,
): number {
  const state = createIRacingSourceDecoderState();
  const prefixFrame = sessionPrefix ? sessionFrameAt(sessionPrefix, 0) : null;
  if (prefixFrame) decodeIRacingSourceFrame(prefixFrame, state);

  let end = start;
  let seen = 0;
  let staleLastLap: number | undefined;
  for (const record of iterateSessionCaptureRecords(buf, start)) {
    if (record.kind !== "frame") continue;
    const decoded = decodeIRacingSourceFrame(record.frame, state);
    seen++;
    end = record.offset + 4 + record.frame.length;
    const lastLap = decoded?.values.LapLastLapTime;
    if (seen <= frameCount && typeof lastLap === "number") staleLastLap = lastLap;
    if (
      seen > frameCount &&
      typeof lastLap === "number" &&
      lastLap > 0 &&
      staleLastLap !== undefined &&
      Math.abs(lastLap - staleLastLap) > 0.000_1
    ) {
      return end;
    }
  }
  return end;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build a zip containing selected raw lap windows grouped by session.
 * Each selected lap gets one completion trigger; boundaries reset import state.
 */
export async function buildLapsZip(
  lapIds: number[],
): Promise<{ bytes: Uint8Array; manifest: LapsZipManifest }> {
  const wanted = new Set(lapIds);
  const allRows = await getLapsRaw();
  const sessions = selectedLapsBySession(allRows, wanted);
  if (sessions.size === 0) throw new Error("No laps matched the requested ids");

  const files: Record<string, Uint8Array> = {};
  const entries: ManifestEntry[] = [];
  for (const [sessionId, rows] of sessions) {
    const usable = usableRawLaps(rows).sort(
      (a, b) => (a.rawByteOffset as number) - (b.rawByteOffset as number),
    );
    if (usable.length === 0) continue;
    const first = usable[0]!;
    const buf = await readCapture(first.rawFile as string);
    if (!buf) continue;
    const segments: Buffer[] = [];
    for (const row of usable) {
      const start = row.rawByteOffset as number;
      if (start >= buf.length) continue;
      const frameCount = row.rawFrameCount as number;
      const prefix =
        first.gameId === "iracing"
          ? buildIRacingContextRecord(buf, start)
          : null;
      const end = first.gameId === "iracing"
        ? iracingSegmentEnd(buf, start, frameCount, prefix)
        : advanceSessionFrames(buf, start, frameCount + 1);
      segments.push(Buffer.concat([...(prefix ? [prefix] : []), buf.subarray(start, end)]));
    }
    if (segments.length === 0) continue;
    const gameId = first.gameId as GameId;
    const telemetry = Buffer.concat(
      segments.flatMap((segment) => [encodeSegmentBoundaryFrame(), segment]),
    );
    const slice = Buffer.concat([encodeMetaFrame(), telemetry]);
    const trackName = resolveTrackName(first.trackOrdinal ?? -1, gameId);
    const carName = resolveCarName(first.carOrdinal ?? -1, gameId);
    const fileName = `${gameId}-${slugify(trackName) || `track${first.trackOrdinal ?? 0}`}-session${sessionId}.bin.gz`;
    files[fileName] = gzipBufferSync(slice);
    entries.push({
      file: fileName, gameId, sessionId,
      carOrdinal: first.carOrdinal ?? 0, trackOrdinal: first.trackOrdinal ?? 0,
      carName, trackName, createdAt: first.createdAt,
      laps: usable.map((r) => ({ lapNumber: r.lapNumber, lapTime: r.lapTime, isValid: r.isValid })),
    });
  }
  if (entries.length === 0) {
    throw new Error("None of the selected laps have a raw capture available to export");
  }
  const manifest: LapsZipManifest = {
    version: LAPS_ZIP_VERSION, exportedAt: new Date().toISOString(), entries,
  };
  files[MANIFEST_FILE_NAME] = encodeManifestFile(manifest);
  const bytes = zipSync(files, { level: 6 });
  return { bytes, manifest };
}

/** `raceiq-<track>-<n>laps-<date>.zip`, or a generic name for a mixed export. */
export function lapsZipFilename(manifest: LapsZipManifest): string {
  const date = manifest.exportedAt.slice(0, 10);
  const lapCount = manifest.entries.reduce((sum, e) => sum + e.laps.length, 0);
  const tracks = new Set(manifest.entries.map((e) => e.trackName));
  const trackPart =
    tracks.size === 1 ? `${slugify(tracks.values().next().value as string)}-` : "";
  return `raceiq-${trackPart}${lapCount}lap${lapCount === 1 ? "" : "s"}-${date}.zip`;
}

export interface ImportZipResult {
  imported: number;
  skipped: number;
  laps: ImportedLap[];
  errors: string[];
}

/**
 * Import a zip produced by {@link buildLapsZip}: every `.bin`/`.bin.gz` member is
 * replayed through the pipeline, landing as a fresh session with its laps
 * re-detected. Duplicates are not merged — importing the same zip twice gives
 * you the laps twice, same as the single-file `.bin` import.
 */
export async function importLapsZip(zipData: Uint8Array, options: { ownership?: SessionOwnership } = {}): Promise<ImportZipResult> {
  const files = unzipSync(zipData);

  const manifest = parseManifestFile(files);
  const manifestGame = new Map<string, GameId>();
  for (const entry of manifest?.entries ?? []) manifestGame.set(entry.file, entry.gameId);

  const laps: ImportedLap[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const names = fileNamesForZip(files);

  if (names.length === 0) {
    throw new Error(
      "Zip contains no session captures (.bin/.bin.gz). Exports from an older RaceIQ version can't be imported."
    );
  }

  for (const name of names) {
    const memberBytes = files[name];
    const bytes = Buffer.from(
      memberBytes.buffer,
      memberBytes.byteOffset,
      memberBytes.byteLength,
    );
    const gameId = parseCaptureGameId(name, bytes, manifestGame);
    if (!gameId) {
      skipped++;
      errors.push(`${name}: could not determine which game this capture came from`);
      continue;
    }
    try {
      const result = await importSessionBin(bytes, gameId, { ownership: options.ownership });
      laps.push(...result.laps);
    } catch (err) {
      skipped++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported: laps.length, skipped, laps, errors };
}

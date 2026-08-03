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
import { getLapsRaw } from "../db/lap-read-queries";
import { resolveCarName } from "../../shared/car/resolve-name";
import { resolveTrackName } from "../../shared/track/resolve-name";
import {
  detectGameIdFromBuffer,
  detectGameIdFromFilename,
  importSessionBin,
} from "../session-capture/import-capture";
import type { ImportedLap } from "../session-capture/import-pipeline";
import {
  advanceSessionFrames,
  encodeMetaFrame,
  gzipBufferSync,
  gunzipBufferSync,
  readFrameStreamStart,
  sessionFrameAt,
} from "../session-capture/framing";
import { isIRacingSessionFrame } from "../games/iracing/source-frame";
import type { GameId } from "../../shared/games/ids";

/** Bumped when the zip layout changes in a way older readers can't handle. */
export const LAPS_ZIP_VERSION = 2;

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
 * iRacing value frames depend on the latest packed session frame. Exports can
 * begin at a later lap, so carry that one length-prefixed header record into
 * the slice instead of replaying every preceding telemetry frame.
 */
function latestIRacingSessionRecord(
  buf: Buffer,
  beforeOffset: number,
): Buffer | null {
  let offset = readFrameStreamStart(buf);
  let latest: Buffer | null = null;
  while (offset < beforeOffset) {
    const frame = sessionFrameAt(buf, offset);
    if (!frame) break;
    const recordEnd = offset + 4 + frame.length;
    if (recordEnd > beforeOffset) break;
    if (isIRacingSessionFrame(frame)) {
      latest = Buffer.from(buf.subarray(offset, recordEnd));
    }
    offset = recordEnd;
  }
  return latest;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build a zip containing the raw frames for the given laps, grouped by session.
 *
 * Per session the slice spans from the first selected lap's frames through the
 * last selected lap's frames *plus one trigger frame*, so the importing lap
 * detector sees the crossing that completes the final lap. Cherry-picking
 * non-adjacent laps therefore also carries the laps in between — a contiguous
 * frame stream is what makes the capture replayable, and the manifest lists
 * exactly what will come back.
 *
 * Laps with no raw capture (pre-migration rows, or a capture deleted off disk)
 * are skipped.
 */
export async function buildLapsZip(
  lapIds: number[]
): Promise<{ bytes: Uint8Array; manifest: LapsZipManifest }> {
  const wanted = new Set(lapIds);
  const allRows = await getLapsRaw();
  const sessions = selectedLapsBySession(allRows, wanted);
  if (sessions.size === 0) throw new Error("No laps matched the requested ids");

  const files: Record<string, Uint8Array> = {};
  const entries: ManifestEntry[] = [];

  for (const [sessionId, rows] of sessions) {
    const usable = usableRawLaps(rows);
    if (usable.length === 0) continue;

    const rawFile = usable[0].rawFile as string;
    const buf = await readCapture(rawFile);
    if (!buf) continue; // capture gone from disk — nothing to export for this session

    const first = usable[0];
    let startByte = first.rawByteOffset as number;
    let last = first;
    for (let i = 1; i < usable.length; i++) {
      const row = usable[i];
      const offset = row.rawByteOffset as number;
      if (offset < startByte) startByte = offset;
      if (offset > (last.rawByteOffset as number)) last = row;
    }
    if (startByte >= buf.length) continue;
    // +1 frame: the next-lap trigger that completes the final lap on replay.
    const endByte = advanceSessionFrames(
      buf,
      last.rawByteOffset as number,
      (last.rawFrameCount as number) + 1
    );

    const gameId = first.gameId as GameId;
    const firstFrame = sessionFrameAt(buf, startByte);
    const sessionPrefix =
      gameId === "iracing" &&
      firstFrame &&
      !isIRacingSessionFrame(firstFrame)
        ? latestIRacingSessionRecord(buf, startByte)
        : null;
    const telemetrySlice = buf.subarray(startByte, endByte);
    const slice = Buffer.concat(
      sessionPrefix
        ? [encodeMetaFrame(), sessionPrefix, telemetrySlice]
        : [encodeMetaFrame(), telemetrySlice],
    );

    const trackName = resolveTrackName(first.trackOrdinal ?? -1, gameId);
    const carName = resolveCarName(first.carOrdinal ?? -1, gameId);
    // Filename MUST start with `<gameId>-` so import can fall back to
    // filename-based game detection.
    const fileName = `${gameId}-${slugify(trackName) || `track${first.trackOrdinal ?? 0}`}-session${sessionId}.bin.gz`;

    files[fileName] = gzipBufferSync(slice);

    // Everything inside the exported span comes back on import — list it all.
    const covered = allRows
      .filter(
        (r) =>
          r.sessionId === sessionId &&
          r.rawByteOffset != null &&
          r.rawByteOffset >= startByte &&
          r.rawByteOffset < endByte
      )
      .sort((a, b) => a.lapNumber - b.lapNumber);

    entries.push({
      file: fileName,
      gameId,
      sessionId,
      carOrdinal: first.carOrdinal ?? 0,
      trackOrdinal: first.trackOrdinal ?? 0,
      carName,
      trackName,
      createdAt: first.createdAt,
      laps: covered.map((r) => ({
        lapNumber: r.lapNumber,
        lapTime: r.lapTime,
        isValid: r.isValid,
      })),
    });
  }

  if (entries.length === 0) {
    throw new Error("None of the selected laps have a raw capture available to export");
  }

  const manifest: LapsZipManifest = {
    version: LAPS_ZIP_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  };
  files[MANIFEST_FILE_NAME] = encodeManifestFile(manifest);

  // level 0 for the .bin.gz members (already gzip'd), default for the manifest.
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
export async function importLapsZip(zipData: Uint8Array): Promise<ImportZipResult> {
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
      const result = await importSessionBin(bytes, gameId);
      laps.push(...result.laps);
    } catch (err) {
      skipped++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported: laps.length, skipped, laps, errors };
}

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
 *   <gameId>-<track>-session<id>.motec.zip     — one complete MoTeC source archive per session
 */
import { zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps as storedLaps } from "@raceiq/backend-core/db/schema";
import { LAPS_ZIP_LIMITS, unzipBounded } from "@raceiq/backend-core/archive/bounded-unzip";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import { getLapsRaw } from "@raceiq/backend-core/db/lap-read-queries";
import { resolveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { loadSessionCapture } from "@raceiq/backend-core/session-capture/source-loader";
import { getLiveLapCaptureSnapshot } from "@raceiq/backend-core/db/live-capture-queries";
import { resolveLiveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { encodeLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";
import { LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC } from "@raceiq/capture-formats/kunos/pack-triplet";
import { encodeKunosSparseFrame } from "@raceiq/capture-formats/session/kunos-sparse";
import { encodeGenericSparseFrame, genericFrameIdentity } from "@raceiq/capture-formats/session/generic-sparse";
import { KNOWN_GAME_IDS } from "@raceiq/shared/games/ids";
import { isCatalogCarId, isCatalogTrackId } from "../games/session-identity";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { extractMotecArchive } from "@raceiq/backend-core/motec/import-staging";
import { importMotec } from "@raceiq/backend-core/motec/import";
import {
  detectGameIdFromBuffer,
  detectGameIdFromFilename,
  importSessionBin,
} from "@raceiq/backend-core/session-capture/import-capture";
import type { ImportedLap } from "@raceiq/backend-core/session-capture/import-pipeline";
import {
  META_FRAME_MAGIC,
  PARSER_BOOTSTRAP_MAGIC,
  SEGMENT_BOUNDARY_MAGIC,
  SEGMENT_CONTEXT_END_MAGIC,
  SEGMENT_CONTEXT_MAGIC,
  SEGMENT_BOUNDARY_VERSION,
  SPARSE_CAPTURE_FORMAT_VERSION,
  SPARSE_CAPTURE_FORMAT_MAGIC,
  readFramePrefix,
  encodeFrameLength,
  encodeMetaFrame,
  encodeParserBootstrapFrame,
  encodeSparseCaptureFormatFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
  gzipBufferSync,
  iterateSessionCaptureRecords,
  iterateSessionFrameRecords,
  type SessionCaptureRecord,
  sessionFrameAt,
} from "@raceiq/capture-formats/session/framing";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  IRacingSourceFrameEncoder,
  type IRacingSourceDecoderState,
  type IRacingSourceFrame,
} from "@raceiq/capture-formats/iracing/source-frame";
import { parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import type { GameId } from "@raceiq/shared/games/ids";
import { getServerGame } from "@raceiq/backend-core/games/registry";
export const LAPS_ZIP_VERSION = 4;

export interface ManifestLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
}

export interface ManifestEntry {
  /** Zip entry name holding this session's gzip'd frame slice or MoTeC source archive. */
  file: string;
  gameId: GameId;
  /** Session id in the *source* database (informational — import always creates a new session). */
  sessionId: number;
  carId: string;
  trackId: string;
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
async function readCapture(row: RawLapRow): Promise<Buffer | null> {
  try {
    if (!row.rawFile) return null;
    return await loadSessionCapture({
      rawFile: row.rawFile, source: row.source ?? null, gameId: row.gameId as GameId,
      carId: row.carId, trackId: row.trackId,
    });
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
    .filter((name) => name.endsWith(".bin") || name.endsWith(".bin.gz") || name.endsWith(".motec.zip"))
    .sort();
}

function parseCaptureGameId(
  memberName: string,
  bytes: Buffer,
  manifestGame: ReadonlyMap<string, GameId>,
): GameId | null {
  const gameId = (
    detectGameIdFromBuffer(bytes) ??
    manifestGame.get(memberName) ??
    detectGameIdFromFilename(captureFileName(memberName))
  );
  return gameId && KNOWN_GAME_IDS.includes(gameId) ? gameId : null;
}
export interface MissingMotecIdentity {
  file: string;
  gameId: GameId | null;
  carId: string | null;
  trackId: string | null;
  unsupported: boolean;
}

export interface LapsZipDetection {
  isRaceIqArchive: boolean;
  captureCount: number;
  gameIds: GameId[];
  missingMotecIdentities: MissingMotecIdentity[];
}

/** Inspect archive contents without importing any captures. */
export function detectLapsZip(zipData: Uint8Array): LapsZipDetection {
  const files = unzipBounded(zipData, LAPS_ZIP_LIMITS);
  const names = fileNamesForZip(files);
  const manifest = parseManifestFile(files);
  const manifestEntries = new Map((manifest?.entries ?? []).map((entry) => [entry.file, entry]));
  const manifestGame = new Map<string, GameId>();
  for (const entry of manifest?.entries ?? []) manifestGame.set(entry.file, entry.gameId);
  const gameIds = [...new Set(names.map((name) => parseCaptureGameId(name, Buffer.from(files[name]), manifestGame)).filter((gameId): gameId is GameId => gameId != null))];
  const missingMotecIdentities = names.flatMap<MissingMotecIdentity>((file) => {
    if (!file.endsWith(".motec.zip")) return [];
    const entry = manifestEntries.get(file);
    if (!entry || !KNOWN_GAME_IDS.includes(entry.gameId)) return [{ file, gameId: null, carId: null, trackId: null, unsupported: true }];
    const carId = typeof entry.carId === "string" && isCatalogCarId(entry.gameId, entry.carId) ? entry.carId : null;
    const trackId = typeof entry.trackId === "string" && isCatalogTrackId(entry.gameId, entry.trackId) ? entry.trackId : null;
    return carId && trackId ? [] : [{ file, gameId: entry.gameId, carId, trackId, unsupported: false }];
  });
  return { isRaceIqArchive: names.length > 0, captureCount: names.length, gameIds, missingMotecIdentities };
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
    (row) => row.captureLayoutVersion != null ||
      (row.rawFile && row.rawByteOffset != null && (row.rawFrameCount ?? 0) > 0),
  );
}

/**
 * Re-encode decoder state immediately before a selected iRacing lap as a full
 * session frame. Delta frames then parse identically without earlier laps.
 */
function restoreIRacingSourceState(payload: Buffer): IRacingSourceDecoderState {
  const game = getServerGame("iracing");
  if (!game.restoreParserCheckpoint) throw new Error("iRacing parser checkpoint restore unavailable");
  const restored = game.restoreParserCheckpoint(game.createParserState(), payload);
  if (typeof restored !== "object" || restored === null || !("source" in restored)) {
    throw new Error("iRacing parser checkpoint did not restore source decoder state");
  }
  const source = restored.source;
  if (typeof source !== "object" || source === null || !("session" in source) ||
      !("variables" in source) || !("values" in source)) {
    throw new Error("iRacing parser checkpoint did not restore source decoder state");
  }
  return source as IRacingSourceDecoderState;
}

function buildIRacingContextRecord(
  buf: Buffer,
  beforeOffset: number,
): Buffer | null {
  let state = createIRacingSourceDecoderState();
  const game = getServerGame("iracing");
  if (!game.restoreParserCheckpoint) throw new Error("iRacing parser checkpoint restore unavailable");
  let latest: IRacingSourceFrame | null = null;
  let latestFrameTimeMs: number | undefined;
  for (const record of iterateSessionCaptureRecords(buf)) {
    if (record.offset >= beforeOffset) break;
    if (record.kind === "parser-bootstrap") {
      if (record.gameId !== "iracing") throw new Error("Incompatible iRacing parser bootstrap");
      state = restoreIRacingSourceState(record.payload);
      latest = null;
      continue;
    }
    if (record.kind !== "frame") continue;
    const decoded = decodeIRacingSourceFrame(record.frame, state);
    if (decoded) {
      latest = decoded;
      latestFrameTimeMs = record.frameTimeMs;
    }
  }
  if (!latest) return null;
  const context = new IRacingSourceFrameEncoder().encode(latest);
  return Buffer.concat([encodeFrameLength(context.length, latestFrameTimeMs), context]);
}
function buildF1ContextRecords(
  buf: Buffer,
  beforeOffset: number,
): { bootstrap: Buffer | null; records: Buffer[] } {
  const priorRecords = [...iterateSessionCaptureRecords(buf)].filter((record) => record.offset < beforeOffset);
  const selected = priorRecords.findLast((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> =>
    record.kind === "frame",
  ) ?? [...iterateSessionCaptureRecords(buf, beforeOffset)].find((record): record is Extract<SessionCaptureRecord, { kind: "frame" }> =>
    record.kind === "frame",
  );
  const sessionUID = selected ? parseF1Header(selected.frame).sessionUID : null;
  if (!sessionUID) return { bootstrap: null, records: [] };
  let bootstrap: Buffer | null = null;
  let records: Buffer[] = [];
  for (const record of priorRecords) {
    if (record.kind === "segment-boundary") {
      bootstrap = null;
      records = [];
      continue;
    }
    if (record.kind === "parser-bootstrap") {
      if (record.gameId !== "f1-2025") throw new Error("Incompatible F1 parser bootstrap");
      bootstrap = encodeParserBootstrapFrame(record.gameId, record.payload);
      records = [];
      continue;
    }
    if (record.kind !== "frame") continue;
    if (parseF1Header(record.frame).sessionUID !== sessionUID) continue;
    records.push(Buffer.concat([
      encodeFrameLength(record.frame.length, record.frameTimeMs),
      record.frame,
    ]));
  }
  return { bootstrap, records };
}
function iracingSegmentEnd(
  buf: Buffer,
  start: number,
  frameCount: number,
  sessionPrefix: Buffer | null,
  parserBootstrap: Buffer | null,
): number {
  let state = createIRacingSourceDecoderState();
  if (parserBootstrap) {
    for (const record of iterateSessionCaptureRecords(parserBootstrap)) {
      if (record.kind === "parser-bootstrap") state = restoreIRacingSourceState(record.payload);
    }
  }
  const prefixFrame = sessionPrefix ? sessionFrameAt(sessionPrefix, 0) : null;
  if (prefixFrame) decodeIRacingSourceFrame(prefixFrame, state);
  let end = start;
  let seen = 0;
  let staleLastLap: number | undefined;
  for (const record of iterateSessionCaptureRecords(buf, start)) {
    if (record.kind === "segment-boundary") return end;
    if (record.kind !== "frame") continue;
    const decoded = decodeIRacingSourceFrame(record.frame, state);
    seen++;
    end = record.endOffset;
    const lastLap = decoded?.values.LapLastLapTime;
    if (seen <= frameCount && typeof lastLap === "number") staleLastLap = lastLap;
    if (seen > frameCount && typeof lastLap === "number" && lastLap > 0 && staleLastLap !== undefined && Math.abs(lastLap - staleLastLap) > 0.000_1) return end;
  }
  return end;
}
function buildParserContextRecords(buf: Buffer, beforeOffset: number): Buffer[] {
  const context: Buffer[] = [];
  for (const record of iterateSessionCaptureRecords(buf)) {
    if (record.offset >= beforeOffset) break;
    if (record.kind === "segment-boundary" || record.kind === "parser-bootstrap") {
      context.length = 0;
    } else if (record.kind === "frame") {
      context.push(Buffer.concat([encodeFrameLength(record.frame.length, record.frameTimeMs), record.frame]));
    }
  }
  return context;
}



function firstFrameOffsetAcrossContext(buf: Buffer, offset: number): number | null {
  let at = offset;
  while (at + 4 <= buf.length) {
    if (buf.readUInt32LE(at) === META_FRAME_MAGIC) {
      if (at + 8 > buf.length) return null;
      const size = buf.readUInt32LE(at + 4);
      const payloadEnd = at + 8 + size;
      if (size > 16 * 1024 * 1024 || payloadEnd > buf.length) return null;
      if (size === 8) {
        const magic = buf.readUInt32LE(at + 8);
        const version = buf.readUInt32LE(at + 12);
        if (magic === SEGMENT_BOUNDARY_MAGIC && version === SEGMENT_BOUNDARY_VERSION) return null;
        if (magic !== SEGMENT_CONTEXT_MAGIC && magic !== SEGMENT_CONTEXT_END_MAGIC &&
            !(magic === SPARSE_CAPTURE_FORMAT_MAGIC && version === SPARSE_CAPTURE_FORMAT_VERSION)) return null;
      } else if (size === 4 && at === 0) {
        at = payloadEnd;
        continue;
      } else if (size >= 4 && buf.readUInt32LE(at + 8) === PARSER_BOOTSTRAP_MAGIC) return null;
      else return null;
      at = payloadEnd;
      continue;
    }
    const prefix = readFramePrefix(buf, at);
    if (!prefix || prefix.length === 0 || at + prefix.prefixBytes + prefix.length > buf.length) return null;
    return at;
  }
  return null;
}
/** Re-encode lap frames with segment-local checkpoints and source identities. */
function sparseLapRecords(
  buf: Buffer,
  start: number,
  end: number,
  gameId: GameId,
  includeFormatMarker: boolean,
): Buffer[] {
  const parts: Buffer[] = [];
  let previous: Buffer | null = null;
  let checkpoint = 0;
  let outputOffset = 0;
  let emitted = 0;
  const firstFrameOffset = firstFrameOffsetAcrossContext(buf, start);
  if (firstFrameOffset === null) return parts;
  for (const record of iterateSessionFrameRecords(buf, firstFrameOffset)) {
    if (record.offset >= end) break;
    const isLmuV2 = gameId === "lmu" && record.frame.length === LMU_SOURCE_FRAME_V2_SIZE &&
      record.frame.subarray(0, LMU_SOURCE_FRAME_MAGIC.length).equals(LMU_SOURCE_FRAME_MAGIC);
    const magic = record.frame.length >= 4 ? record.frame.readUInt32LE(0) : 0;
    const isKunos = (gameId === "acc" && magic === ACC_PACKED_MAGIC) ||
      (gameId === "ac-evo" && magic === ACEVO_PACKED_MAGIC);
    const supportsGeneric = gameId === "fm-2023" || gameId === "f1-2025" || gameId === "iracing";
    const identity = supportsGeneric ? genericFrameIdentity(record.frame) : null;
    const canDelta = isLmuV2 || isKunos || identity !== null;
    const previousLength = previous?.length;
    const sameIdentity = previous !== null && (
      (isLmuV2 && previousLength === record.frame.length) ||
      (isKunos && previousLength === record.frame.length) ||
      (identity !== null && genericFrameIdentity(previous) === identity)
    );
    let frame = record.frame;
    let full = !canDelta || !sameIdentity || emitted % 128 === 0;
    if (!full) {
      if (isLmuV2) frame = encodeLmuSparseFrame(record.frame, previous!, outputOffset - checkpoint);
      else if (isKunos) frame = encodeKunosSparseFrame(record.frame, previous!, outputOffset - checkpoint);
      else {
        const sparse = encodeGenericSparseFrame(record.frame, previous!, outputOffset - checkpoint);
        if (sparse.length < record.frame.length) frame = sparse;
        else full = true;
      }
    }
    if (full) {
      frame = record.frame;
      checkpoint = outputOffset;
    }
    const prefix = encodeFrameLength(frame.length, record.frameTimeMs);
    parts.push(prefix, frame);
    outputOffset += prefix.length + frame.length;
    if (includeFormatMarker && emitted === 0) {
      const marker = encodeSparseCaptureFormatFrame();
      parts.push(marker);
      outputOffset += marker.length;
    }
    previous = canDelta ? record.frame : null;
    emitted++;
  }
  return parts;
}
function advanceLapFramesAcrossContext(buf: Buffer, offset: number, count: number): number {
  const firstFrameOffset = firstFrameOffsetAcrossContext(buf, offset);
  if (firstFrameOffset === null) return offset;
  let advanced = 0;
  let end = offset;
  for (const record of iterateSessionCaptureRecords(buf, firstFrameOffset)) {
    if (record.kind === "segment-boundary" || record.kind === "parser-bootstrap") break;
    if (record.kind !== "frame") continue;
    end = record.endOffset;
    if (++advanced === count) break;
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
  if (sessions.size === 0) {
    throw new Error("No laps matched");
  }
  const files: Record<string, Uint8Array> = {};
  const entries: ManifestEntry[] = [];
  for (const [sessionId, rows] of sessions) {
    for (const row of rows) {
      if (row.captureLayoutVersion != null && row.captureLayoutVersion !== 1 && row.captureLayoutVersion !== 2 && row.captureLayoutVersion !== 3) {
        throw new Error(`Unsupported capture layout version ${row.captureLayoutVersion} for lap ${row.id}`);
      }
      if ((row.captureLayoutVersion === 1 || row.captureLayoutVersion === 2) && (!row.captureManifestFile || !row.captureChunkId || (row.captureLayoutVersion === 2 && !row.captureArchiveFile))) {
        throw new Error(`Published capture layout for lap ${row.id} has incomplete capture references`);
      }
    }
    const firstSelected = rows[0]!;
    const isMotec = rows.some((row) => row.source === "motec" || row.rawFile?.endsWith(".motec.zip"));
    if (isMotec && rows.some((row) => row.captureLayoutVersion != null)) {
      throw new Error("Published MoTeC capture layouts cannot be exported as source archives");
    }
    if (isMotec) {
      const first = allRows.find((row) => row.sessionId === sessionId) ?? firstSelected;
      const rawFile = first.rawFile;
      let sourceBytes: Buffer;
      try {
        sourceBytes = rawFile ? await readFile(rawFile) : Buffer.alloc(0);
      } catch {
        sourceBytes = Buffer.alloc(0);
      }
      if (sourceBytes.byteLength === 0) {
        throw new Error("MoTeC source archive is missing on disk");
      }
      const gameId = first.gameId as GameId;
      const trackName = resolveTrackName(first.trackId ?? "", gameId);
      const carName = resolveCarName(first.carId ?? "", gameId);
      const fileName = `${gameId}-${slugify(trackName) || `track${first.trackId ?? ""}`}-session${sessionId}.motec.zip`;
      files[fileName] = sourceBytes;
      const sourceLaps = allRows
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.lapNumber - b.lapNumber);
      entries.push({
        file: fileName, gameId, sessionId,
        carId: first.carId ?? "", trackId: first.trackId ?? "",
        carName, trackName, createdAt: first.createdAt,
        laps: sourceLaps.map((r) => ({ lapNumber: r.lapNumber, lapTime: r.lapTime, isValid: r.isValid })),
      });
      continue;
    }
    const usable = usableRawLaps(rows).sort((a, b) => (a.rawByteOffset ?? 0) - (b.rawByteOffset ?? 0));
    if (usable.length === 0) continue;
    const first = usable[0]!;
    const segments: Buffer[] = [];
    let sparseFormatMarkerWritten = false;
    for (const row of usable) {
      let buf: Buffer | null;
      let start: number;
      let frameCount: number;
      let parserBootstrap: Buffer | null = null;
      let trailingContextFrameCount = 0;
      if (row.captureLayoutVersion === 3) {
        const live = await getLiveLapCaptureSnapshot(row.sessionId, row.id);
        if (!live) throw new Error(`Live lap capture member for lap ${row.id} is not committed`);
        const artifact = resolveLiveLapCaptureArtifact(live.archivePath, live.snapshot);
        buf = await loadSessionCapture({ rawFile: artifact.path, artifact: artifact.artifact, source: null, gameId: first.gameId as GameId, carId: first.carId, trackId: first.trackId });
        start = artifact.chunk.ownedFrameByteOffset!;
        frameCount = artifact.chunk.ownedFrameCount!;
        trailingContextFrameCount = artifact.chunk.trailingContextFrameCount ?? 0;
      } else if (row.captureLayoutVersion === 1 || row.captureLayoutVersion === 2) {
        const artifact = await resolveLapCaptureArtifact(row.captureManifestFile!, row.captureChunkId!, row.id, row);
        buf = await loadSessionCapture({ rawFile: artifact.path, artifact: artifact.artifact, source: null, gameId: first.gameId as GameId, carId: first.carId, trackId: first.trackId });
        start = artifact.chunk.ownedFrameByteOffset!;
        frameCount = artifact.chunk.ownedFrameCount!;
        trailingContextFrameCount = artifact.chunk.trailingContextFrameCount ?? 0;
        // Bootstrap and context are extracted uniformly from the selected source below.
      } else {
        buf = await readCapture(row);
        start = row.rawByteOffset!;
        frameCount = row.rawFrameCount!;
      }
      if (!buf || start >= buf.length) continue;
      for (const record of iterateSessionCaptureRecords(buf)) {
        if (record.offset >= start) break;
        if (record.kind === "segment-boundary") parserBootstrap = null;
        if (record.kind === "parser-bootstrap") {
          if (record.gameId !== first.gameId) throw new Error("Parser bootstrap does not match archive game");
          parserBootstrap = encodeParserBootstrapFrame(record.gameId, record.payload);
        }
      }
      const prefix =
        first.gameId === "iracing" && !parserBootstrap
          ? buildIRacingContextRecord(buf, start)
          : null;
      const f1Context = first.gameId === "f1-2025" ? buildF1ContextRecords(buf, start) : null;
      if (f1Context) parserBootstrap = f1Context.bootstrap;
      const context = f1Context?.records ?? (first.gameId === "ac-evo"
        ? buildParserContextRecords(buf, start)
        : []);
      const ownedEnd = advanceLapFramesAcrossContext(buf, start, frameCount);
      if (row.captureLayoutVersion == null) {
        const adjacentWindow = allRows.some((candidate) => candidate.sessionId === row.sessionId && candidate.rawByteOffset === ownedEnd);
        trailingContextFrameCount =
          adjacentWindow ||
          getServerGame(first.gameId as GameId).appendsDelayedFinishFrame ||
          advanceLapFramesAcrossContext(buf, ownedEnd, 1) > ownedEnd
            ? 1
            : 0;
      }
      const end = first.gameId === "iracing"
        ? iracingSegmentEnd(buf, start, frameCount, prefix, parserBootstrap)
        : advanceLapFramesAcrossContext(buf, start, frameCount + trailingContextFrameCount);
      const trailingContext = end > ownedEnd ? sparseLapRecords(buf, ownedEnd, end, first.gameId as GameId, false) : [];
      const sparseRecords = first.gameId === "lmu" || first.gameId === "acc" || first.gameId === "ac-evo" ||
        first.gameId === "fm-2023" || first.gameId === "f1-2025" || first.gameId === "iracing"
        ? sparseLapRecords(buf, start, ownedEnd, first.gameId as GameId, !sparseFormatMarkerWritten)
        : [buf.subarray(start, ownedEnd)];
      if (sparseRecords.length > 0) sparseFormatMarkerWritten = true;
      segments.push(Buffer.concat([
        encodeSegmentBoundaryFrame(),
        ...(parserBootstrap ? [parserBootstrap] : []),
        ...(context.length > 0
          ? [encodeSegmentContextFrame(), ...context, encodeSegmentContextEndFrame()]
          : []),
        ...(prefix ? [prefix] : []),
        ...sparseRecords,
        ...(trailingContext.length > 0
          ? [encodeSegmentContextFrame(), ...trailingContext, encodeSegmentContextEndFrame()]
          : []),
      ]));
    }
    if (segments.length === 0) continue;
    const gameId = first.gameId as GameId;
    const slice = Buffer.concat([encodeMetaFrame(), ...segments]);
    const trackName = resolveTrackName(first.trackId ?? "", gameId);
    const carName = resolveCarName(first.carId ?? "", gameId);
    const fileName = `${gameId}-${slugify(trackName) || `track${first.trackId ?? ""}`}-session${sessionId}.bin.gz`;
    files[fileName] = gzipBufferSync(slice);
    entries.push({
      file: fileName, gameId, sessionId,
      carId: first.carId ?? "", trackId: first.trackId ?? "",
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
export async function importLapsZip(zipData: Uint8Array, options: { ownership?: SessionOwnership; identityOverrides?: Record<string, { carId: string; trackId: string }> } = {}): Promise<ImportZipResult> {
  const files = unzipBounded(zipData, LAPS_ZIP_LIMITS);
  const manifest = parseManifestFile(files);

  const manifestEntries = new Map<string, ManifestEntry>();
  for (const entry of manifest?.entries ?? []) manifestEntries.set(entry.file, entry);
  const laps: ImportedLap[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const names = fileNamesForZip(files);

  if (names.length === 0) {
    throw new Error(
      "Zip contains no session captures (.bin/.bin.gz/.motec.zip). Exports from an older RaceIQ version can't be imported."
    );
  }

  for (const name of names) {
    const memberBytes = files[name];
    const bytes = Buffer.from(
      memberBytes.buffer,
      memberBytes.byteOffset,
      memberBytes.byteLength,
    );
    const entry = manifestEntries.get(name);
    if (name.endsWith(".motec.zip")) {
      if (!entry) {
        skipped++;
        errors.push(`${name}: missing MoTeC manifest metadata`);
        continue;
      }
      try {
        const extracted = extractMotecArchive(bytes);
        const override = options.identityOverrides?.[name];
        const carId = override?.carId ?? entry.carId;
        const trackId = override?.trackId ?? entry.trackId;
        if (!carId || !trackId || !isCatalogCarId(entry.gameId, carId) || !isCatalogTrackId(entry.gameId, trackId)) {
          throw new Error("MoTeC car and track must resolve in current game catalogs");
        }
        const result = await importMotec(extracted.ldBytes, extracted.ldxBytes, {
          gameId: entry.gameId,
          carId,
          trackId,
          ownership: options.ownership,
        });
        laps.push(...result.laps);
      } catch (err) {
        skipped++;
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    try {
      const gameId = parseCaptureGameId(name, bytes, new Map(
        entry ? [[name, entry.gameId]] : [],
      ));
      if (!gameId) {
        skipped++;
        errors.push(`${name}: could not determine which game this capture came from`);
        continue;
      }
      const result = await importSessionBin(bytes, gameId, {
        ownership: options.ownership,
        onImportedLaps: entry && Array.isArray(entry.laps) ? async (imported) => {
          await db.transaction(async (tx) => {
            for (const lap of imported) {
              const matches = entry.laps.filter((metadata) => metadata.lapNumber === lap.lapNumber);
              if (matches.length !== 1) continue;
              const metadata = matches[0]!;
              if (!Number.isFinite(metadata.lapTime) || metadata.lapTime < 0 || typeof metadata.isValid !== "boolean") {
                throw new Error("Invalid exported lap timing or validity");
              }
              // Detector owns frame windows; archive metadata preserves saved timing/validity,
              // including delayed SDK finish timing absent from the selected native artifact.
              await tx.update(storedLaps).set({ lapTime: metadata.lapTime, isValid: metadata.isValid, ...(metadata.isValid ? { invalidReason: null } : {}) })
                .where(eq(storedLaps.id, lap.lapId)).run();
              lap.lapTime = metadata.lapTime;
              lap.isValid = metadata.isValid;
            }
          });
        } : undefined,
      });
      laps.push(...result.laps);
    } catch (err) {
      skipped++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { imported: laps.length, skipped, laps, errors };
}

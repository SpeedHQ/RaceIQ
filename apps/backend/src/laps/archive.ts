/**
 * Lap / session ZIP export + import.
 *
 * IBT source sessions export their complete original file; BIN captures export
 * selected frame windows. Imports reuse the production MoTeC and IBT pipelines
 * or the normal BIN importer, preserving each source's native representation.
 *
 * Zip layout:
 *   manifest.json                              — describes every entry
 *   <gameId>-<track>-session<id>.bin.gz        — one gzip'd frame slice per session
 *   <gameId>-<track>-session<id>.motec.zip     — one complete MoTeC source archive per session
 *   iracing-<track>-session<id>.ibt             — one original iRacing IBT per session
 */
import { zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { withDatabaseWrite } from "@raceiq/backend-core/db/write-coordination";
import { laps as storedLaps } from "@raceiq/backend-core/db/schema";
import { LAPS_ZIP_LIMITS, unzipBounded } from "@raceiq/backend-core/archive/bounded-unzip";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import { getLapsRaw } from "@raceiq/backend-core/db/lap-read-queries";
import { resolveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { loadSessionCapture } from "@raceiq/backend-core/session-capture/source-loader";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { getLiveLapCaptureSnapshot } from "@raceiq/backend-core/db/live-capture-queries";
import { resolveLiveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { getLMUPartitionKey, partitionLMUSourceFrame, restoreLMUSourceFrame, isLMUPartitionPrimary, isLMUPartitionCompanion } from "@raceiq/capture-formats/lmu/partition";
import { decodeLmuSparseFrame, encodeLmuSparseFrame, isLmuSparseFrame, lmuSparseSourceIdentity } from "@raceiq/capture-formats/session/lmu-sparse";
import { canHandleLMUSourceFrame, decodeLMUSourceFrame, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { ACC_PACKED_MAGIC, ACEVO_PACKED_MAGIC } from "@raceiq/capture-formats/kunos/pack-triplet";
import { encodeKunosSparseFrame } from "@raceiq/capture-formats/session/kunos-sparse";
import { decodeGenericSparseFrame, encodeGenericSparseFrame, genericFrameIdentity, isGenericSparseFrame } from "@raceiq/capture-formats/session/generic-sparse";
import { KNOWN_GAME_IDS } from "@raceiq/shared/games/ids";
import { isCatalogCarId, isCatalogTrackId } from "../games/session-identity";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { extractMotecArchive } from "@raceiq/backend-core/motec/import-staging";
import { importMotec } from "@raceiq/backend-core/motec/import";
import { getLmuOpponentLapForExport } from "@raceiq/backend-core/lap-analysis/lmu-opponent-laps";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
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
  decompressIfGzipSync,
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
import { commitStagedIbt, stageIbtUpload } from "../imports/iracing-ibt";
export const LAPS_ZIP_VERSION = 4;

export interface ManifestLap {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
}

export interface ManifestEntry {
  /** Session source bytes: gzip'd frame slice, MoTeC archive, or original IBT. */
  file: string;
  gameId: GameId;
  /** Session id in the *source* database (informational — import always creates a new session). */
  sessionId: number;
  carId: string;
  trackId: string;
  carName: string;
  trackName: string;
  createdAt: string;
  /** Explicit retention state; absent means legacy/unknown. */
  opponentRetention?: "retained" | "removed" | "not-recorded";
  opponentCompanionFile?: string;
  opponentLap?: {
    opponentLapId: string;
    sourceRevision: string;
    coverage: "complete" | "partial";
    frames: Array<{ captureSequence: string; frameTime: number; parserBootstrap: string | null }>;
  };
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
    .filter((name) => name.endsWith(".bin") || name.endsWith(".bin.gz") || name.endsWith(".motec.zip") || name.toLowerCase().endsWith(".ibt"))
    .filter((name) => !name.endsWith(".opponents.bin.gz") &&
      (name.endsWith(".bin") || name.endsWith(".bin.gz") || name.endsWith(".motec.zip")))
    .sort();
}
function hasPartitionPrimary(bytes: Buffer): boolean {
  let previousPrimary: Buffer | null = null;
  for (const record of iterateSessionCaptureRecords(bytes, undefined, { strict: true })) {
    if (record.kind === "segment-boundary") previousPrimary = null;
    if (record.kind !== "frame") continue;
    let frame = record.frame;
    if (isLmuSparseFrame(frame)) {
      if (!previousPrimary) throw new Error("Retained archive lost its LMU primary checkpoint");
      frame = decodeLmuSparseFrame(frame, previousPrimary);
    }
    if (isLMUPartitionPrimary(frame)) return true;
    previousPrimary = isLMUPartitionPrimary(frame) ? frame : null;
  }
  return false;
}
function isLegacyPlayerOnlyLmuCapture(bytes: Buffer): boolean {
  let sawFrame = false;
  let previous: Buffer | null = null;
  for (const record of iterateSessionCaptureRecords(bytes, undefined, { strict: true })) {
    if (record.kind === "segment-boundary") previous = null;
    if (record.kind !== "frame") continue;
    let frame = record.frame;
    if (isLmuSparseFrame(frame)) {
      if (!previous) return false;
      frame = decodeLmuSparseFrame(frame, previous);
    } else if (isGenericSparseFrame(frame)) {
      if (!previous) return false;
      frame = decodeGenericSparseFrame(frame, previous);
    }
    previous = frame;
    if (!canHandleLMUSourceFrame(frame)) continue;
    sawFrame = true;
    const version = frame.readUInt16LE(8);
    if (version !== 1 && version !== 4) return false;
  }
  return sawFrame;
}
function joinArchiveOpponentCompanion(primaryCapture: Buffer, companionCapture: Buffer): Buffer {
  const companions = new Map<string, { frame: Buffer; timestamp: number | undefined }>();
  for (const record of iterateSessionCaptureRecords(companionCapture, undefined, { strict: true })) {
    if (record.kind !== "frame") continue;
    if (!isLMUPartitionCompanion(record.frame)) throw new Error("Opponent companion contains a non-companion frame");
    const key = getLMUPartitionKey(record.frame);
    if (!key || companions.has(key)) throw new Error("Opponent companion contains duplicate or unidentified LMU frames");
    companions.set(key, { frame: record.frame, timestamp: record.frameTimeMs });
  }
  const parts = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
  const associated = new Set<string>();
  let previousPrimary: Buffer | null = null;
  for (const record of iterateSessionCaptureRecords(primaryCapture, undefined, { strict: true })) {
    if (record.kind !== "frame") {
      if (record.kind === "segment-boundary") previousPrimary = null;
      parts.push(primaryCapture.subarray(record.offset, record.endOffset));
      continue;
    }
    let primary = record.frame;
    if (isLmuSparseFrame(primary)) {
      if (!previousPrimary) throw new Error("Retained archive lost its LMU primary checkpoint");
      primary = decodeLmuSparseFrame(primary, previousPrimary);
    }
    let frame = primary;
    if (isLMUPartitionPrimary(primary)) {
      const key = getLMUPartitionKey(primary);
      const companion = key ? companions.get(key) : undefined;
      if (!companion) {
        throw new Error(`Retained archive is missing LMU opponent companion frame for partition ${key ?? "<unidentified>"}`);
      }
      if (companion.timestamp !== record.frameTimeMs) {
        throw new Error(
          `Retained archive has LMU opponent companion timestamp mismatch for partition ${key}: primary ${record.frameTimeMs}, companion ${companion.timestamp}`,
        );
      }
      if (associated.has(key!)) {
        throw new Error(`Retained archive has duplicate associated LMU primary identity for partition ${key}`);
      }
      associated.add(key!);
      frame = restoreLMUSourceFrame(primary, companion.frame);
      previousPrimary = primary;
    } else {
      previousPrimary = null;
    }
    parts.push(encodeFrameLength(frame.length, record.frameTimeMs), frame);
  }
  if (associated.size !== companions.size) throw new Error("Opponent companion contains unassociated LMU frames");
  return Buffer.concat(parts);
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
function lmuAcquisitionKey(sourceFrame: Buffer): string | null {
  const identity = decodeLMUSourceFrame(sourceFrame)?.lmuContext?.key;
  return identity ? JSON.stringify([identity.sessionKey, identity.captureSequence]) : null;
}
/** Re-encode lap frames with segment-local checkpoints and source identities. */
function sparseLapRecords(
  buf: Buffer,
  start: number,
  end: number,
  gameId: GameId,
  includeFormatMarker: boolean,
  companions?: Map<string, { frame: Buffer; timestamp: number | undefined }>,
  emittedLmuIdentities?: Set<string>,
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
    const isLmu = gameId === "lmu" && record.frame.length >= LMU_SOURCE_FRAME_V2_SIZE &&
      canHandleLMUSourceFrame(record.frame);
    const partition = isLmu ? partitionLMUSourceFrame(record.frame) : null;
    const frameSource = partition?.primary ?? record.frame;
    const lmuIdentity = gameId === "lmu" ? lmuSparseSourceIdentity(frameSource) : null;
    const acquisitionKey = lmuIdentity ? lmuAcquisitionKey(frameSource) : null;
    if (acquisitionKey && emittedLmuIdentities?.has(acquisitionKey)) {
      previous = null;
      continue;
    }
    if (acquisitionKey) emittedLmuIdentities?.add(acquisitionKey);
    if (partition?.companion) {
      const key = getLMUPartitionKey(frameSource);
      if (key) companions?.set(key, { frame: partition.companion, timestamp: record.frameTimeMs });
    }
    const magic = frameSource.length >= 4 ? frameSource.readUInt32LE(0) : 0;
    const isKunos = (gameId === "acc" && magic === ACC_PACKED_MAGIC) ||
      (gameId === "ac-evo" && magic === ACEVO_PACKED_MAGIC);
    const supportsGeneric = gameId === "fm-2023" || gameId === "f1-2025" || gameId === "iracing" || gameId === "ams2";
    const identity = supportsGeneric ? genericFrameIdentity(frameSource) : null;
    const canDelta = lmuIdentity !== null || isKunos || identity !== null;
    const previousLength = previous?.length;
    const sameIdentity = previous !== null && (
      (lmuIdentity !== null && lmuSparseSourceIdentity(previous) === lmuIdentity) ||
      (isKunos && previousLength === frameSource.length) ||
      (identity !== null && genericFrameIdentity(previous) === identity)
    );
    let frame = frameSource;
    let full = !canDelta || !sameIdentity || emitted % 128 === 0;
    if (!full) {
      const sparse = lmuIdentity !== null
        ? encodeLmuSparseFrame(frameSource, previous!, outputOffset - checkpoint)
        : isKunos
          ? encodeKunosSparseFrame(frameSource, previous!, outputOffset - checkpoint)
          : encodeGenericSparseFrame(frameSource, previous!, outputOffset - checkpoint);
      if (sparse.length < frameSource.length) frame = sparse;
      else full = true;
    }
    if (full) {
      frame = frameSource;
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
  options?: { opponentLap: string; opponentRevision: string },
): Promise<{ bytes: Uint8Array; manifest: LapsZipManifest }> {
  const wanted = new Set(lapIds);
  const allRows = await getLapsRaw();
  const sessions = selectedLapsBySession(allRows, wanted);
  if (sessions.size === 0) {
    throw new Error("No laps matched");
  }
  const files: Record<string, Uint8Array> = {};
  const entries: ManifestEntry[] = [];
  const playerLapId = options ? lapIds.find((id) => wanted.has(id)) : undefined;
  if (options && playerLapId === undefined) throw new Error("Selected opponent lap requires a player lap");
  const selectedPlayerSessionId = playerLapId === undefined ? undefined : allRows.find((row) => row.id === playerLapId)?.sessionId;
  const selectedOpponent = options && playerLapId !== undefined
    ? await getLmuOpponentLapForExport(playerLapId, options.opponentLap, options.opponentRevision)
    : null;
  const opponentFrames = selectedOpponent?.interval.frames.map((frame) => {
    const partition = partitionLMUSourceFrame(frame.sourceFrame);
    if (!partition?.companion) throw new Error("Selected opponent interval contains an unpartitionable LMU frame");
    return { frame, primary: partition.primary, companion: partition.companion };
  }) ?? null;
  const opponentRows = opponentFrames?.map(({ frame }) => ({
    captureSequence: frame.captureSequence,
    frameTime: frame.frameTime,
    parserBootstrap: frame.parserBootstrap?.toString("base64") ?? null,
  })) ?? null;
  for (const [sessionId, rows] of sessions) {
    const emittedLmuIdentities = options && selectedPlayerSessionId === sessionId
      ? new Set<string>()
      : undefined;
    const partitionCompanions = new Map<string, { frame: Buffer; timestamp: number | undefined }>();
    for (const row of rows) {
      if (row.captureLayoutVersion != null && row.captureLayoutVersion !== 1 && row.captureLayoutVersion !== 2 && row.captureLayoutVersion !== 3) {
        throw new Error(`Unsupported capture layout version ${row.captureLayoutVersion} for lap ${row.id}`);
      }
      if ((row.captureLayoutVersion === 1 || row.captureLayoutVersion === 2) && (!row.captureManifestFile || !row.captureChunkId || (row.captureLayoutVersion === 2 && !row.captureArchiveFile))) {
        throw new Error(`Published capture layout for lap ${row.id} has incomplete capture references`);
      }
    }
    const firstSelected = rows[0]!;
    const isIbt = rows.some((row) => row.source === "ibt" || row.rawFile?.toLowerCase().endsWith(".ibt"));
    if (isIbt) {
      if (rows.some((row) => row.gameId !== "iracing" || row.captureLayoutVersion != null)) {
        throw new Error("IBT source archives require original iRacing recordings without published BIN layouts");
      }
      const first = allRows.find((row) => row.sessionId === sessionId) ?? firstSelected;
      if (!first.rawFile) throw new Error("Original IBT source is missing");
      const sourceBytes = await readFile(first.rawFile);
      const trackName = resolveTrackName(first.trackId ?? "", "iracing");
      const carName = resolveCarName(first.carId ?? "", "iracing");
      const fileName = `iracing-${slugify(trackName) || `track${first.trackId ?? ""}`}-session${sessionId}.ibt`;
      files[fileName] = sourceBytes;
      const sourceLaps = allRows.filter((row) => row.sessionId === sessionId).sort((a, b) => a.lapNumber - b.lapNumber);
      entries.push({
        file: fileName, gameId: "iracing", sessionId,
        carId: first.carId ?? "", trackId: first.trackId ?? "",
        carName, trackName, createdAt: first.createdAt,
        laps: sourceLaps.map((r) => ({ lapNumber: r.lapNumber, lapTime: r.lapTime, isValid: r.isValid })),
      });
      continue;
    }
    const isMotec = rows.some((row) => row.source === "motec" || row.rawFile?.endsWith(".motec.zip"));
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
      const trailingContext = end > ownedEnd
        ? sparseLapRecords(buf, ownedEnd, end, first.gameId as GameId, false, partitionCompanions, emittedLmuIdentities)
        : [];
      const sparseRecords = first.gameId === "lmu" || first.gameId === "acc" || first.gameId === "ac-evo" ||
        first.gameId === "fm-2023" || first.gameId === "f1-2025" || first.gameId === "iracing" || first.gameId === "ams2"
        ? sparseLapRecords(buf, start, ownedEnd, first.gameId as GameId, !sparseFormatMarkerWritten, partitionCompanions, emittedLmuIdentities)
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
    const trackName = resolveTrackName(first.trackId ?? "", gameId);
    const carName = resolveCarName(first.carId ?? "", gameId);
    if (opponentFrames && selectedPlayerSessionId === sessionId) {
      const includedOpponentFrames = new Set<string>();
      let firstSequence: bigint | null = null;
      let previousPrimary: Buffer | null = null;
      for (const record of iterateSessionCaptureRecords(Buffer.concat([encodeMetaFrame(), ...segments]))) {
        if (record.kind === "segment-boundary") {
          previousPrimary = null;
          continue;
        }
        if (record.kind !== "frame") continue;
        let frame = record.frame;
        if (isLmuSparseFrame(frame)) {
          if (!previousPrimary) throw new Error("LMU opponent context lost its primary checkpoint");
          frame = decodeLmuSparseFrame(frame, previousPrimary);
        }
        previousPrimary = isLMUPartitionPrimary(frame) ? frame : null;
        const decoded = decodeLMUSourceFrame(frame);
        if (!decoded?.lmuContext) continue;
        const acquisitionKey = lmuAcquisitionKey(frame);
        if (!acquisitionKey) continue;
        includedOpponentFrames.add(acquisitionKey);
        const identity = decoded.lmuContext.key;
        const opponentIdentity = opponentFrames[0] &&
          decodeLMUSourceFrame(opponentFrames[0].frame.sourceFrame)?.lmuContext?.key;
        if (!opponentIdentity || identity.sessionKey !== opponentIdentity.sessionKey) continue;
        const sequence = BigInt(identity.captureSequence);
        if (firstSequence === null || sequence < firstSequence) firstSequence = sequence;
      }
      const beforeContext: Buffer[] = [];
      const afterContext: Buffer[] = [];
      const orderedOpponentFrames = [...new Map(opponentFrames
        .map((entry) => [lmuAcquisitionKey(entry.frame.sourceFrame), entry] as const)
        .filter((entry): entry is readonly [string, typeof opponentFrames[number]] => entry[0] !== null))
        .values()]
        .sort((a, b) => a.frame.frameTime - b.frame.frameTime ||
          (BigInt(decodeLMUSourceFrame(a.frame.sourceFrame)!.lmuContext!.key.captureSequence) <
            BigInt(decodeLMUSourceFrame(b.frame.sourceFrame)!.lmuContext!.key.captureSequence) ? -1 :
            BigInt(decodeLMUSourceFrame(a.frame.sourceFrame)!.lmuContext!.key.captureSequence) >
              BigInt(decodeLMUSourceFrame(b.frame.sourceFrame)!.lmuContext!.key.captureSequence) ? 1 : 0));
      for (const { frame, primary } of orderedOpponentFrames) {
        const frameIdentity = decodeLMUSourceFrame(frame.sourceFrame)?.lmuContext?.key;
        const frameKey = lmuAcquisitionKey(frame.sourceFrame);
        if (!frameKey || !frameIdentity || includedOpponentFrames.has(frameKey)) continue;
        includedOpponentFrames.add(frameKey);
        const partition = partitionLMUSourceFrame(frame.sourceFrame);
        const key = getLMUPartitionKey(primary);
        if (key && partition?.companion) partitionCompanions.set(key, { frame: partition.companion, timestamp: frame.frameTime });
        const context = firstSequence !== null && BigInt(frameIdentity.captureSequence) < firstSequence
          ? beforeContext
          : afterContext;
        if (frame.parserBootstrap) context.push(encodeParserBootstrapFrame("lmu", frame.parserBootstrap));
        context.push(encodeSegmentContextFrame(), encodeFrameLength(primary.length, frame.frameTime), primary, encodeSegmentContextEndFrame());
      }
      if (beforeContext.length > 0) segments.unshift(Buffer.concat([encodeSegmentBoundaryFrame(), ...beforeContext]));
      if (afterContext.length > 0) segments.push(Buffer.concat([encodeSegmentBoundaryFrame(), ...afterContext]));
    }
    const slice = Buffer.concat([encodeMetaFrame(), ...segments]);
    const fileName = `${gameId}-${slugify(trackName) || `track${first.trackId ?? ""}`}-session${sessionId}.bin.gz`;
    files[fileName] = gzipBufferSync(slice);
    const sourceRetention = gameId === "lmu" && first.rawFile
      ? await readLmuOpponentRetention(first.captureManifestFile ?? first.rawFile)
      : null;
    const retention = sourceRetention?.opponentAvailability === "incomplete" &&
        gameId === "lmu" && isLegacyPlayerOnlyLmuCapture(slice)
      ? { ...sourceRetention, opponentRetention: "not-recorded" as const, opponentAvailability: null }
      : sourceRetention;
    if (gameId === "lmu" && retention?.opponentRetention === "retained" && first.rawFile) {
      const selectedKeys = new Set<string>();
      let primaryCheckpoint: Buffer | null = null;
      for (const record of iterateSessionCaptureRecords(slice)) {
        if (record.kind === "segment-boundary") primaryCheckpoint = null;
        if (record.kind !== "frame") continue;
        let frame = record.frame;
        if (isLmuSparseFrame(frame)) {
          if (!primaryCheckpoint) throw new Error("LMU sparse export lost its primary checkpoint");
          frame = decodeLmuSparseFrame(frame, primaryCheckpoint);
        }
        if (!frame) throw new Error("LMU sparse export lost its primary checkpoint");
        if (isLMUPartitionPrimary(frame)) {
          const key = getLMUPartitionKey(frame);
          if (key) selectedKeys.add(key);
          primaryCheckpoint = frame;
        } else {
          primaryCheckpoint = null;
        }
      }
      if (selectedKeys.size > 0) {
        for await (const record of iterateSessionCaptureRecordsFromSource({
          rawFile: first.captureManifestFile ?? first.rawFile, source: first.source ?? null, gameId: "lmu",
          carId: first.carId ?? "", trackId: first.trackId ?? "",
        }, { strict: true, allowLegacyFullFrames: true })) {
          if (record.kind !== "frame") continue;
          const partition = partitionLMUSourceFrame(record.frame);
          const key = partition?.primary && getLMUPartitionKey(partition.primary);
          if (key && selectedKeys.has(key) && partition?.companion) {
            partitionCompanions.set(key, { frame: partition.companion, timestamp: record.frameTimeMs });
            selectedKeys.delete(key);
            if (selectedKeys.size === 0) break;
          }
        }
      }
    }
    const companionByAcquisition = new Map<string, {
      frame: Buffer;
      timestamp: number | undefined;
      sessionKey: string;
      captureSequence: string;
    }>();
    let previousPrimary: Buffer | null = null;
    for (const record of iterateSessionCaptureRecords(slice)) {
      if (record.kind === "segment-boundary") {
        previousPrimary = null;
        continue;
      }
      if (record.kind !== "frame") continue;
      let primary = record.frame;
      if (isLmuSparseFrame(primary)) {
        if (!previousPrimary) throw new Error("LMU sparse export lost its primary checkpoint");
        primary = decodeLmuSparseFrame(primary, previousPrimary);
      }
      if (isLMUPartitionPrimary(primary)) {
        const key = getLMUPartitionKey(primary);
        const companion = key ? partitionCompanions.get(key) : undefined;
        const identity = decodeLMUSourceFrame(primary)?.lmuContext?.key;
        const acquisitionKey = lmuAcquisitionKey(primary);
        if (!companion || !acquisitionKey || !identity) {
          if (!companion) companionByAcquisition.clear();
          break;
        }
        companionByAcquisition.set(acquisitionKey, {
          ...companion, timestamp: record.frameTimeMs, sessionKey: identity.sessionKey, captureSequence: identity.captureSequence,
        });
        previousPrimary = primary;
      } else {
        previousPrimary = null;
      }
    }
    const orderedCompanions = [...companionByAcquisition.values()].sort((a, b) =>
      (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
      a.sessionKey.localeCompare(b.sessionKey) ||
      (BigInt(a.captureSequence) < BigInt(b.captureSequence) ? -1 :
        BigInt(a.captureSequence) > BigInt(b.captureSequence) ? 1 : 0));
    const companionRecords: Buffer[] = [];
    for (const companion of orderedCompanions) {
      companionRecords.push(encodeFrameLength(companion.frame.length, companion.timestamp), companion.frame);
    }
    if (gameId === "lmu" && retention?.opponentRetention === "retained" &&
        hasPartitionPrimary(slice) && companionRecords.length === 0) {
      throw new Error("Retained LMU source could not produce a complete archive companion");
    }
    const opponentCompanionFile = companionRecords.length > 0
      ? `${gameId}-${slugify(trackName)}-session${sessionId}.opponents.bin.gz`
      : undefined;
    if (opponentCompanionFile) {
      files[opponentCompanionFile] = gzipBufferSync(Buffer.concat([
        encodeMetaFrame(), encodeSparseCaptureFormatFrame(), ...companionRecords,
      ]));
    }
    entries.push({
      file: fileName, gameId, sessionId,
      carId: first.carId ?? "", trackId: first.trackId ?? "",
      carName, trackName, createdAt: first.createdAt,
      ...(retention ? { opponentRetention: retention.opponentRetention } : {}),
      ...(opponentCompanionFile ? { opponentCompanionFile, opponentRetention: "retained" as const } : {}),
      ...(selectedOpponent && selectedPlayerSessionId === sessionId ? {
        opponentLap: {
          opponentLapId: selectedOpponent.interval.opponentLapId,
          sourceRevision: options!.opponentRevision,
          coverage: selectedOpponent.interval.coverage,
          frames: opponentRows!,
        },
      } : {}),
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
 * Import ZIP members through their production source pipeline: original IBT is
 * staged and committed as IBT, MoTeC is restored as MoTeC, and BIN replays as BIN.
 * Duplicates are not merged; importing the same archive twice creates sessions twice.
 */
export async function importLapsZip(zipData: Uint8Array, options: { ownership?: SessionOwnership; identityOverrides?: Record<string, { carId: string; trackId: string }> } = {}): Promise<ImportZipResult> {
  const files = unzipBounded(zipData, LAPS_ZIP_LIMITS);
  const manifest = parseManifestFile(files);

  const manifestEntries = new Map<string, ManifestEntry>();
  for (const entry of manifest?.entries ?? []) manifestEntries.set(entry.file, entry);
  const laps: ImportedLap[] = [];
  const errors: string[] = [];
  let skipped = 0;

  const referencedCompanions = new Set<string>();
  for (const entry of manifestEntries.values()) {
    if (!entry.opponentCompanionFile) continue;
    if (entry.opponentRetention === "removed" || entry.opponentRetention === "not-recorded") {
      throw new Error("Player-only LMU archive cannot include an opponent companion");
    }
    if (referencedCompanions.has(entry.opponentCompanionFile) ||
        entry.gameId !== "lmu" || !files[entry.file] ||
        !entry.opponentCompanionFile.endsWith(".opponents.bin.gz")) {
      throw new Error("Archive has multiply-owned or invalid opponent companion");
    }
    referencedCompanions.add(entry.opponentCompanionFile);
  }
  if (Object.keys(files).some((name) => name.endsWith(".opponents.bin.gz") && !referencedCompanions.has(name))) {
    throw new Error("Archive contains an unassociated opponent companion");
  }
  const names = fileNamesForZip(files);

  if (names.length === 0) {
    throw new Error(
      "Zip contains no session captures (.bin/.bin.gz/.motec.zip/.ibt). Exports from an older RaceIQ version can't be imported."
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
    if (name.toLowerCase().endsWith(".ibt")) {
      try {
        if (entry && entry.gameId !== "iracing") throw new Error("IBT manifest metadata must identify iRacing");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(memberBytes);
            controller.close();
          },
        });
        const staged = await stageIbtUpload(stream, name, memberBytes.byteLength);
        if (!staged.token) {
          skipped++;
          errors.push(`${name}: ${staged.preview.reason ?? "IBT preview was not importable"}`);
          continue;
        }
        const result = await commitStagedIbt(staged.token, options.ownership);
        laps.push(...result.laps);
      } catch (error) {
        skipped++;
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
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
      const decompressed = decompressIfGzipSync(bytes);
      const hasPartitionedOpponents = gameId === "lmu" && hasPartitionPrimary(decompressed);
      if (hasPartitionedOpponents && entry?.opponentRetention !== "removed" &&
          entry?.opponentRetention !== "not-recorded" && (!entry || !entry.opponentCompanionFile)) {
        throw new Error("Retained LMU archive is missing its opponent companion pairing");
      }
      if (entry?.gameId === "lmu" && entry.opponentCompanionFile && !files[entry.opponentCompanionFile]) {
        throw new Error("Retained archive opponent companion member is missing");
      }
      const importBytes = entry?.gameId === "lmu" && entry.opponentCompanionFile
        ? joinArchiveOpponentCompanion(
          decompressed,
          decompressIfGzipSync(Buffer.from(files[entry.opponentCompanionFile]!)),
        )
        : bytes;
      const result = await importSessionBin(importBytes, gameId, {
        ownership: options.ownership,
        ...(entry?.gameId === "lmu" && entry.opponentRetention
          ? { opponentRetention: entry.opponentRetention }
          : {}),
        onImportedLaps: entry && Array.isArray(entry.laps) ? async (imported) => {
          await withDatabaseWrite(() => db.transaction(async (tx) => {
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
          }));
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

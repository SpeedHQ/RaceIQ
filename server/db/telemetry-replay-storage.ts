import { eq, and } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getServerGame } from "../games/registry";
import { isIRacingSessionFrame } from "../games/iracing/source-frame";
import { normalizeTelemetryPacket } from "../telemetry/normalization";
import type { ComparisonAlignmentIndex } from "../lap-analysis/comparison";
import { iterateSessionCaptureRecords } from "../session-capture/framing";
import { loadSessionSource, iterateSessionCaptureFrames, indexCaptureFrames, clearRawFileCacheForTest as clearSourceCaptureCache, type SessionCaptureSource, type SessionCaptureFrameRecord } from "../session-capture/source-loader";
import { legacyMotecOffsetToPacketIndex } from "../motec/source-archive";
import { countFullPacketMaterialized, countParserStatePrime } from "../session-capture/test-instrumentation";

// Rough per-packet byte estimate. TelemetryPacket has ~50–80 numeric fields
// plus optional game-specific extensions (f1/acc/setup). Sniffing the first
// packet to pick a tighter estimate is precise enough for an eviction budget
// that the user controls in settings.
const BYTES_PER_PACKET_BASE = 500;
const BYTES_PER_PACKET_F1 = 1100;
const BYTES_PER_PACKET_ACC = 800;

const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

interface TelemetryCacheEntry {
  kind: "telemetry";
  packets: TelemetryPacket[];
  bytes: number;
}

interface ComparisonCacheEntry {
  kind: "comparison";
  body?: string;
  alignmentIndex?: ComparisonAlignmentIndex;
  bytes: number;
  idA: number;
  idB: number;
}

type CacheEntry = TelemetryCacheEntry | ComparisonCacheEntry;

const telemetryCache = new Map<string, CacheEntry>();
let cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;
let cacheBytesUsed = 0;

function lapKey(id: number): string {
  return `lap:${id}`;
}

function comparisonKey(idA: number, idB: number): string {
  return `comparison:${idA}:${idB}`;
}

function estimateBytes(packets: TelemetryPacket[]): number {
  if (packets.length === 0) return 0;
  const sample = packets[0] as TelemetryPacket & { f1?: unknown; acc?: unknown };
  const per = sample.f1 ? BYTES_PER_PACKET_F1 : sample.acc ? BYTES_PER_PACKET_ACC : BYTES_PER_PACKET_BASE;
  return packets.length * per;
}

function touch(key: string, entry: CacheEntry): void {
  telemetryCache.delete(key);
  telemetryCache.set(key, entry);
}

export function cacheGet(id: number): TelemetryPacket[] | undefined {
  const key = lapKey(id);
  const entry = telemetryCache.get(key);
  if (entry?.kind !== "telemetry") return undefined;
  touch(key, entry);
  return entry.packets;
}

export function cacheSet(id: number, packets: TelemetryPacket[]): void {
  const key = lapKey(id);
  const existing = telemetryCache.get(key);
  if (existing) {
    cacheBytesUsed -= existing.bytes;
    telemetryCache.delete(key);
  }
  const bytes = estimateBytes(packets);
  telemetryCache.set(key, { kind: "telemetry", packets, bytes });
  cacheBytesUsed += bytes;
  evictUntilWithinBudget();
}
function comparisonEntryBytes(body: string | undefined, alignmentIndex: ComparisonAlignmentIndex | undefined): number {
  return (body === undefined ? 0 : Buffer.byteLength(body, "utf8"))
    + (alignmentIndex === undefined ? 0 : 8 * (alignmentIndex.distancesA.length + alignmentIndex.distancesB.length));
}

function replaceComparisonEntry(
  idA: number,
  idB: number,
  fields: { body?: string; alignmentIndex?: ComparisonAlignmentIndex },
): void {
  const key = comparisonKey(idA, idB);
  const existing = telemetryCache.get(key);
  if (existing?.kind === "comparison") {
    cacheBytesUsed -= existing.bytes;
  }
  const body = fields.body ?? (existing?.kind === "comparison" ? existing.body : undefined);
  const alignmentIndex = fields.alignmentIndex ?? (existing?.kind === "comparison" ? existing.alignmentIndex : undefined);
  const bytes = comparisonEntryBytes(body, alignmentIndex);
  telemetryCache.delete(key);
  telemetryCache.set(key, { kind: "comparison", body, alignmentIndex, bytes, idA, idB });
  cacheBytesUsed += bytes;
  evictUntilWithinBudget();
}

export function comparisonCacheGet(idA: number, idB: number): string | undefined {
  const key = comparisonKey(idA, idB);
  const entry = telemetryCache.get(key);
  if (entry?.kind !== "comparison" || entry.body === undefined) return undefined;
  touch(key, entry);
  return entry.body;
}

export function comparisonCacheSet(idA: number, idB: number, body: string): void {
  replaceComparisonEntry(idA, idB, { body });
}

export function comparisonAlignmentIndexCacheGet(idA: number, idB: number): ComparisonAlignmentIndex | undefined {
  const key = comparisonKey(idA, idB);
  const entry = telemetryCache.get(key);
  if (entry?.kind !== "comparison" || entry.alignmentIndex === undefined) return undefined;
  touch(key, entry);
  return entry.alignmentIndex;
}

export function comparisonAlignmentIndexCacheSet(idA: number, idB: number, index: ComparisonAlignmentIndex): void {
  replaceComparisonEntry(idA, idB, { alignmentIndex: index });
}

export function cacheDelete(id: number): boolean {
  let deleted = false;
  const key = lapKey(id);
  const lapEntry = telemetryCache.get(key);
  if (lapEntry) {
    cacheBytesUsed -= lapEntry.bytes;
    telemetryCache.delete(key);
    deleted = true;
  }
  for (const [entryKey, entry] of telemetryCache) {
    if (entry.kind === "comparison" && (entry.idA === id || entry.idB === id)) {
      cacheBytesUsed -= entry.bytes;
      telemetryCache.delete(entryKey);
      deleted = true;
    }
  }
  return deleted;
}

function evictUntilWithinBudget(): void {
  while (cacheBytesUsed > cacheMaxBytes && telemetryCache.size > 0) {
    const oldest = telemetryCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = telemetryCache.get(oldest);
    if (!entry) break;
    cacheBytesUsed -= entry.bytes;
    telemetryCache.delete(oldest);
  }
}

export function setCacheMaxBytes(bytes: number): void {
  cacheMaxBytes = Math.max(0, Math.floor(bytes));
  evictUntilWithinBudget();
}

export function getCacheStats(): { bytesUsed: number; maxBytes: number; entries: number } {
  return { bytesUsed: cacheBytesUsed, maxBytes: cacheMaxBytes, entries: telemetryCache.size };
}
export const _telemetryCacheForTest = {
  get: cacheGet,
  set: cacheSet,
  delete: cacheDelete,
  comparisonGet: comparisonCacheGet,
  comparisonSet: comparisonCacheSet,
  comparisonAlignmentIndexGet: comparisonAlignmentIndexCacheGet,
  comparisonAlignmentIndexSet: comparisonAlignmentIndexCacheSet,
  clear: () => {
    telemetryCache.clear();
    cacheBytesUsed = 0;
  },
  size: () => telemetryCache.size,
  bytesUsed: () => cacheBytesUsed,
  maxBytes: () => cacheMaxBytes,
  setMaxBytes: setCacheMaxBytes,
  resetMaxBytes: () => {
    cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;
  },
  keys: () => Array.from(telemetryCache.keys()).filter((key) => key.startsWith("lap:")).map((key) => Number(key.slice(4))),
  comparisonKeys: () => Array.from(telemetryCache.keys()).filter((key) => key.startsWith("comparison:")),
  estimateBytes,
};

/**
 * Re-parse raw UDP frames from a session .bin file for a specific lap.
 * Frame 0 is a meta frame (magic-prefixed); lap frames start at rawByteOffset.
 */

interface LapParseErrorDetails {
  rawFile: string;
  rawByteOffset: number;
  rawFrameCount: number;
  fileSize: number;
  framesParsed: number;
  reason: "offset-past-eof" | "truncated-frame" | "truncated-meta" | "no-packets-parsed";
}

export class LapParseError extends Error {
  readonly details: LapParseErrorDetails;

  constructor(message: string, details: LapParseErrorDetails) {
    super(message);
    this.name = "LapParseError";
    this.details = details;
  }
}

// Decompressed session-file buffer cache. Every lap fetch used to re-read AND
// re-gunzip the whole session raw file; a stint of N laps then paid N full

/** Compatibility hook for callers that clear replay source caches. */
export function clearRawFileCacheForTest(): void { clearSourceCaptureCache(); }

type ReplayGame = ReturnType<typeof getServerGame>;
function packetIndexForOffset(gameId: GameId, offset: number, encoding: "packet-index" | "legacy-bin-byte-offset"): number {
  return encoding === "legacy-bin-byte-offset" ? legacyMotecOffsetToPacketIndex(gameId, offset) : offset;
}

function freshReplayPacket(packet: TelemetryPacket): TelemetryPacket {
  return { ...packet };
}


function normalizeReplayPacket(packet: TelemetryPacket, game: ReplayGame): void {
  normalizeTelemetryPacket(packet, game.coordSystem === "standard-xyz", game.runtime.normSuspensionTravelMm);
}

function appendDelayedFinishPacket(packets: TelemetryPacket[], trailing: TelemetryPacket | null, game: ReplayGame): void {
  const last = packets[packets.length - 1];
  if (!game.appendsDelayedFinishFrame || !trailing || !last) return;

  const finishTime = trailing.LastLap ?? 0;
  if (finishTime <= (last.CurrentLap ?? 0)) return;

  packets.push({
    ...trailing,
    CurrentLap: finishTime,
    LapNumber: last.LapNumber,
    DistanceTraveled: Math.max(trailing.DistanceTraveled, last.DistanceTraveled),
  });
}

function replayCanonicalLap(
  sourcePackets: TelemetryPacket[],
  start: number,
  frameCount: number,
  game: ReplayGame,
): TelemetryPacket[] {
  const packets = sourcePackets
    .slice(start, start + frameCount)
    .map(freshReplayPacket);
  for (const packet of packets) normalizeReplayPacket(packet, game);

  const trailingSource = sourcePackets[start + frameCount];
  const trailing = trailingSource ? freshReplayPacket(trailingSource) : null;
  if (trailing) normalizeReplayPacket(trailing, game);
  appendDelayedFinishPacket(packets, trailing, game);
  return packets;
}

/** Return stored raw input path for race-result provenance hashing. */
export async function getSessionRawFile(sessionId: number, gameId: GameId): Promise<string | null> {
  const session = await db
    .select({ rawFile: sessions.rawFile })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.gameId, gameId)))
    .get();
  return session?.rawFile ?? null;
}

/**
 * Re-parse every frame from a completed session capture. Result reconciliation
 * needs the session tail because authoritative finish packets may arrive after
 * the final persisted lap range.
 */
export async function getSessionTelemetry(sessionId: number, gameId: GameId): Promise<TelemetryPacket[]> {
  const session = await db.select({
    rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId,
    carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal,
  }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.gameId, gameId))).get();
  if (!session?.rawFile) return [];
  const loaded = await loadSessionSource({
    rawFile: session.rawFile, source: session.source, gameId: session.gameId as GameId,
    carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal,
  });
  if (loaded.kind === "packets") {
    const packets = loaded.packets.map(freshReplayPacket);
    for (const packet of packets) normalizeReplayPacket(packet, getServerGame(gameId));
    return packets;
  }
  const serverGame = getServerGame(gameId);
  let state = serverGame.createParserState?.() ?? null;
  const buf = loaded.buffer;
  const packets: TelemetryPacket[] = [];
  let inContext = false;
  for (const record of iterateSessionCaptureRecords(buf)) {
    if (record.kind === "segment-boundary") {
      state = serverGame.createParserState?.() ?? null;
      inContext = false;
      continue;
    }
    if (record.kind === "segment-context") {
      inContext = true;
      continue;
    }
    if (record.kind === "segment-context-end") {
      inContext = false;
      continue;
    }
    if (record.kind !== "frame") continue;
    try {
      const packet = serverGame.tryParse(record.frame, state);
      if (!packet) continue;
      normalizeReplayPacket(packet, serverGame);
      if (!inContext) packets.push(packet);
    } catch {
      // Match lap replay: one malformed native frame does not discard session.
    }
  }
  return packets;
}
function parseReplayFrame(frame: Buffer, serverGame: ReturnType<typeof getServerGame>, state: unknown): TelemetryPacket | null {
  try {
    countFullPacketMaterialized();
    const packet = serverGame.tryParse(frame, state);
    if (packet) normalizeReplayPacket(packet, serverGame);
    return packet;
  } catch { return null; }
}

async function parseRawLapFramesFromSource(
  source: SessionCaptureSource,
  rawByteOffset: number,
  rawFrameCount: number,
): Promise<TelemetryPacket[]> {
  const serverGame = getServerGame(source.gameId);
  const state = serverGame.createParserState?.() ?? null;
  let fileSize = source.rawFile.endsWith(".gz") ? 0 : Bun.file(source.rawFile).size;
  const packets: TelemetryPacket[] = [];
  let found = false;
  let targetCount = 0;
  for await (const { offset, frame } of iterateSessionCaptureFrames(source)) {
    fileSize = Math.max(fileSize, offset + 4 + frame.length);
    if (!found) {
      if (offset < rawByteOffset) {
        if (state != null && serverGame.primeParserState) {
          try { countParserStatePrime(); serverGame.primeParserState(frame, state); } catch {}
        }
        continue;
      }
      if (offset !== rawByteOffset) {
        throw new LapParseError(`Lap raw byte offset ${rawByteOffset} is not aligned to a capture frame in ${source.rawFile}`, {
          rawFile: source.rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: 0, reason: "truncated-frame",
        });
      }
      found = true;
    }
    const packet = parseReplayFrame(frame, serverGame, state);
    if (targetCount < rawFrameCount) {
      if (packet) packets.push(packet);
      targetCount++;
      continue;
    }
    appendDelayedFinishPacket(packets, packet, serverGame);
    break;
  }
  if (!found || targetCount < rawFrameCount) {
    if (!found && rawByteOffset >= fileSize) {
      throw new LapParseError(`Lap raw byte offset ${rawByteOffset} is past EOF (file is ${fileSize} bytes) in ${source.rawFile}`, {
        rawFile: source.rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: 0, reason: "offset-past-eof",
      });
    }
    throw new LapParseError(`Capture ended before ${rawFrameCount} lap frames were read`, {
      rawFile: source.rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: packets.length, reason: "truncated-frame",
    });
  }
  if (packets.length === 0 && rawFrameCount > 0) {
    throw new LapParseError(`Parsed ${rawFrameCount} frames but produced 0 telemetry packets (gameId=${source.gameId})`, {
      rawFile: source.rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: 0, reason: "no-packets-parsed",
    });
  }
  return packets;
}

export async function parseRawLapFrames(source: SessionCaptureSource, rawByteOffset: number, rawFrameCount: number): Promise<TelemetryPacket[]> {
  if (!source.rawFile.endsWith(".motec.zip")) {
    return parseRawLapFramesFromSource(source, rawByteOffset, rawFrameCount);
  }
  const loaded = await loadSessionSource(source);
  if (loaded.kind !== "packets") throw new Error("Expected canonical packet source");
  const start = packetIndexForOffset(source.gameId, rawByteOffset, loaded.offsetEncoding);
  return replayCanonicalLap(
    loaded.packets,
    start,
    rawFrameCount,
    getServerGame(source.gameId),
  );
}
export function parseRawLapFramesFromBuffer(buf: Buffer, rawByteOffset: number, rawFrameCount: number, gameId: GameId, rawFile = "<preloaded capture>"): TelemetryPacket[] {
  const serverGame = getServerGame(gameId);
  let state = serverGame.createParserState?.() ?? null;
  const fileSize = buf.length;

  // rawByteOffset past EOF means the lap row was written before the
  // corresponding bytes made it to disk (old bug), or something stomped
  // the file. Fail loudly so the client can surface a useful message.
  if (rawByteOffset >= fileSize) {
    throw new LapParseError(`Lap raw byte offset ${rawByteOffset} is past EOF (file is ${fileSize} bytes) in ${rawFile}`, {
      rawFile,
      rawByteOffset,
      rawFrameCount,
      fileSize,
      framesParsed: 0,
      reason: "offset-past-eof",
    });
  }

  const frameIndex = indexCaptureFrames(buf);
  const startRecord = frameIndex.byOffset.get(rawByteOffset);
  const warmupRecords = startRecord
    ? frameIndex.records.slice(0, startRecord.frameIndex)
    : frameIndex.records.filter((record) => record.offset < rawByteOffset);
  if (state != null) for (const record of warmupRecords) {
    const wBuf = buf.subarray(record.offset + 4, record.offset + 4 + record.length);
    try {
      countParserStatePrime();
      serverGame.primeParserState(wBuf, state);
    } catch { /* warmup best-effort */ }
  }
  let offset = rawByteOffset;
  const packets: TelemetryPacket[] = [];
  // returned to the caller.
  const readCount = rawFrameCount + 1;

  for (let i = 0; i < readCount; i++) {
    if (offset + 4 > buf.length) {
      // Extra frame may legitimately not exist (end of file). Only complain
      // about missing frames within rawFrameCount itself.
      if (i >= rawFrameCount) break;
      throw new LapParseError(`Truncated frame header at offset ${offset} (file ${fileSize} bytes, wanted frame ${i + 1}/${rawFrameCount})`, {
        rawFile,
        rawByteOffset,
        rawFrameCount,
        fileSize,
        framesParsed: packets.length,
        reason: "truncated-frame",
      });
    }
    const frameLen = buf.readUInt32LE(offset);
    // NOTE: we do not check for META_FRAME_MAGIC here — the meta frame only
    // exists at file offset 0, which laps never start at. Treating any
    // mid-lap 0xFFFFFFFF as a meta frame would false-positive on legitimate
    // packet data containing that byte pattern and drift the frame reader
    // out of alignment.
    offset += 4;
    if (offset + frameLen > buf.length) {
      if (i >= rawFrameCount) break;
      throw new LapParseError(`Frame ${i + 1}/${rawFrameCount} at offset ${offset} claims ${frameLen} bytes but only ${buf.length - offset} remain`, {
        rawFile,
        rawByteOffset,
        rawFrameCount,
        fileSize,
        framesParsed: packets.length,
        reason: "truncated-frame",
      });
    }
    const sourceFrame = buf.subarray(offset, offset + frameLen);
    offset += frameLen;
    const packet = parseReplayFrame(sourceFrame, serverGame, state);
    if (!packet) continue;
    if (i < rawFrameCount) {
      packets.push(packet);
    } else {
      appendDelayedFinishPacket(packets, packet, serverGame);
    }
  }

  // Parsed every frame successfully but the game adapter rejected all of
  // them — the state accumulator never built a complete packet. Surface it.
  if (packets.length === 0 && rawFrameCount > 0) {
    throw new LapParseError(`Parsed ${rawFrameCount} frames but produced 0 telemetry packets (gameId=${gameId})`, {
      rawFile,
      rawByteOffset,
      rawFrameCount,
      fileSize,
      framesParsed: 0,
      reason: "no-packets-parsed",
    });
  }

  return packets;
}

/** Test-only export so integration tests can drive parseRawLapFrames directly. */

export interface LapReplaySource {
  id: number;
  sessionId: number;
  createdAt: string;
  gameId: GameId;
  rawFile: string | null;
  rawByteOffset: number | null;
  rawFrameCount: number | null;
  versionIdentity?: TelemetryVersionIdentity;
}

/** Storage provenance needed to wrap resolver-backed replay frames. */

export async function getLapReplaySource(id: number): Promise<LapReplaySource | null> {
  const row = await db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      createdAt: laps.createdAt,
      gameId: sessions.gameId,
      rawFile: sessions.rawFile,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      catalogVersion: laps.catalogVersion,
      catalogHash: laps.catalogHash,
      catalogSchemaVersion: laps.catalogSchemaVersion,
      parserVersion: laps.parserVersion,
      resolverVersion: laps.resolverVersion,
      derivationVersion: laps.derivationVersion,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(eq(laps.id, id))
    .get();
  if (!row) return null;
  const hasVersionIdentity =
    row.catalogVersion != null && row.catalogHash != null && row.catalogSchemaVersion != null && row.parserVersion != null && row.resolverVersion != null && row.derivationVersion != null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    gameId: row.gameId as GameId,
    rawFile: row.rawFile,
    rawByteOffset: row.rawByteOffset,
    rawFrameCount: row.rawFrameCount,
    versionIdentity: hasVersionIdentity
      ? {
          catalogVersion: row.catalogVersion!,
          catalogHash: row.catalogHash!,
          catalogSchemaVersion: row.catalogSchemaVersion!,
          parserVersion: row.parserVersion!,
          resolverVersion: row.resolverVersion!,
          derivationVersion: row.derivationVersion!,
        }
      : undefined,
  };
}

/**
 * Current rows replay from the raw session capture first. Historical rows and
 * failed raw reads replay from their retained gzip CSV blob when available.
 */

export const parseRawLapFramesForTest = parseRawLapFrames;

/** Test-only export so integration tests can drive the batch decoder directly. */

export const parseSessionLapsBatchedForTest = parseSessionLapsBatched;

/**
 * Decode several laps of the SAME session in a single forward pass over the raw
 * file. `parseRawLapFrames` re-warms the parser state from the start of the file
 * on every call, so cold-loading N laps of a stint costs O(N²) frame parses
 * (the last lap replays every earlier lap). This walks the file once: one
 * warm-up, one parser state, each frame parsed exactly once, sliced back into
 * per-lap packet arrays. Output is byte-identical to N separate
 * parseRawLapFrames calls because the parser is deterministic given the frame
 * prefix from file start.
 *
 * Returns a Map keyed by lap id for laps it resolved. Laps whose stored offset
 * can't be located in the frame stream are omitted — caller falls back per-lap.
 */
export async function parseSessionLapsBatched(source: SessionCaptureSource, lapMetas: { id: number; rawByteOffset: number; rawFrameCount: number }[]): Promise<Map<number, TelemetryPacket[]>> {
  const out = new Map<number, TelemetryPacket[]>();
  if (lapMetas.length === 0) return out;
  const serverGame = getServerGame(source.gameId);

  if (source.rawFile.endsWith(".motec.zip")) {
    const loaded = await loadSessionSource(source);
    if (loaded.kind !== "packets") throw new Error("Expected canonical packet source");
    for (const meta of lapMetas) {
      const start = packetIndexForOffset(source.gameId, meta.rawByteOffset, loaded.offsetEncoding);
      const packets = replayCanonicalLap(
        loaded.packets,
        start,
        meta.rawFrameCount,
        serverGame,
      );
      if (packets.length > 0) out.set(meta.id, packets);
    }
    return out;
  }
  const loaded = await loadSessionSource(source);
  if (loaded.kind !== "capture") throw new Error("Expected BIN capture source");
  let state = serverGame.createParserState?.() ?? null;
  const metas = lapMetas
    .map((meta) => ({ meta, record: loaded.frameIndex.byOffset.get(meta.rawByteOffset) }))
    .filter((item): item is { meta: (typeof lapMetas)[number]; record: SessionCaptureFrameRecord } => item.record !== undefined)
    .sort((a, b) => a.record.frameIndex - b.record.frameIndex);
  const active: Array<{ meta: (typeof lapMetas)[number]; packets: TelemetryPacket[]; end: number }> = [];
  let nextMeta = 0;
  for (const record of loaded.frameIndex.records) {
    while (nextMeta < metas.length && metas[nextMeta]!.record.frameIndex === record.frameIndex) {
      const item = metas[nextMeta++]!;
      active.push({ meta: item.meta, packets: [], end: record.frameIndex + item.meta.rawFrameCount });
    }
    if (nextMeta === metas.length && active.length === 0) break;
    const needsFull = active.some((lap) => record.frameIndex <= lap.end);
    if (!needsFull && state == null) continue;
    let packet: TelemetryPacket | null = null;
    try {
      const frame = loaded.buffer.subarray(record.offset + 4, record.offset + 4 + record.length);
      if (source.gameId === "iracing" && isIRacingSessionFrame(frame)) {
        state = serverGame.createParserState?.() ?? null;
      }
      if (needsFull) {
        countFullPacketMaterialized();
        packet = serverGame.tryParse(frame, state);
        if (packet) normalizeReplayPacket(packet, serverGame);
      } else {
        countParserStatePrime();
        serverGame.primeParserState(frame, state);
      }
    } catch { /* malformed frame */ }
    for (const lap of active) {
      if (record.frameIndex < lap.end) {
        if (packet) lap.packets.push(packet);
      } else if (record.frameIndex === lap.end) {
        appendDelayedFinishPacket(lap.packets, packet, serverGame);
      }
    }
    for (let index = active.length - 1; index >= 0; index--) {
      const lap = active[index]!;
      if (record.frameIndex >= lap.end) {
        if (lap.packets.length > 0) out.set(lap.meta.id, lap.packets);
        active.splice(index, 1);
      }
    }
  }
  for (const lap of active) if (lap.packets.length > 0) out.set(lap.meta.id, lap.packets);
  return out;
}

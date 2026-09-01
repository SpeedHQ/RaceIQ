import { eq, and } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "../telemetry/normalization";
import type { ComparisonAlignmentIndex } from "../lap-analysis/comparison";
import { iterateSessionCaptureFrames, loadSessionSource, clearRawFileCacheForTest as clearSourceCaptureCache, type SessionCaptureSource } from "../session-capture/source-loader";
import { readFrameStreamStart } from "../session-capture/framing";
import { legacyMotecOffsetToPacketIndex } from "../motec/source-archive";
import { estimateTelemetryPacketsBytes } from "../telemetry/memory-estimate";

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
  return estimateTelemetryPacketsBytes(packets);
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
  const retain = game.retainParsedPacket ?? (() => true);
  const packets: TelemetryPacket[] = [];
  for (const sourcePacket of sourcePackets.slice(start, start + frameCount)) {
    const packet = freshReplayPacket(sourcePacket);
    normalizeReplayPacket(packet, game);
    if (retain(packet)) packets.push(packet);
  }

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
  const serverGame = getServerGame(gameId);
  const retain = serverGame.retainParsedPacket ?? (() => true);
  if (loaded.kind === "packets") {
    return loaded.packets.map(freshReplayPacket).filter((packet) => {
      normalizeReplayPacket(packet, serverGame);
      return retain(packet);
    });
  }
  const state = serverGame.createParserState?.() ?? null;
  const buf = loaded.buffer;
  const packets: TelemetryPacket[] = [];
  let offset = readFrameStreamStart(buf);
  while (offset + 4 <= buf.length) {
    const frameLen = buf.readUInt32LE(offset); offset += 4;
    if (frameLen <= 0 || offset + frameLen > buf.length) break;
    const sourceFrame = buf.subarray(offset, offset + frameLen); offset += frameLen;
    try {
      const packet = serverGame.tryParse(sourceFrame, state);
      if (packet) {
        normalizeReplayPacket(packet, serverGame);
        if (retain(packet)) packets.push(packet);
      }
    } catch {}
  }
  return packets;
}
async function parseRawLapFramesFromSource(
  source: SessionCaptureSource,
  rawByteOffset: number,
  rawFrameCount: number,
): Promise<TelemetryPacket[]> {
  const serverGame = getServerGame(source.gameId);
  const state = serverGame.createParserState?.() ?? null;
  const retain = serverGame.retainParsedPacket ?? (() => true);
  const packets: TelemetryPacket[] = [];
  let started = false;
  let parsedCount = 0;
  for await (const record of iterateSessionCaptureFrames(source)) {
    if (!started) {
      if (record.offset < rawByteOffset) {
        try { serverGame.tryParse(record.frame, state); } catch {}
        continue;
      }
      if (record.offset !== rawByteOffset) break;
      started = true;
    }
    try {
      const packet = serverGame.tryParse(record.frame, state);
      if (!packet) continue;
      normalizeReplayPacket(packet, serverGame);
      if (parsedCount < rawFrameCount) {
        if (retain(packet)) packets.push(packet);
        parsedCount++;
      } else {
        appendDelayedFinishPacket(packets, packet, serverGame);
        break;
      }
    } catch {}
  }
  if (packets.length === 0 && rawFrameCount > 0) {
    throw new LapParseError(`Parsed ${rawFrameCount} frames but produced 0 telemetry packets (gameId=${source.gameId})`, {
      rawFile: source.rawFile,
      rawByteOffset,
      rawFrameCount,
      fileSize: 0,
      framesParsed: 0,
      reason: "no-packets-parsed",
    });
  }
  return packets;
}

export async function parseRawLapFrames(source: SessionCaptureSource, rawByteOffset: number, rawFrameCount: number): Promise<TelemetryPacket[]> {
  if (source.rawFile.endsWith(".motec.zip")) {
    const loaded = await loadSessionSource(source);
    if (loaded.kind !== "packets") throw new Error("Expected canonical packet source");
    const start = packetIndexForOffset(source.gameId, rawByteOffset, loaded.offsetEncoding);
    return replayCanonicalLap(loaded.packets, start, rawFrameCount, getServerGame(source.gameId));
  }
  return parseRawLapFramesFromSource(source, rawByteOffset, rawFrameCount);
}
export function parseRawLapFramesFromBuffer(buf: Buffer, rawByteOffset: number, rawFrameCount: number, gameId: GameId, rawFile = "<preloaded capture>"): TelemetryPacket[] {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
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

  // Warm up stateful parsers (F1) by replaying frames from the start of the
  // file. Without this the accumulator starts empty mid-file and drops the
  // first ~1s of lap telemetry waiting for every sub-packet type to arrive.
  // Start after an optional metadata frame.
  let warmupOffset = readFrameStreamStart(buf);
  while (warmupOffset < rawByteOffset && warmupOffset + 4 <= buf.length) {
    const wLen = buf.readUInt32LE(warmupOffset);
    if (wLen <= 0 || warmupOffset + 4 + wLen > buf.length) break;
    const wBuf = buf.subarray(warmupOffset + 4, warmupOffset + 4 + wLen);
    warmupOffset += 4 + wLen;
    try {
      serverGame.tryParse(wBuf, state);
    } catch {
      /* warmup best-effort */
    }
  }

  let offset = rawByteOffset;
  const packets: TelemetryPacket[] = [];
  // Read one extra frame past the stored count so we can enrich the final
  // in-lap packet with the lap-completion info carried on the next-lap
  // trigger frame (LastLap, sector3Time, etc). The extra frame is NOT
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
    try {
      const packet = serverGame.tryParse(sourceFrame, state);
      if (!packet) continue;
      normalizeReplayPacket(packet, serverGame);
      if (i < rawFrameCount) {
        if ((serverGame.retainParsedPacket ?? (() => true))(packet)) packets.push(packet);
      } else {
        appendDelayedFinishPacket(packets, packet, serverGame);
      }
    } catch (err) {
      // A single malformed frame shouldn't kill the whole lap parse. Log
      // once (first occurrence) with enough context to diagnose, then skip.
      if (packets.length === 0 && i < 5) {
        console.warn(`[DB] tryParse threw on frame ${i + 1}/${rawFrameCount} of lap ` + `(gameId=${gameId}, offset=${offset - frameLen}, len=${frameLen}): ` + `${(err as Error).message}`);
      }
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
async function parseSessionLapsBatchedFromSource(
  source: SessionCaptureSource,
  lapMetas: { id: number; rawByteOffset: number; rawFrameCount: number }[],
): Promise<Map<number, TelemetryPacket[]>> {
  const out = new Map<number, TelemetryPacket[]>();
  const game = getServerGame(source.gameId);
  const state = game.createParserState?.() ?? null;
  const retain = game.retainParsedPacket ?? (() => true);
  const metas = [...lapMetas].sort((a, b) => a.rawByteOffset - b.rawByteOffset);
  const active: Array<{
    meta: (typeof metas)[number];
    packets: TelemetryPacket[];
    remaining: number;
    trailing: boolean;
  }> = [];
  let nextMeta = 0;
  for await (const record of iterateSessionCaptureFrames(source)) {
    while (nextMeta < metas.length && metas[nextMeta].rawByteOffset < record.offset) nextMeta++;
    while (nextMeta < metas.length && metas[nextMeta].rawByteOffset === record.offset) {
      const meta = metas[nextMeta++];
      active.push({ meta, packets: [], remaining: meta.rawFrameCount, trailing: false });
    }
    if (nextMeta === metas.length && active.length === 0) break;

    let packet: TelemetryPacket | null = null;
    try {
      packet = game.tryParse(record.frame, state);
      if (packet) normalizeReplayPacket(packet, game);
    } catch {}
    for (const lap of active) {
      if (lap.remaining > 0) {
        if (packet && retain(packet)) lap.packets.push(packet);
        lap.remaining--;
      } else if (!lap.trailing) {
        appendDelayedFinishPacket(lap.packets, packet, game);
        lap.trailing = true;
      }
    }
    for (let i = active.length - 1; i >= 0; i--) {
      const lap = active[i];
      if (lap.remaining === 0 && lap.trailing) {
        if (lap.packets.length > 0) out.set(lap.meta.id, lap.packets);
        active.splice(i, 1);
      }
    }
  }
  return out;
}

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
  if (lapMetas.length === 0) return new Map();
  if (!source.rawFile.endsWith(".motec.zip")) {
    return parseSessionLapsBatchedFromSource(source, lapMetas);
  }
  const serverGame = getServerGame(source.gameId);
  const loaded = await loadSessionSource(source);
  const out = new Map<number, TelemetryPacket[]>();
  if (loaded.kind === "packets") {
    for (const meta of lapMetas) {
      const start = packetIndexForOffset(source.gameId, meta.rawByteOffset, loaded.offsetEncoding);
      const packets = replayCanonicalLap(loaded.packets, start, meta.rawFrameCount, serverGame);
      if (packets.length > 0) out.set(meta.id, packets);
    }
    return out;
  }
  return out;
}

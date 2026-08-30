import { eq, and } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getServerGame } from "../games/registry";
import { normalizeTelemetryPacket } from "../telemetry/normalization";
import type { ComparisonAlignmentIndex } from "../lap-analysis/comparison";
import { loadSessionSource, clearRawFileCacheForTest as clearSourceCaptureCache, type SessionCaptureSource } from "../session-capture/source-loader";

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
    const packets = loaded.packets;
    for (const packet of packets) normalizeReplayPacket(packet, getServerGame(gameId));
    return packets;
  }
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const buf = loaded.buffer;
  const packets: TelemetryPacket[] = [];
  let offset = 12;
  while (offset + 4 <= buf.length) {
    const frameLen = buf.readUInt32LE(offset); offset += 4;
    if (frameLen <= 0 || offset + frameLen > buf.length) break;
    const sourceFrame = buf.subarray(offset, offset + frameLen); offset += frameLen;
    try { const packet = serverGame.tryParse(sourceFrame, state); if (packet) { normalizeReplayPacket(packet, serverGame); packets.push(packet); } } catch {}
  }
  return packets;
}
export async function parseRawLapFrames(source: SessionCaptureSource, rawByteOffset: number, rawFrameCount: number): Promise<TelemetryPacket[]> {
  const loaded = await loadSessionSource(source);
  if (loaded.kind === "packets") {
    const packets = loaded.packets.slice(rawByteOffset, rawByteOffset + rawFrameCount + 1);
    for (const packet of packets) normalizeReplayPacket(packet, getServerGame(source.gameId));
    if (packets.length > rawFrameCount) packets.pop();
    return packets;
  }
  return parseRawLapFramesFromBuffer(loaded.buffer, rawByteOffset, rawFrameCount, source.gameId, source.rawFile);
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
  // Start at 12 to skip the meta frame.
  let warmupOffset = 12;
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
        packets.push(packet);
      } else {
        // Extra trailing frame = the next-lap trigger. It carries real
        // speed/throttle/etc. values for the finish-line crossing, but its
        // CurrentLap has already reset for the new lap.
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
 * can't be located in the frame stream are omitted — the caller falls back to
 * the per-lap path for those.
 */
export async function parseSessionLapsBatched(source: SessionCaptureSource, lapMetas: { id: number; rawByteOffset: number; rawFrameCount: number }[]): Promise<Map<number, TelemetryPacket[]>> {
  const out = new Map<number, TelemetryPacket[]>();
  if (lapMetas.length === 0) return out;
  const serverGame = getServerGame(source.gameId);
  const state = serverGame.createParserState?.() ?? null;
  const buf = await loadSessionCapture(source);

  const metas = [...lapMetas].sort((a, b) => a.rawByteOffset - b.rawByteOffset);
  const firstOffset = metas[0].rawByteOffset;
  if (firstOffset >= buf.length) return out; // all past EOF — fall back per-lap

  // Warm up the parser state by replaying frames from the start of the file up
  // to the first requested lap (start at 12 to skip the meta frame). Same
  // best-effort replay parseRawLapFrames does, done ONCE for the whole batch.
  let offset = 12;
  while (offset < firstOffset && offset + 4 <= buf.length) {
    const wLen = buf.readUInt32LE(offset);
    if (wLen <= 0 || offset + 4 + wLen > buf.length) break;
    const wBuf = buf.subarray(offset + 4, offset + 4 + wLen);
    offset += 4 + wLen;
    try {
      serverGame.tryParse(wBuf, state);
    } catch {
      /* warmup best-effort */
    }
  }

  // Boundary walk from the first lap to EOF: record each frame's start offset so
  // stored lap offsets map to frame indices. No parsing here — just length
  // headers, so this is cheap even for a long session file.
  const frameStarts: number[] = [];
  const offsetToIdx = new Map<number, number>();
  let cursor = firstOffset;
  while (cursor + 4 <= buf.length) {
    const len = buf.readUInt32LE(cursor);
    if (len <= 0 || cursor + 4 + len > buf.length) break;
    offsetToIdx.set(cursor, frameStarts.length);
    frameStarts.push(cursor);
    cursor += 4 + len;
  }

  // Resolve each lap to a frame index range; the last lap bounds how far we parse.
  const resolved: { id: number; startIdx: number; frameCount: number }[] = [];
  let maxIdx = -1;
  for (const meta of metas) {
    const startIdx = offsetToIdx.get(meta.rawByteOffset);
    if (startIdx === undefined) continue; // unaligned — caller falls back
    resolved.push({ id: meta.id, startIdx, frameCount: meta.rawFrameCount });
    // +1 for the trailing finish frame (see parseRawLapFrames' readCount).
    maxIdx = Math.max(maxIdx, startIdx + meta.rawFrameCount);
  }
  if (resolved.length === 0) return out;

  // Parse frames [0 .. maxIdx] once each, applying the same normalization as
  // parseRawLapFrames. `parsed[i]` is null when tryParse returns nothing (e.g. a
  // stateful accumulator still assembling a packet).
  const lastFrame = Math.min(maxIdx, frameStarts.length - 1);
  const parsed: (TelemetryPacket | null)[] = new Array(lastFrame + 1).fill(null);
  for (let i = 0; i <= lastFrame; i++) {
    const start = frameStarts[i];
    const len = buf.readUInt32LE(start);
    const sourceFrame = buf.subarray(start + 4, start + 4 + len);
    try {
      const packet = serverGame.tryParse(sourceFrame, state);
      if (!packet) continue;
      normalizeReplayPacket(packet, serverGame);
      parsed[i] = packet;
    } catch {
      /* single bad frame — skip, matches per-lap tolerance */
    }
  }

  // Slice per lap: its packets are the non-null parses among its rawFrameCount
  // frames, plus the synthesized finish packet from the trailing frame.
  for (const lap of resolved) {
    const end = lap.startIdx + lap.frameCount; // exclusive; index of trailing frame
    const packets: TelemetryPacket[] = [];
    for (let i = lap.startIdx; i < end && i < parsed.length; i++) {
      const p = parsed[i];
      if (p) packets.push(p);
    }
    // Trailing frame = next-lap trigger; synthesize a finish packet using the
    // same adapter policy as the individual decoder.
    appendDelayedFinishPacket(packets, parsed[end], serverGame);
    if (packets.length > 0) out.set(lap.id, packets);
  }

  return out;
}

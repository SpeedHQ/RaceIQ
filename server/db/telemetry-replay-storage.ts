import { eq, and } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { LiveEngineerReplaySourceProfileV1 } from "../../shared/racing/live/engineer-replay-contracts";
import { getServerGame } from "../games/registry";
import { parseAccBroadcastMessage } from "../games/acc/broadcast-protocol";
import { AccBroadcastState, attachAccBroadcastSnapshot } from "../games/acc/broadcast-state";
import { unpackTriplet } from "../games/kunos/pack-triplet";
import { GRAPHICS } from "../games/acc/structs";
import { isIRacingSessionFrame } from "../games/iracing/source-frame";
import { normalizeTelemetryPacket } from "../telemetry/normalization";
import type { LapSetAlignmentIndex } from "../../shared/racing/laps/alignment/build";
import type { ComparisonAlignmentIndex } from "../lap-analysis/comparison";
import { loadSessionSource, iterateSessionCaptureFrames, iterateSessionCaptureRecordsFromSource, indexCaptureFrames, clearRawFileCacheForTest as clearSourceCaptureCache, type SessionCaptureSource } from "../session-capture/source-loader";
import { iterateSessionCaptureRecords } from "../session-capture/framing";
import { legacyMotecOffsetToPacketIndex } from "../motec/source-archive";
import { countFullPacketMaterialized, countParserStatePrime, countSourceFrameScanned } from "../session-capture/test-instrumentation";

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
interface AlignedTelemetryCacheEntry {
  kind: "aligned";
  body?: string;
  alignmentIndex?: LapSetAlignmentIndex;
  bytes: number;
  ids: number[];
}

type CacheEntry = TelemetryCacheEntry | ComparisonCacheEntry | AlignedTelemetryCacheEntry;

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


function alignedKey(ids: readonly number[]): string { return `aligned:${ids.join(",")}`; }
function alignedBytes(body: string | undefined, index: LapSetAlignmentIndex | undefined): number {
  return (body ? Buffer.byteLength(body, "utf8") : 0) + (index ? [...index.distancesByLapId.values()].reduce((sum, values) => sum + values.length * 8, 0) : 0);
}
export function alignedTelemetryCacheGet(ids: readonly number[]): string | undefined {
  const entry = telemetryCache.get(alignedKey(ids));
  if (entry?.kind !== "aligned" || entry.body === undefined) return undefined;
  touch(alignedKey(ids), entry); return entry.body;
}
export function alignedTelemetryCacheSet(ids: readonly number[], body: string): void {
  const key = alignedKey(ids); const existing = telemetryCache.get(key);
  if (existing) cacheBytesUsed -= existing.bytes;
  const entry: AlignedTelemetryCacheEntry = { kind: "aligned", body, bytes: alignedBytes(body, existing?.kind === "aligned" ? existing.alignmentIndex : undefined), ids: [...ids] };
  telemetryCache.set(key, entry); cacheBytesUsed += entry.bytes; evictUntilWithinBudget();
}
export function lapSetAlignmentIndexCacheGet(ids: readonly number[]): LapSetAlignmentIndex | undefined {
  const entry = telemetryCache.get(alignedKey(ids));
  if (entry?.kind !== "aligned" || !entry.alignmentIndex) return undefined;
  touch(alignedKey(ids), entry); return entry.alignmentIndex;
}
export function lapSetAlignmentIndexCacheSet(ids: readonly number[], alignmentIndex: LapSetAlignmentIndex): void {
  const key = alignedKey(ids); const existing = telemetryCache.get(key);
  if (existing) cacheBytesUsed -= existing.bytes;
  const body = existing?.kind === "aligned" ? existing.body : undefined;
  const entry: AlignedTelemetryCacheEntry = { kind: "aligned", body, alignmentIndex, bytes: alignedBytes(body, alignmentIndex), ids: [...ids] };
  telemetryCache.set(key, entry); cacheBytesUsed += entry.bytes; evictUntilWithinBudget();
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
    if ((entry.kind === "comparison" && (entry.idA === id || entry.idB === id)) || (entry.kind === "aligned" && entry.ids.includes(id))) {
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
  const boundaryAdvanced = (trailing.LapNumber ?? 0) > (last.LapNumber ?? 0);
  if (
    finishTime <= (last.CurrentLap ?? 0) ||
    (finishTime === last.LastLap && !boundaryAdvanced)
  ) return;
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
 * Stream every parsed packet from a completed session, including the session
 * tail where authoritative finish packets may arrive after the final lap.
 */
export async function getSessionTelemetry(sessionId: number, gameId: GameId): Promise<TelemetryPacket[]> {
  return (await getSessionTelemetryReplaySource(sessionId, gameId)).packets;
}
export interface SessionTelemetryReplaySource {
  packets: TelemetryPacket[];
  sourceProfile: LiveEngineerReplaySourceProfileV1;
}

export async function getSessionTelemetryReplaySource(sessionId: number, gameId: GameId): Promise<SessionTelemetryReplaySource> {
  const session = await db.select({
    rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId,
    carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal,
  }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.gameId, gameId))).get();
  const rawFile = session?.rawFile ?? "";
  const packets: TelemetryPacket[] = [];
  let validBroadcastRecords = 0;
  let malformedBroadcastRecords = 0;
  let missingBroadcastFrame = false;
  let segmentCount = 0;
  let capturedClockFrames = 0;
  let skippedMalformedFrames = 0;
  if (session?.rawFile) {
    const loaded = await loadSessionSource({
      rawFile: session.rawFile, source: session.source, gameId,
      carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal,
    });
    const serverGame = getServerGame(gameId);
    if (loaded.kind === "packets") {
      for (const sourcePacket of loaded.packets) {
        const packet = freshReplayPacket(sourcePacket);
        normalizeReplayPacket(packet, serverGame);
        packets.push(packet);
      }
      segmentCount = 1;
    } else {
      let state = serverGame.createParserState?.() ?? null;
      let replayClock = 0;
      let frameClock: number | null = null;
      let previousSequence: number | null = null;
      let sawBroadcastInSegment = false;
      const replayBroadcast = gameId === "acc" ? new AccBroadcastState({ now: () => replayClock }) : null;
      let inContext = false;
      for (const record of iterateSessionCaptureRecords(loaded.buffer)) {
        if (record.kind === "segment-boundary") {
          segmentCount++;
          state = serverGame.createParserState?.() ?? null;
          replayBroadcast?.reset();
          replayClock = 0;
          frameClock = null;
          previousSequence = null;
          sawBroadcastInSegment = false;
          inContext = false;
          continue;
        }
        if (record.kind === "segment-context") {
          inContext = true;
          continue;
        }
        if (record.kind === "segment-context-end") {
          inContext = false;
          previousSequence = null;
          frameClock = null;
          continue;
        }
        if (record.kind === "acc-broadcast") {
          validBroadcastRecords++;
          sawBroadcastInSegment = true;
          for (const event of record.batch.events) {
            replayClock = event.receivedAtMs;
            if (previousSequence !== null) {
              const distance = (event.sequence - previousSequence) >>> 0;
              if (inContext ? distance === 0 || distance >= 0x80000000 : distance !== 1) {
                replayBroadcast?.markMalformed("sequence-gap");
              }
            }
            previousSequence = event.sequence;
            if (event.kind === "datagram") {
              const message = parseAccBroadcastMessage(event.payload);
              if (message) replayBroadcast?.apply(message, event.receivedAtMs);
              else replayBroadcast?.markMalformed("malformed-datagram");
            } else if (event.kind === "socket-open") replayBroadcast?.setSocketConnected(true);
            else if (event.kind === "socket-close" || event.kind === "socket-error") replayBroadcast?.setSocketConnected(false);
            else if (event.kind === "explicit-reset") replayBroadcast?.reset();
            else if (event.kind === "queue-overflow") replayBroadcast?.markMalformed("capture-overflow");
          }
          replayClock = record.batch.frameReceivedAtMs;
          frameClock = replayClock;
          continue;
        }
        if (record.kind === "acc-broadcast-malformed") {
          malformedBroadcastRecords++;
          sawBroadcastInSegment = true;
          replayBroadcast?.markMalformed("malformed-capture-record");
          frameClock = null;
          previousSequence = null;
          continue;
        }
        if (record.kind !== "frame") continue;
        if (segmentCount === 0) segmentCount = 1;
        const capturedFrameClock = frameClock;
        frameClock = null;
        if (!inContext && replayBroadcast && sawBroadcastInSegment && capturedFrameClock === null) {
          replayBroadcast.markMalformed("malformed-capture-record");
          missingBroadcastFrame = true;
        }
        try {
          const packet = serverGame.tryParse(record.frame, state);
          if (!packet) continue;
          if (replayBroadcast) {
            const triplet = unpackTriplet(record.frame);
            const playerCarIndex = triplet && triplet.graphics.length >= GRAPHICS.playerCarID.offset + 4
              ? triplet.graphics.readInt32LE(GRAPHICS.playerCarID.offset) : -1;
            replayBroadcast.setPlayerCarIndex(playerCarIndex);
            attachAccBroadcastSnapshot(packet, playerCarIndex, replayBroadcast.snapshot());
            if (capturedFrameClock !== null) packet.TimestampMS = capturedFrameClock;
          }
          if (!inContext) {
            if (replayBroadcast && capturedFrameClock !== null) capturedClockFrames++;
            packets.push(packet);
          }
        } catch {
          skippedMalformedFrames++;
          // One malformed native frame must not discard the session.
        }
      }
    }
  }
  const captureKind = rawFile.endsWith(".motec.zip") ? "motec-packets" : rawFile.endsWith(".gz") ? "compressed-capture" : "capture";
  const sourceClockCaptured = gameId === "iracing" || gameId === "f1-2025" || (gameId === "acc" && packets.length > 0 && capturedClockFrames === packets.length);
  const opponentSourceCapture = gameId === "acc" ? {
    source: "acc-broadcast" as const,
    status: malformedBroadcastRecords > 0 || missingBroadcastFrame ? "malformed" as const : validBroadcastRecords > 0 ? "captured" as const : "unavailable" as const,
    recordCount: validBroadcastRecords,
  } : null;
  return {
    packets,
    sourceProfile: {
      gameId,
      captureKind,
      limitations: gameId === "fm-2023"
        ? ["player-only-telemetry", "source-clock-not-captured"]
        : gameId === "acc"
          ? [
            ...(validBroadcastRecords === 0 ? ["persisted-source-not-captured:broadcast"] : []),
            ...(sourceClockCaptured ? ["source-clock-captured:acc-broadcast"] : ["source-clock-not-captured"]),
            ...(malformedBroadcastRecords > 0 || missingBroadcastFrame ? ["malformed-source-record:acc-broadcast"] : []),
          ]
          : gameId === "ac-evo"
            ? ["persisted-source-not-captured:broadcast", "source-clock-not-captured", "inherited-acc-broadcast-mappings-excluded"]
            : gameId === "f1-2025"
              ? ["no-game-branch:spotter"]
              : ["native-spotter-requires-captured-car-left-right", "v2-and-ibt-session-info-limitations"],
      sourceClockCaptured,
      opponentSourceCapture,
      segmentCount,
      skippedMalformedFrames,
      nativeSessionInfo: gameId === "iracing",
      retainedPrefix: rawFile.length > 0,
    },
  };
}

export async function* iterateSessionTelemetry(sessionId: number, gameId: GameId): AsyncGenerator<TelemetryPacket> {
  const session = await db.select({
    rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId,
    carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal,
  }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.gameId, gameId))).get();
  if (!session?.rawFile) return;
  const source = {
    rawFile: session.rawFile, source: session.source, gameId,
    carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal,
  };
  if (session.rawFile.endsWith(".motec.zip")) {
    const loaded = await loadSessionSource(source);
    if (loaded.kind !== "packets") throw new Error("Expected canonical packet source");
    const serverGame = getServerGame(gameId);
    for (const original of loaded.packets) {
      const packet = freshReplayPacket(original);
      normalizeReplayPacket(packet, serverGame);
      yield packet;
    }
    return;
  }
  const serverGame = getServerGame(gameId);
  let state = serverGame.createParserState?.() ?? null;
  let inContext = false;
  for await (const record of iterateSessionCaptureRecordsFromSource(source)) {
    if (record.kind === "segment-boundary") {
      state = serverGame.createParserState?.() ?? null;
      inContext = false;
      continue;
    }
    if (record.kind === "segment-context") { inContext = true; continue; }
    if (record.kind === "segment-context-end") { inContext = false; continue; }
    if (record.kind !== "frame") continue;
    let packet: TelemetryPacket | null;
    try {
      countFullPacketMaterialized();
      packet = serverGame.tryParse(record.frame, state);
      if (packet) normalizeReplayPacket(packet, serverGame);
    } catch {
      continue;
    }
    if (packet && !inContext) yield packet;
  }
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
  for await (const { offset, prefixOffset, frame } of iterateSessionCaptureFrames(source)) {
    fileSize = Math.max(fileSize, offset + 4 + frame.length);
    if (!found) {
      if (offset < rawByteOffset) {
        if (state != null && serverGame.primeParserState) {
          try { countParserStatePrime(); serverGame.primeParserState(frame, state); } catch {}
        }
        continue;
      }
      if (offset !== rawByteOffset && prefixOffset !== rawByteOffset) {
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
  if (!startRecord) {
    throw new LapParseError(`Lap raw byte offset ${rawByteOffset} is not aligned to a capture frame in ${rawFile}`, {
      rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: 0, reason: "truncated-frame",
    });
  }
  const packets: TelemetryPacket[] = [];
  let framesRead = 0;
  for (let i = startRecord.frameIndex; i < frameIndex.records.length && framesRead <= rawFrameCount; i++) {
    const record = frameIndex.records[i]!;
    const sourceFrame = buf.subarray(record.offset + 4, record.offset + 4 + record.length);
    const packet = parseReplayFrame(sourceFrame, serverGame, state);
    if (framesRead < rawFrameCount) {
      if (packet) packets.push(packet);
    } else {
      appendDelayedFinishPacket(packets, packet, serverGame);
    }
    framesRead++;
  }
  if (framesRead < rawFrameCount) {
    throw new LapParseError(`Capture ended before ${rawFrameCount} lap frames were read`, {
      rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: packets.length, reason: "truncated-frame",
    });
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
  let state = serverGame.createParserState?.() ?? null;
  const metas = [...lapMetas].sort((a, b) => a.rawByteOffset - b.rawByteOffset);
  const active: Array<{ meta: (typeof lapMetas)[number]; packets: TelemetryPacket[]; end: number }> = [];
  let nextMeta = 0;
  let frameIndex = 0;
  for await (const { offset, frame } of iterateSessionCaptureFrames(source)) {
    countSourceFrameScanned();
    while (nextMeta < metas.length && metas[nextMeta]!.rawByteOffset < offset) nextMeta++;
    while (nextMeta < metas.length && metas[nextMeta]!.rawByteOffset === offset) {
      const meta = metas[nextMeta++]!;
      active.push({ meta, packets: [], end: frameIndex + meta.rawFrameCount });
    }
    if (nextMeta === metas.length && active.length === 0) break;
    const needsFull = active.some((lap) => frameIndex <= lap.end);
    if (!needsFull && state == null) {
      frameIndex++;
      continue;
    }
    let packet: TelemetryPacket | null = null;
    try {
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
      if (frameIndex < lap.end) {
        if (packet) lap.packets.push(packet);
      } else if (frameIndex === lap.end) {
        appendDelayedFinishPacket(lap.packets, packet, serverGame);
      }
    }
    for (let index = active.length - 1; index >= 0; index--) {
      const lap = active[index]!;
      if (frameIndex >= lap.end) {
        if (lap.packets.length > 0) out.set(lap.meta.id, lap.packets);
        active.splice(index, 1);
      }
    }
    frameIndex++;
  }
  for (const lap of active) if (lap.packets.length > 0) out.set(lap.meta.id, lap.packets);
  return out;
}

import { dirname, resolve } from "node:path";
import { and, eq, lt } from "drizzle-orm";
import { Schema } from "effect";
import { LiveArchiveMemberSchema, matchesNativeRecord, type ArchiveChunk, type Chunk } from "@raceiq/capture-splitting";
import { F1_HEADER_SIZE, F1_PACKET_IDS, parseF1Header } from "@raceiq/capture-formats/f1-2025/f1-wire";
import { isIRacingSessionFrame } from "@raceiq/capture-formats/iracing/source-frame";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_TELEMETRY } from "@raceiq/capture-formats/lmu/layout";
import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import { classifyLapAttribution, type CapturedDriverBinding, type DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { db } from "../db/index";
import { laps, sessions, lapGuidReconciliation, liveCaptureMembers, originalActivitySourceLaps } from "../db/schema";
import { getLocalAccountOwner } from "../db/local-account-queries";
import { getLiveLapCaptureSnapshot } from "../db/live-capture-queries";
import { stintSchema } from "./portable-metadata";
import { iterateOriginalCapturePartRecords, iterateSessionCaptureRecordsFromSource, resolveLapCaptureArtifact, resolveLiveLapCaptureArtifact, type SessionCapturePart, type SessionCaptureSource } from "./source-loader";
import { recordedCaptureFrameClock, recordedCaptureClockAnchor } from "./frame-time";

export type OnlineLapSourceHoldReason = "source_unavailable" | "source_context_unavailable" | "source_identity_unavailable" |
  "driver_identity_required" | "lap_identity_conflict" | "lap_owner_conflict" | "unsupported_game" | "invalid_lap";

export class OnlineLapSourceError extends Error {
  readonly code: OnlineLapSourceHoldReason;
  constructor(code: OnlineLapSourceHoldReason) {
    super(code);
    this.name = "OnlineLapSourceError";
    this.code = code;
  }
}

/** Private worker input, never a renderer/read-model DTO. */
export type OnlineSourceContextPart = SessionCapturePart;

/** One immutable published lap artifact; whole-activity completeness is a separate proof. */
export interface OnlineLapSource {
  readonly lapId: number;
  readonly sessionId: number;
  readonly gameId: GameId;
  readonly carId: string;
  readonly trackId: string;
  readonly lapGuid: string;
  readonly originalActivityId: string;
  readonly sourceRevision: string;
  readonly ownerUserId: string;
  readonly sourceKind: "native_capture" | "verified_portable";
  readonly frameClock: "capture_utc" | "unknown";
  readonly clockAnchor: { readonly frameTimeMs: number; readonly utcTimeMs: number } | null;
  readonly sourceClock: { readonly domain: string; readonly startMs: number; readonly endMs: number };
  readonly driverAttributionStints: readonly DriverAttributionStint[];
  readonly capturedBinding: CapturedDriverBinding;
  readonly lapNumber: number;
  readonly lapTime: number;
  readonly sectorTimes: readonly number[] | null;
  readonly totalTimeMs: number | null;
  readonly sectorTimesMs: readonly number[] | null;
  readonly recordedAt: string | null;
  readonly createdAt: string;
  readonly carSetup: string | null;
  readonly tuneId: number | null;
  readonly capture: SessionCaptureSource;
  readonly window: { readonly startByteOffset: number; readonly frameCount: number; readonly trailingContextFrameCount: number };
  readonly publicationIdentity: string;
  readonly contextParts: readonly OnlineSourceContextPart[];
}

export type OnlineLapSourceResult = { readonly kind: "ready"; readonly source: OnlineLapSource } |
  { readonly kind: "held"; readonly reason: OnlineLapSourceHoldReason };
export interface OnlineLapSourceRecord {
  readonly record: SessionCaptureRecord;
  readonly scope: "context" | "lap" | "trailing_context";
}

function sameBinding(a: CapturedDriverBinding, b: CapturedDriverBinding): boolean {
  // Captured revisions/confirmation may change without changing the native actor.
  // Keep every original snapshot in stints; resolve one real captured descriptor.
  return a.gameId === b.gameId && a.sourceKind === b.sourceKind && a.nativeIdentity === b.nativeIdentity;
}

/** No current per-game binding lookup: historical identity must come from its captured stints. */
export async function readOnlineLapSource(lapId: number): Promise<OnlineLapSourceResult> {
  const held = (reason: OnlineLapSourceHoldReason): OnlineLapSourceResult => ({ kind: "held", reason });
  const row = await db.select({ lap: laps, session: sessions, identity: lapGuidReconciliation }).from(laps)
    .innerJoin(sessions, eq(sessions.id, laps.sessionId))
    .leftJoin(lapGuidReconciliation, eq(lapGuidReconciliation.lapId, laps.id)).where(eq(laps.id, lapId)).get();
  if (!row) return held("source_unavailable");
  const { lap, session, identity } = row;
  const gameId = KNOWN_GAME_IDS.find((id) => id === session.gameId);
  if (!gameId || gameId === "fm-2023") return held("unsupported_game");
  if (session.ownership !== "mine" || session.source === "cloud-import" || session.cloudImportOrigin !== null ||
      !session.ownerUserId || session.ownerUserId !== await getLocalAccountOwner() ||
      (session.sourceAuthorUserId !== null && session.sourceAuthorUserId !== session.ownerUserId)) return held("lap_owner_conflict");
  if (!lap.isValid || !Number.isFinite(lap.lapTime) || lap.lapTime <= 0 || lap.invalidReason === "incomplete") return held("invalid_lap");
  if (!lap.lapGuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lap.lapGuid) ||
      identity?.status !== "resolved" || identity.lapGuid?.toLowerCase() !== lap.lapGuid.toLowerCase()) return held("lap_identity_conflict");
  if (!session.originalActivityId || !session.originalSourceRevision) return held("source_identity_unavailable");
  let sourceKind: OnlineLapSource["sourceKind"] = "native_capture";
  if (!session.nativeCaptureOrigin) {
    const proof = await db.select().from(originalActivitySourceLaps)
      .where(eq(originalActivitySourceLaps.lapGuid, lap.lapGuid.toLowerCase())).get();
    if (!proof || proof.ownerUserId !== session.ownerUserId ||
        proof.originalActivityId !== session.originalActivityId || proof.sourceRevision !== session.originalSourceRevision) return held("source_identity_unavailable");
    sourceKind = "verified_portable";
  }
  const parsed = stintSchema.array().safeParse(lap.driverAttributionStints);
  const { sourceClockDomain: domain, sourceLapStartMs: startMs, sourceLapEndMs: endMs } = lap;
  if (!parsed.success || !domain || startMs === null || endMs === null ||
      classifyLapAttribution(parsed.data, startMs, endMs, domain) !== "Self") return held("driver_identity_required");
  let capturedBinding: CapturedDriverBinding | undefined;
  for (const stint of parsed.data) {
    if (stint.startMs >= endMs || (stint.endMs !== null && stint.endMs <= startMs)) continue;
    if (!stint.bindingSnapshot || stint.bindingSnapshot.gameId !== gameId ||
        (capturedBinding && !sameBinding(capturedBinding, stint.bindingSnapshot))) return held("driver_identity_required");
    capturedBinding = stint.bindingSnapshot;
  }
  if (!capturedBinding || !session.carId || !session.trackId || !lap.captureChunkId) return held("source_unavailable");

  try {
    let capture: SessionCaptureSource;
    let chunk: Chunk | ArchiveChunk;
    let publicationIdentity: string;
    const contextParts: OnlineSourceContextPart[] = [];
    const base = { source: session.source, gameId, carId: session.carId, trackId: session.trackId, captureFormatVersion: session.captureFormatVersion };
    if (session.captureLayoutVersion === 3) {
      const live = await getLiveLapCaptureSnapshot(session.id, lap.id);
      if (!live) return held("source_unavailable");
      const artifact = resolveLiveLapCaptureArtifact(live.archivePath, live.snapshot);
      capture = { ...base, rawFile: artifact.path, artifact: artifact.artifact };
      chunk = artifact.chunk;
      publicationIdentity = artifact.publicationIdentity;
      const previous = await db.select({ descriptor: liveCaptureMembers.descriptor }).from(liveCaptureMembers)
        .where(and(eq(liveCaptureMembers.captureEpoch, live.snapshot.captureEpoch), lt(liveCaptureMembers.generation, live.snapshot.member.generation)))
        .orderBy(liveCaptureMembers.generation).all();
      for (const memberRow of previous) {
        const member = Schema.decodeSync(Schema.fromJsonString(LiveArchiveMemberSchema))(memberRow.descriptor);
        const previousArtifact = resolveLiveLapCaptureArtifact(live.archivePath, { ...live.snapshot, member });
        contextParts.push({ capture: { ...base, rawFile: previousArtifact.path, artifact: previousArtifact.artifact }, chunk: previousArtifact.chunk });
      }
    } else {
      if (!session.captureManifestFile || ![1, 2].includes(session.captureLayoutVersion ?? 0)) return held("source_unavailable");
      const artifact = await resolveLapCaptureArtifact(session.captureManifestFile, lap.captureChunkId, lap.id, {
        captureLayoutVersion: session.captureLayoutVersion, captureArchiveFile: session.captureArchiveFile, lapGuid: lap.lapGuid,
      });
      if (artifact.manifest.gameId !== gameId) return held("source_identity_unavailable");
      capture = { ...base, rawFile: artifact.path, ...(artifact.artifact ? { artifact: artifact.artifact } : {}) };
      chunk = artifact.chunk;
      publicationIdentity = artifact.publicationIdentity;
      for (const previous of artifact.manifest.chunks) {
        if (previous.id === chunk.id) break;
        if (previous.sourceEnd > chunk.sourceStart) return held("source_context_unavailable");
        if (artifact.manifest.version === 4 && "entryName" in previous && artifact.artifact) {
          contextParts.push({ capture: { ...base, rawFile: artifact.path, artifact: { ...artifact.artifact, entryName: previous.entryName } }, chunk: previous,
            manifestPath: session.captureManifestFile, manifestSourceRevision: artifact.manifest.sourceRevision });
        } else if ("path" in previous) {
          contextParts.push({ capture: { ...base, rawFile: resolve(dirname(session.captureManifestFile), previous.path) }, chunk: previous,
            manifestPath: session.captureManifestFile, manifestSourceRevision: artifact.manifest.sourceRevision });
        } else return held("source_context_unavailable");
      }
    }
    if (chunk.lapGuid?.toLowerCase() !== lap.lapGuid.toLowerCase() || chunk.originalActivityId !== session.originalActivityId ||
        chunk.originalSourceRevision !== session.originalSourceRevision || chunk.ownedFrameByteOffset === undefined ||
        chunk.ownedFrameCount === undefined || chunk.ownedFrameCount <= 0 ||
        (chunk.sourceClockDomain !== undefined && chunk.sourceClockDomain !== domain) ||
        (chunk.sourceLapStartMs !== undefined && chunk.sourceLapStartMs !== startMs) ||
        (chunk.sourceLapEndMs !== undefined && chunk.sourceLapEndMs !== endMs)) return held("source_identity_unavailable");
    return { kind: "ready", source: {
      lapId: lap.id, sessionId: session.id, gameId, carId: session.carId, trackId: session.trackId,
      lapGuid: lap.lapGuid.toLowerCase(), originalActivityId: session.originalActivityId,
      sourceRevision: session.originalSourceRevision, ownerUserId: session.ownerUserId, sourceKind,
      frameClock: recordedCaptureFrameClock(session), clockAnchor: recordedCaptureClockAnchor(session.captureClockAnchorJson),
      sourceClock: { domain, startMs, endMs }, driverAttributionStints: parsed.data, capturedBinding,
      lapNumber: lap.lapNumber, lapTime: lap.lapTime, sectorTimes: lap.sectorTimes,
      totalTimeMs: lap.totalTimeMs, sectorTimesMs: lap.sectorTimesMs, recordedAt: lap.recordedAt, createdAt: lap.createdAt,
      carSetup: lap.carSetup, tuneId: lap.tuneId, capture,
      window: { startByteOffset: chunk.ownedFrameByteOffset, frameCount: chunk.ownedFrameCount, trailingContextFrameCount: chunk.trailingContextFrameCount ?? 0 },
      publicationIdentity, contextParts,
    } };
  } catch {
    // Filesystem and schema errors can contain private paths/actors; only a stable hold leaves this boundary.
    return held("source_unavailable");
  }
}


/**
 * Actual context records only. F1 keeps bounded last packets; stateful iRacing
 * context is streamed for hydration, not published as preceding telemetry laps.
 * Public codecs must omit opaque parser-bootstrap payloads and private binding snapshots.
 */
export async function* iterateOnlineLapSourceRecords(source: OnlineLapSource): AsyncGenerator<OnlineLapSourceRecord> {
  try {
    yield* iteratePrimedNativeLapSource(source);
  } catch (error) {
    if (error instanceof OnlineLapSourceError) throw error;
    throw new OnlineLapSourceError("source_context_unavailable");
  }
}

async function* iteratePrimedNativeLapSource(source: OnlineLapSource): AsyncGenerator<OnlineLapSourceRecord> {
  if (source.gameId === "fm-2023") throw new OnlineLapSourceError("unsupported_game");
  type NativeFrame = Extract<SessionCaptureRecord, { kind: "frame" }>;
  let firstOwned: NativeFrame | undefined;
  let clockAnchor: Extract<SessionCaptureRecord, { kind: "clock-anchor" }> | null = null;
  const lmuPrefix: NativeFrame[] = [];
  let lmuPrefixBoundary = false;
  for await (const record of iterateSessionCaptureRecordsFromSource(source.capture, { strict: true })) {
    if (record.kind === "clock-anchor") clockAnchor = record;
    if (record.offset === source.window.startByteOffset && record.kind === "frame") { firstOwned = record; break; }
    if (record.offset > source.window.startByteOffset) break;
    if (source.gameId === "lmu") {
      if (record.kind === "segment-boundary") { lmuPrefix.length = 0; lmuPrefixBoundary = true; }
      if (record.kind === "frame") {
        lmuPrefix.push(record);
        if (lmuPrefix.length > 2) lmuPrefix.shift();
      }
    }
  }
  if (!firstOwned) throw new OnlineLapSourceError("source_context_unavailable");
  if (clockAnchor) {
    if ((source.clockAnchor && (source.clockAnchor.utcTimeMs - source.clockAnchor.frameTimeMs !== clockAnchor.utcTimeMs - clockAnchor.frameTimeMs))
      || (source.frameClock === "capture_utc" && clockAnchor.frameTimeMs !== clockAnchor.utcTimeMs)) throw new OnlineLapSourceError("source_identity_unavailable");
    yield { record: clockAnchor, scope: "context" };
  }
  if (source.gameId === "lmu") {
    let history: NativeFrame[] = [];
    if (!lmuPrefixBoundary) {
      // Original member records exclude synthetic checkpoints and duplicated finish triggers.
      for (let index = source.contextParts.length - 1; index >= 0; index--) {
        const part: NativeFrame[] = [];
        let boundary = false;
        for await (const record of iterateOriginalCapturePartRecords(source.contextParts[index]!)) {
          if (record.kind === "segment-boundary") { part.length = 0; boundary = true; }
          if (record.kind === "frame") {
            part.push(record);
            if (part.length > 2) part.shift();
          }
        }
        history = [...part, ...history].slice(-2);
        if (history.length === 2 || boundary) break;
      }
    }
    const latest = history.at(-1);
    if (latest && !decodeLMUSourceFrame(latest.frame)) throw new OnlineLapSourceError("source_context_unavailable");
    for (const record of lmuPrefix) {
      if (!decodeLMUSourceFrame(record.frame)) throw new OnlineLapSourceError("source_context_unavailable");
    }
    // Only an exact predecessor suffix/current-prefix match proves member overlap.
    let overlap = Math.min(history.length, lmuPrefix.length);
    while (overlap > 0) {
      let matches = true;
      for (let index = 0; index < overlap; index++) {
        const previous = history[history.length - overlap + index]!;
        const current = lmuPrefix[index]!;
        if (!matchesNativeRecord(previous, current)) {
          matches = false;
          break;
        }
      }
      if (matches) break;
      overlap--;
    }
    for (let index = overlap; index < lmuPrefix.length; index++) {
      history.push(lmuPrefix[index]!);
    }
    let context = history.slice(-2);
    const last = context.at(-1);
    const native = last ? decodeLMUSourceFrame(last.frame) : null;
    if (last && !native) throw new OnlineLapSourceError("source_context_unavailable");
    if (native && native.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime) * 1000 <= source.sourceClock.startMs) context = context.slice(-1);
    for (const record of context) yield { record, scope: "context" };
  }
  const f1Uid = source.gameId === "f1-2025" && firstOwned.frame.length >= F1_HEADER_SIZE ? parseF1Header(firstOwned.frame).sessionUID : null;
  const f1Packets = new Map<number, { record: SessionCaptureRecord; order: number }>();
  let order = 0;
  let sawIRacingSession = false;
  const evoOwnedAt = firstOwned.frameTimeMs;
  if (source.gameId === "ac-evo" && (typeof evoOwnedAt !== "number" || !Number.isFinite(evoOwnedAt) || evoOwnedAt <= 0)) {
    throw new OnlineLapSourceError("source_context_unavailable");
  }
  // The service permits two actual Evo polls. Never move their clocks or choose
  // older records to manufacture advances; replay must prove freshness or hold.
  const evoCutoff = typeof evoOwnedAt === "number" ? evoOwnedAt - 1000 : Number.NaN;
  const evoPrefix: NativeFrame[] = [];
  const evoHistory: NativeFrame[] = [];
  const collectEvo = (record: SessionCaptureRecord, target: NativeFrame[]): void => {
    if (record.kind !== "frame") return;
    const at = record.frameTimeMs;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || typeof evoOwnedAt !== "number" || at > evoOwnedAt) {
      target.length = 0;
      return;
    }
    if (at < evoCutoff) return;
    const previousAt = target.at(-1)?.frameTimeMs;
    if (previousAt !== undefined && at < previousAt) target.length = 0;
    target.push(record);
    if (target.length > 2) target.shift();
  };
  const inspectContext = (record: SessionCaptureRecord): void => {
    if (record.kind !== "frame") return;
    if (source.gameId === "iracing" && isIRacingSessionFrame(record.frame)) sawIRacingSession = true;
    if (source.gameId !== "f1-2025" || record.frame.length < F1_HEADER_SIZE) return;
    const header = parseF1Header(record.frame);
    if (header.packetFormat !== 2025 || header.sessionUID !== f1Uid || header.packetId === F1_PACKET_IDS.CAR_SETUP) return;
    if (header.packetId > 15) throw new OnlineLapSourceError("source_context_unavailable");
    f1Packets.set(header.packetId, { record, order: order++ });
  };
  const needsPriming = source.gameId === "f1-2025" || source.gameId === "iracing" || source.gameId === "ac-evo";
  if (needsPriming) {
    for await (const record of iterateSessionCaptureRecordsFromSource(source.capture, { strict: true })) {
      if (record.offset >= source.window.startByteOffset) break;
      inspectContext(record);
      if (source.gameId === "ac-evo") collectEvo(record, evoPrefix);
      if (record.kind === "frame" && source.gameId === "iracing") yield { record, scope: "context" };
    }
    for (const part of source.contextParts) {
      if (source.gameId === "ac-evo" && part.chunk.lastTimestamp !== undefined && part.chunk.lastTimestamp < evoCutoff) continue;
      for await (const record of iterateOriginalCapturePartRecords(part)) {
        inspectContext(record);
        if (source.gameId === "ac-evo") collectEvo(record, evoHistory);
        if (record.kind === "frame" && source.gameId === "iracing") yield { record, scope: "context" };
      }
    }
  }
  let owned = 0;
  let trailing = 0;
  let primed = false;
  for await (const record of iterateSessionCaptureRecordsFromSource(source.capture, { strict: true })) {
    if (record.offset < source.window.startByteOffset) {
      if (source.gameId === "f1-2025") inspectContext(record);
      if (record.kind === "frame" && source.gameId === "iracing") yield { record, scope: "context" };
      continue;
    }
    if (!primed) {
      primed = true;
      if (source.gameId === "f1-2025") {
        if (f1Uid === null || ![F1_PACKET_IDS.SESSION, F1_PACKET_IDS.LAP_DATA, F1_PACKET_IDS.PARTICIPANTS].every((id) => f1Packets.has(id))) throw new OnlineLapSourceError("source_context_unavailable");
        for (const packet of [...f1Packets.values()].sort((a, b) => a.order - b.order)) yield { record: packet.record, scope: "context" };
      }
      if (source.gameId === "iracing" && !sawIRacingSession && !isIRacingSessionFrame(firstOwned.frame)) throw new OnlineLapSourceError("source_context_unavailable");
      if (source.gameId === "ac-evo") {
        // Prefer the original member chain. Add only genuinely earlier
        // pre-capture records; replaying an overlapping prefix would reset counters.
        const firstHistoryAt = evoHistory[0]?.frameTimeMs;
        const context = [...evoPrefix.filter((record) => record.frameTimeMs !== undefined &&
          (firstHistoryAt === undefined || record.frameTimeMs < firstHistoryAt)), ...evoHistory].slice(-2);
        if (context.length === 0) throw new OnlineLapSourceError("source_context_unavailable");
        for (const record of context) yield { record, scope: "context" };
      }
    }
    if (record.kind !== "frame") {
      if (owned < source.window.frameCount) throw new OnlineLapSourceError("source_context_unavailable");
      continue;
    }
    if (owned < source.window.frameCount) {
      owned++;
      yield { record, scope: "lap" };
    } else if (trailing < source.window.trailingContextFrameCount) {
      trailing++;
      yield { record, scope: "trailing_context" };
    } else break;
  }
  if (owned !== source.window.frameCount || trailing !== source.window.trailingContextFrameCount) throw new OnlineLapSourceError("source_unavailable");
}

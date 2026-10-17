import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { canonicalTelemetryValue } from "@raceiq/telemetry-core/telemetry/replay/canonicalize";
import type { CanonicalTelemetryEnvelope, CanonicalTelemetryValue, SemanticTelemetryReplay, TelemetryRawReference } from "@raceiq/shared/telemetry/replay/contracts";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import type { ResolvedValue, SourceObservation, TelemetryFrameView, TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getLapById } from "../db/lap-read-queries";
import { getLapReplaySource, type LapReplaySource } from "../db/telemetry-replay-storage";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame, type IRacingValue } from "@raceiq/capture-formats/iracing/source-frame";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { parseIRacingTrackGeography } from "@raceiq/capture-formats/iracing/session-info";
import { loadRawCaptureIdentity, type RawCaptureIdentity, rawCaptureObjectId } from "../session-capture/identity";
export interface QueryLapTelemetryOptions {
  readonly rawCaptureRequirement?: "provenance" | "native-values";
}

const defaultQueryLapTelemetryOptions: Required<QueryLapTelemetryOptions> = {
  rawCaptureRequirement: "provenance",
};


interface ReplayNativeFrame {
  packet: TelemetryPacket;
  nativeValues?: Readonly<Record<string, IRacingValue>>;
}

interface NativeReplayIdentity {
  sessionUID: string;
  sessionTick: number | null;
  sessionTimeMs: number | null;
  values: Readonly<Record<string, IRacingValue>>;
}

function* iterateIRacingNativeFrames(source: LapReplaySource, capture: Buffer | undefined): Generator<Readonly<Record<string, IRacingValue>>, undefined, void> {
  for (const native of iterateIRacingNativeIdentities(source, capture, false)) yield native.values;
}

function* iterateIRacingNativeIdentities(source: LapReplaySource, capture: Buffer | undefined, includeTrailing = true): Generator<NativeReplayIdentity, undefined, void> {
  if (source.gameId !== "iracing" || !capture || source.rawByteOffset == null || source.rawFrameCount == null) return undefined;
  let decoderState = createIRacingSourceDecoderState();
  let replayFrames = 0;
  let found = false;
  let inContext = false;
  let sessionInfo = "";
  let sessionInfoUpdate = -1;
  let trackGeography: Readonly<Record<string, number>> = {};
  const frameLimit = source.rawFrameCount + (includeTrailing ? 1 : 0);
  for (const record of iterateSessionCaptureRecords(capture)) {
    if (record.kind === "segment-boundary") {
      decoderState = createIRacingSourceDecoderState();
      inContext = false;
      sessionInfo = "";
      sessionInfoUpdate = -1;
      trackGeography = {};
      continue;
    }
    if (record.kind === "segment-context") { inContext = true; continue; }
    if (record.kind === "segment-context-end") { inContext = false; continue; }
    if (record.kind !== "frame") continue;
    if (record.offset < source.rawByteOffset) {
      decodeIRacingSourceFrame(record.frame, decoderState);
      continue;
    }
    if (!found) {
      if (record.offset !== source.rawByteOffset) return undefined;
      found = true;
    }
    if (replayFrames >= frameLimit) break;
    const decoded = decodeIRacingSourceFrame(record.frame, decoderState);
    replayFrames++;
    if (!decoded) { decoderState = createIRacingSourceDecoderState(); continue; }
    if ("sessionInfo" in decoded && (decoded.sessionInfo !== sessionInfo || decoded.sessionInfoUpdate !== sessionInfoUpdate)) {
      for (const sourcePath of Object.keys(trackGeography)) delete decoded.values[sourcePath];
      sessionInfo = decoded.sessionInfo;
      sessionInfoUpdate = decoded.sessionInfoUpdate;
      trackGeography = parseIRacingTrackGeography(sessionInfo);
    }
    for (const [sourcePath, value] of Object.entries(trackGeography)) decoded.values[sourcePath] = value;
    if (inContext) continue;
    const { session, values } = decoded;
    const tick = values.SessionTick, time = values.SessionTime;
    yield {
      sessionUID: `${session.subSessionId}:${session.sessionId}:${session.sessionNum}`,
      sessionTick: typeof tick === "number" && Number.isInteger(tick) && tick >= 0 ? tick : null,
      sessionTimeMs: typeof time === "number" && Number.isFinite(time) && time >= 0 ? Math.round(time * 1000) : null,
      values,
    };
  }
  return undefined;
}


/** Test-only export for exact iRacing replay frame-window assertions. */
export const iterateIRacingNativeFramesForTest = iterateIRacingNativeFrames;

function resolveRawReference(source: LapReplaySource, capture: RawCaptureIdentity | undefined): TelemetryRawReference | undefined {
  if (capture && source.rawByteOffset != null && source.rawFrameCount != null) {
    return {
      objectId: rawCaptureObjectId(source.sessionId),
      contentHash: capture.contentHash,
      contentEncoding: "identity",
      storageEncoding: capture.storageEncoding,
      byteOffset: source.rawByteOffset,
      frameCount: source.rawFrameCount,
    };
  }
  return undefined;
}

function receivedTimestamp(createdAt: string): TelemetryTimestamp {
  const iso = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Lap has invalid persistence timestamp: ${createdAt}`);
  }
  return { domain: "wall-clock", milliseconds };
}

function replayTimestamp(packet: TelemetryPacket, fallback: TelemetryTimestamp): TelemetryTimestamp {
  if (packet.extendedRaceIQ?.frameTimeMs !== undefined) return { domain: "wall-clock", milliseconds: packet.extendedRaceIQ.frameTimeMs };
  if (packet.gameId === "acc" || packet.gameId === "ac-evo" || !Number.isFinite(packet.TimestampMS)) return fallback;
  return { domain: "session", milliseconds: packet.TimestampMS };
}

/**
 * Resolve preloaded native packets into canonical semantic envelopes.
 * Persistence and raw-capture I/O belong to callers.
 */
export function resolveTelemetryReplay(
  lapId: number,
  source: LapReplaySource,
  packets: readonly TelemetryPacket[],
  requestedSemanticIds: readonly string[],
  rawCapture?: RawCaptureIdentity,
): SemanticTelemetryReplay {
  if (requestedSemanticIds.length === 0) {
    throw new Error("At least one semantic ID is required for telemetry replay");
  }
  if (packets.length === 0) {
    throw new Error(`Lap ${lapId} has no replayable telemetry`);
  }

  const semanticIds = [...new Set(requestedSemanticIds)];
  const resolver = compileTelemetryResolver<ReplayNativeFrame>(TELEMETRY_CATALOG, {
    simulator: source.gameId,
    requested: semanticIds.map((semanticId) => ({ semanticId })),
  });
  const slots = semanticIds.map((semanticId) => resolver.slot(semanticId));
  const receivedAt = receivedTimestamp(source.createdAt);
  const rawReference = resolveRawReference(source, rawCapture);
  const packetIndices = new Map<string, number | null>();
  for (let sequence = 0; sequence < packets.length; sequence++) {
    const packet = packets[sequence];
    if (packet.gameId !== "iracing" || !packet.sessionUID || !packet.iracing || !Number.isFinite(packet.iracing.sessionTick) || !Number.isFinite(packet.CurrentRaceTime)) continue;
    const key = `${packet.sessionUID}\u0000${packet.iracing.sessionTick}\u0000${Math.round(packet.CurrentRaceTime * 1000)}`;
    packetIndices.set(key, packetIndices.has(key) ? null : sequence);
  }
  const envelopes: CanonicalTelemetryEnvelope[] = new Array(packets.length);
  const ambiguous = new Uint8Array(packets.length);
  let view: TelemetryFrameView<ReplayNativeFrame> | undefined;
  const nativeFrame: ReplayNativeFrame = { packet: packets[0] };
  const target: ResolvedValue<unknown>[] = [];
  const resolvePacket = (sequence: number, nativeValues?: Readonly<Record<string, IRacingValue>>) => {
    const packet = packets[sequence];
    const observedAt = replayTimestamp(packet, receivedAt);
    nativeFrame.packet = packet;
    nativeFrame.nativeValues = nativeValues;
    const observation: SourceObservation = { timestamp: observedAt, updateSequence: BigInt(sequence) };
    const packetView = resolver.createFrameView(nativeFrame, observation, source.gameId === "iracing" ? undefined : view);
    if (source.gameId !== "iracing") view = packetView;
    const resolved = packetView.resolveMany(slots, target);
    const values: CanonicalTelemetryValue[] = new Array(resolved.length);
    for (let index = 0; index < resolved.length; index++) values[index] = canonicalTelemetryValue(slots[index], resolved[index]);
    envelopes[sequence] = {
      sessionId: String(source.sessionId),
      sequence: BigInt(sequence),
      observedAt,
      receivedAt,
      simulator: source.gameId,
      catalogVersion: resolver.catalogVersion,
      catalogHash: resolver.catalogHash,
      catalogSchemaVersion: resolver.schemaVersion,
      parserVersion: resolver.parserVersion,
      resolverVersion: resolver.resolverVersion,
      derivationVersion: resolver.derivationVersion,
      recordedWith: source.versionIdentity,
      values,
      rawReference,
    };
  };
  for (const native of iterateIRacingNativeIdentities(source, rawCapture?.bytes)) {
    if (native.sessionTick === null || native.sessionTimeMs === null) continue;
    const key = `${native.sessionUID}\u0000${native.sessionTick}\u0000${native.sessionTimeMs}`;
    const sequence = packetIndices.get(key);
    if (sequence === null || sequence === undefined) continue;
    if (envelopes[sequence] || ambiguous[sequence]) {
      ambiguous[sequence] = 1;
      continue;
    }
    resolvePacket(sequence, native.values);
  }
  for (let sequence = 0; sequence < packets.length; sequence++) {
    if (ambiguous[sequence] || !envelopes[sequence]) resolvePacket(sequence);
  }
  return {
    lapId,
    requestedSemanticIds: semanticIds,
    envelopes,
  };
}

/**
 * Replay one persisted lap through the current compiled semantic resolver.
 * Returned diagnostics expose mapping state, freshness, limitations, and source
 * provenance; callers never need to inspect simulator-specific packet fields.
 */
export async function queryLapTelemetryBySemanticId(
  lapId: number,
  requestedSemanticIds: readonly string[],
  options: QueryLapTelemetryOptions = {},
): Promise<SemanticTelemetryReplay | null> {
  if (requestedSemanticIds.length === 0) {
    throw new Error("At least one semantic ID is required for telemetry replay");
  }
  const [lap, source] = await Promise.all([getLapById(lapId), getLapReplaySource(lapId)]);
  if (!lap || !source) return null;
  if (lap.parseError) throw new Error(lap.parseError);
  if (lap.telemetry.length === 0) {
    throw new Error(`Lap ${lapId} has no replayable telemetry`);
  }

  const { rawCaptureRequirement } = { ...defaultQueryLapTelemetryOptions, ...options };
  const needsRawCapture =
    source.rawFile != null &&
    (rawCaptureRequirement === "provenance" || source.gameId === "iracing");
  const rawCapture = needsRawCapture ? await loadRawCaptureIdentity(source.rawFile as string) : undefined;
  return resolveTelemetryReplay(lapId, source, lap.telemetry, requestedSemanticIds, rawCapture);
}

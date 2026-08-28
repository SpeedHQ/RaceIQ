import { TELEMETRY_CATALOG } from "../../shared/telemetry/catalog/data";
import { canonicalTelemetryValue } from "../../shared/telemetry/replay/canonicalize";
import type { CanonicalTelemetryEnvelope, CanonicalTelemetryValue, SemanticTelemetryReplay, TelemetryRawReference } from "../../shared/telemetry/replay/contracts";
import { compileTelemetryResolver } from "../../shared/telemetry/resolver/compile";
import type { ResolvedValue, SourceObservation, TelemetryFrameView, TelemetryTimestamp } from "../../shared/telemetry/resolver/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getLapById } from "../db/lap-read-queries";
import { getLapReplaySource, type LapReplaySource } from "../db/telemetry-replay-storage";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame, type IRacingValue } from "../games/iracing/source-frame";
import { iterateSessionCaptureRecords } from "../session-capture/framing";
import { loadRawCaptureIdentity, type RawCaptureIdentity, rawCaptureObjectId } from "../session-capture/identity";

interface ReplayNativeFrame {
  packet: TelemetryPacket;
  nativeValues?: Readonly<Record<string, IRacingValue>>;
}

function* iterateIRacingNativeFrames(source: LapReplaySource, capture: Buffer | undefined): Generator<Readonly<Record<string, IRacingValue>>, undefined, void> {
  if (source.gameId !== "iracing" || !capture || source.rawByteOffset == null || source.rawFrameCount == null) return undefined;
  let decoderState = createIRacingSourceDecoderState();
  let replayFrames = 0;
  for (const record of iterateSessionCaptureRecords(capture)) {
    if (record.kind === "segment-boundary") {
      decoderState = createIRacingSourceDecoderState();
      replayFrames = 0;
      continue;
    }
    if (record.kind !== "frame") continue;
    if (record.offset < source.rawByteOffset) {
      decodeIRacingSourceFrame(record.frame, decoderState);
      continue;
    }
    if (replayFrames >= source.rawFrameCount) break;
    const decoded = decodeIRacingSourceFrame(record.frame, decoderState);
    replayFrames += 1;
    if (decoded) yield decoded.values;
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
  if (!Number.isFinite(packet.TimestampMS)) return fallback;
  return packet.gameId === "acc" || packet.gameId === "ac-evo" ? { domain: "wall-clock", milliseconds: packet.TimestampMS } : { domain: "session", milliseconds: packet.TimestampMS };
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
  const nativeFrames = iterateIRacingNativeFrames(source, rawCapture?.bytes);
  const envelopes: CanonicalTelemetryEnvelope[] = new Array(packets.length);
  const target: ResolvedValue<unknown>[] = [];
  const nativeFrame: ReplayNativeFrame = { packet: packets[0] };
  let view: TelemetryFrameView<ReplayNativeFrame> | undefined;

  for (let sequence = 0; sequence < packets.length; sequence++) {
    const packet = packets[sequence];
    const observedAt = replayTimestamp(packet, receivedAt);
    const observation: SourceObservation = {
      timestamp: observedAt,
      updateSequence: BigInt(sequence),
    };
    nativeFrame.packet = packet;
    nativeFrame.nativeValues = nativeFrames.next().value;
    view = resolver.createFrameView(nativeFrame, observation, view);
    const resolved = view.resolveMany(slots, target);
    const values: CanonicalTelemetryValue[] = new Array(resolved.length);
    for (let index = 0; index < resolved.length; index++) {
      values[index] = canonicalTelemetryValue(slots[index], resolved[index]);
    }
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
export async function queryLapTelemetryBySemanticId(lapId: number, requestedSemanticIds: readonly string[]): Promise<SemanticTelemetryReplay | null> {
  if (requestedSemanticIds.length === 0) {
    throw new Error("At least one semantic ID is required for telemetry replay");
  }
  const [lap, source] = await Promise.all([getLapById(lapId), getLapReplaySource(lapId)]);
  if (!lap || !source) return null;
  if (lap.parseError) throw new Error(lap.parseError);
  if (lap.telemetry.length === 0) {
    throw new Error(`Lap ${lapId} has no replayable telemetry`);
  }

  const rawCapture = source.rawFile ? await loadRawCaptureIdentity(source.rawFile) : undefined;
  return resolveTelemetryReplay(lapId, source, lap.telemetry, requestedSemanticIds, rawCapture);
}

import { TELEMETRY_CATALOG } from "../../shared/telemetry-catalog";
import {
  compileTelemetryResolver,
  type ResolvedValue,
  type SemanticSlot,
  type TelemetryFrameView,
} from "../../shared/telemetry-resolver";
import {
  canonicalizeTelemetryScalar,
  type CanonicalTelemetryEnvelope,
  type CanonicalTelemetryValue,
  type SemanticTelemetryReplay,
  type TelemetryRawReference,
} from "../../shared/telemetry-replay";
import type { TelemetryPacket } from "../../shared/types";
import { getLapById } from "../db/lap-read-queries";
import { getLapReplaySource, type LapReplaySource } from "../db/telemetry-replay-storage";
import {
  createIRacingSourceDecoderState,
  decodeIRacingSourceFrame,
  type IRacingValue,
} from "../games/iracing/source-frame";
import { readFrameStreamStart } from "../session-capture/framing";
import {
  loadRawCaptureIdentity,
  rawCaptureObjectId,
  sha256ContentHash,
  type RawCaptureIdentity,
} from "../session-capture/identity";

interface ReplayNativeFrame {
  packet: TelemetryPacket;
  nativeValues?: Readonly<Record<string, IRacingValue>>;
}


function loadIRacingNativeFrames(
  source: LapReplaySource,
  capture: Buffer | undefined,
): Readonly<Record<string, IRacingValue>>[] {
  if (
    source.gameId !== "iracing" ||
    !capture ||
    source.rawByteOffset == null ||
    source.rawFrameCount == null
  ) {
    return [];
  }
  const decoderState = createIRacingSourceDecoderState();
  const nativeFrames: Readonly<Record<string, IRacingValue>>[] = [];
  let offset = readFrameStreamStart(capture);
  let replayFrames = 0;
  while (offset + 4 <= capture.length) {
    const frameOffset = offset;
    const frameLength = capture.readUInt32LE(offset);
    offset += 4;
    if (frameLength <= 0 || offset + frameLength > capture.length) break;
    const frame = capture.subarray(offset, offset + frameLength);
    offset += frameLength;
    const decoded = decodeIRacingSourceFrame(frame, decoderState);
    if (frameOffset < source.rawByteOffset) continue;
    if (replayFrames > source.rawFrameCount) break;
    replayFrames += 1;
    if (decoded) nativeFrames.push({ ...decoded.values });
  }
  return nativeFrames;
}

function resolveRawReference(
  source: LapReplaySource,
  capture: RawCaptureIdentity | undefined,
): TelemetryRawReference | undefined {
  if (
    capture &&
    source.rawByteOffset != null &&
    source.rawFrameCount != null
  ) {
    return {
      objectId: rawCaptureObjectId(source.sessionId),
      contentHash: capture.contentHash,
      contentEncoding: "identity",
      storageEncoding: capture.storageEncoding,
      byteOffset: source.rawByteOffset,
      frameCount: source.rawFrameCount,
    };
  }
  if (source.legacyTelemetry) {
    return {
      objectId: `lap:${source.id}:legacy-telemetry`,
      contentHash: sha256ContentHash(source.legacyTelemetry),
      contentEncoding: "gzip",
      storageEncoding: "gzip",
    };
  }
  return undefined;
}

function receivedTimestamp(createdAt: string): number {
  const iso = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Lap has invalid persistence timestamp: ${createdAt}`);
  }
  return timestamp;
}

function canonicalValue(
  slot: SemanticSlot,
  resolved: ResolvedValue<unknown>,
): CanonicalTelemetryValue {
  return {
    semanticId: resolved.semanticId,
    slot,
    value: canonicalizeTelemetryScalar(resolved.value, resolved.semanticId),
    unit: resolved.unit,
    mappingStatus: resolved.mappingStatus,
    state: resolved.state,
    confidence: resolved.confidence,
    confidenceComponents: resolved.confidenceComponents,
    provenance: resolved.provenance,
    schemaVersion: resolved.schemaVersion,
    limitations: resolved.limitations,
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
): Promise<SemanticTelemetryReplay | null> {
  if (requestedSemanticIds.length === 0) {
    throw new Error("At least one semantic ID is required for telemetry replay");
  }
  const semanticIds = [...new Set(requestedSemanticIds)];
  const [lap, source] = await Promise.all([
    getLapById(lapId),
    getLapReplaySource(lapId),
  ]);
  if (!lap || !source) return null;
  if (lap.parseError) throw new Error(lap.parseError);
  if (lap.telemetry.length === 0) {
    throw new Error(`Lap ${lapId} has no replayable telemetry`);
  }

  const resolver = compileTelemetryResolver<ReplayNativeFrame>(TELEMETRY_CATALOG, {
    simulator: source.gameId,
    requested: semanticIds.map((semanticId) => ({ semanticId })),
  });
  const slots = semanticIds.map((semanticId) => resolver.slot(semanticId));
  const receivedAt = receivedTimestamp(source.createdAt);
  const rawCapture = source.rawFile ? await loadRawCaptureIdentity(source.rawFile) : undefined;
  const rawReference = resolveRawReference(source, rawCapture);
  const nativeFrames = loadIRacingNativeFrames(source, rawCapture?.bytes);
  const envelopes: CanonicalTelemetryEnvelope[] = new Array(lap.telemetry.length);
  const target: ResolvedValue<unknown>[] = [];
  const nativeFrame: ReplayNativeFrame = { packet: lap.telemetry[0] };
  let view: TelemetryFrameView<ReplayNativeFrame> | undefined;

  for (let sequence = 0; sequence < lap.telemetry.length; sequence++) {
    const packet = lap.telemetry[sequence];
    const observedAt = packet.TimestampMS ?? receivedAt;
    nativeFrame.packet = packet;
    nativeFrame.nativeValues = nativeFrames[sequence];
    view = resolver.createFrameView(nativeFrame, observedAt, view);
    const resolved = view.resolveMany(slots, target);
    const values: CanonicalTelemetryValue[] = new Array(resolved.length);
    for (let index = 0; index < resolved.length; index++) {
      values[index] = canonicalValue(slots[index], resolved[index]);
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

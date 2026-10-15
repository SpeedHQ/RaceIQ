import { TELEMETRY_CATALOG } from "@raceiq/shared/telemetry/catalog/data";
import { canonicalTelemetryValue } from "@raceiq/telemetry-core/telemetry/replay/canonicalize";
import type { CanonicalTelemetryEnvelope, CanonicalTelemetryValue, SemanticTelemetryReplay, TelemetryRawReference } from "@raceiq/shared/telemetry/replay/contracts";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";
import type { ResolvedValue, SourceObservation, TelemetryFrameView, TelemetryTimestamp } from "@raceiq/shared/telemetry/resolver/contracts";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getLapById } from "../db/lap-read-queries";
import { getLapReplaySource, type LapReplaySource } from "../db/telemetry-replay-storage";
import { getServerGame } from "../games/registry";
import { createIRacingSourceDecoderState, decodeIRacingSourceFrame, type IRacingSourceDecoderState, type IRacingValue } from "@raceiq/capture-formats/iracing/source-frame";
import { PARSER_BOOTSTRAP_VERSION, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { loadRawCaptureIdentity, type RawCaptureIdentity, rawCaptureObjectId } from "../session-capture/identity";
import { resolveLapCaptureArtifact } from "../session-capture/source-loader";
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

type IRacingParserStateWithSource = { source: IRacingSourceDecoderState };

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
    if (record.kind === "parser-bootstrap") {
      if (record.gameId !== "iracing" || record.formatVersion !== PARSER_BOOTSTRAP_VERSION) {
        throw new Error("iRacing native replay received an incompatible parser bootstrap");
      }
      const game = getServerGame("iracing");
      if (!game.restoreParserCheckpoint) throw new Error("iRacing parser checkpoint restore unavailable");
      const state = game.createParserState();
      if (state == null) throw new Error("iRacing parser state unavailable");
      const restored = game.restoreParserCheckpoint(state, record.payload);
      if (typeof restored !== "object" || restored === null || !("source" in restored)) {
        throw new Error("iRacing parser checkpoint did not restore source decoder state");
      }
      decoderState = (restored as IRacingParserStateWithSource).source;
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
      objectId: source.captureChunkId ? `session:${source.sessionId}:lap-capture:${source.captureChunkId}` : rawCaptureObjectId(source.sessionId),
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

  const { rawCaptureRequirement } = { ...defaultQueryLapTelemetryOptions, ...options };
  const artifact = source.captureLayoutVersion === 1
    ? await (() => {
      if (!source.captureManifestFile || !source.captureChunkId) {
        throw new Error(`Published capture layout for lap ${lapId} has incomplete capture references`);
      }
      return resolveLapCaptureArtifact(source.captureManifestFile, source.captureChunkId, lapId);
    })()
    : undefined;
  if (source.captureLayoutVersion != null && source.captureLayoutVersion !== 1) {
    throw new Error(`Unsupported capture layout version ${source.captureLayoutVersion} for lap ${lapId}`);
  }
  if (source.captureLayoutVersion === 1 && !artifact) {
    throw new Error(`Published capture layout for lap ${lapId} has incomplete capture references`);
  }
  if (lap.telemetry.length === 0) {
    throw new Error(`Lap ${lapId} has no replayable telemetry`);
  }
  const capturePath = artifact?.path ?? (source.captureLayoutVersion == null ? source.rawFile : undefined);
  const needsRawCapture =
    capturePath != null &&
    (rawCaptureRequirement === "provenance" || source.gameId === "iracing");
  const rawCapture = needsRawCapture ? await loadRawCaptureIdentity(capturePath as string) : undefined;
  const replaySource = artifact
    ? { ...source, rawByteOffset: artifact.chunk.ownedFrameByteOffset!, rawFrameCount: artifact.chunk.ownedFrameCount! }
    : source;
  return resolveTelemetryReplay(lapId, replaySource, lap.telemetry, requestedSemanticIds, rawCapture);
}

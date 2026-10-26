import { setImmediate as yieldToWorker } from "node:timers/promises";
import {
  UPLOAD_GAME_IDS, uploadPayloadFingerprint,
  type OnlineRecordingProducerOptions, type PreparedOnlineLapUpload,
  type UploadGame,
} from "@raceiq/online/server/payload";
import { isWholeLapSelf, type GameIdentityBinding } from "@raceiq/shared/driver-attribution";
import { OnlineAdapterError } from "@raceiq/online/server/adapter";
import {
  iterateSessionCaptureRecords, type SessionCaptureRecord,
} from "@raceiq/capture-formats/session/framing";
import {
  createIRacingSourceDecoderState, decodeIRacingSourceFrame, IRacingSourceFrameEncoder,
  type IRacingSourceFrame,
} from "@raceiq/capture-formats/iracing/source-frame";
import { processTelemetryBatch, type TelemetryBatchInput } from "@raceiq/telemetry-core/processor/batch";
import { getServerGame } from "../games/registry";
import {
  readOnlineLapSource, iterateOnlineLapSourceRecords, OnlineLapSourceError,
  type OnlineLapSource, type OnlineLapSourceHoldReason, type OnlineLapSourceRecord,
} from "./online-source";
import {
  OnlineRecordingError, assertNativeOnlineDriver, compressNativeOnlineRecording,
  createNativeOnlineRecordingCodec, encodeNativeOnlineRecording, type OnlineRecordingErrorCode,
} from "./online-recording-codec";

import { traceOnlineWorkerTestEvent, waitOnlineWorkerTestBarrier } from "../runtime/online-worker-test-hooks";
const SOURCE_HOLD_CODES: Record<OnlineLapSourceHoldReason, OnlineRecordingErrorCode> = {
  source_unavailable: "recording_not_ready",
  source_context_unavailable: "driver_identity_required",
  source_identity_unavailable: "activity_identity_ambiguous",
  driver_identity_required: "driver_identity_required",
  lap_identity_conflict: "lap_identity_conflict",
  lap_owner_conflict: "activity_owner_conflict",
  unsupported_game: "unsupported_recording_format",
  invalid_lap: "ineligible_lap",
};

class OnlineLapSourceHeldError extends OnlineRecordingError {
  constructor(readonly sourceReason: OnlineLapSourceHoldReason) {
    super(SOURCE_HOLD_CODES[sourceReason]);
    this.name = "OnlineLapSourceHeldError";
  }
}

/** Losslessly rehydrate the native SDK dictionary; never publish predecessor lap history. */
async function* hydratedLapSourceRecords(source: OnlineLapSource): AsyncGenerator<OnlineLapSourceRecord> {
  if (source.gameId !== "iracing") {
    yield* iterateOnlineLapSourceRecords(source);
    return;
  }
  const decoder = createIRacingSourceDecoderState();
  const encoder = new IRacingSourceFrameEncoder();
  let lastContext: Extract<SessionCaptureRecord, { kind: "frame" }> | undefined;
  let lastHydrated: IRacingSourceFrame | null = null;
  let published = false, contextRecords = 0, contextBytes = 0;
  for await (const { record, scope } of iterateOnlineLapSourceRecords(source)) {
    if (record.kind === "clock-anchor") {
      yield { record, scope };
      continue;
    }
    if (record.kind !== "frame") throw new OnlineRecordingError("unsupported_recording_format");
    if (scope === "context") {
      if (published) throw new OnlineRecordingError("unsupported_recording_format");
      lastHydrated = decodeIRacingSourceFrame(record.frame, decoder);
      if (!lastHydrated) throw new OnlineRecordingError("driver_identity_required");
      lastContext = record;
      contextBytes += record.frame.length;
      if (++contextRecords % 256 === 0 || contextBytes >= 1024 * 1024) {
        contextBytes = 0;
        await yieldToWorker();
      }
      continue;
    }
    if (!published) {
      // Encode before decoding the next delta, which mutates the decoder values.
      if (lastContext && lastHydrated) {
        yield { record: { ...lastContext, frame: encoder.encode(lastHydrated) }, scope: "context" };
      }
      published = true;
    }
    const frame = decodeIRacingSourceFrame(record.frame, decoder);
    if (!frame) throw new OnlineRecordingError("driver_identity_required");
    yield { record: { ...record, frame: encoder.encode(frame) }, scope };
  }
}

/** Rewrap authoritative native context; no session scanning or lap slicing happens here. */
async function* onlineLapRecords(source: OnlineLapSource): AsyncGenerator<SessionCaptureRecord> {
  let contextOpen = false, sawLap = false, sawTrailing = false;
  let ownedFrames = 0, trailingFrames = 0;
  let clockAnchor = source.clockAnchor;
  let anchored = false, sawNativeFrame = false;
  if (clockAnchor) {
    yield { kind: "clock-anchor", offset: 0, endOffset: 0, ...clockAnchor };
    anchored = true;
  }
  for await (const { record, scope } of hydratedLapSourceRecords(source)) {
    // The authoritative source iterator supplies only genuine native records.
    // Opaque local checkpoints and private metadata never enter a public lap.
    if (record.kind === "clock-anchor") {
      if (sawNativeFrame || (clockAnchor &&
          record.utcTimeMs - record.frameTimeMs !== clockAnchor.utcTimeMs - clockAnchor.frameTimeMs)) {
        throw new OnlineRecordingError("unsupported_recording_format");
      }
      if (!anchored) {
        clockAnchor = record;
        anchored = true;
        yield record;
      }
      continue;
    }
    if (record.kind !== "frame") throw new OnlineRecordingError("unsupported_recording_format");
    if (!anchored && source.frameClock === "capture_utc") {
      if (record.frameTimeMs === undefined) throw new OnlineRecordingError("recording_not_ready");
      clockAnchor = { frameTimeMs: record.frameTimeMs, utcTimeMs: record.frameTimeMs };
      yield { kind: "clock-anchor", offset: 0, endOffset: 0, ...clockAnchor };
      anchored = true;
    }
    sawNativeFrame = true;
    if (scope === "context") {
      if (sawLap) throw new OnlineRecordingError("unsupported_recording_format");
      if (!contextOpen) {
        contextOpen = true;
        yield { kind: "segment-context", offset: record.offset, endOffset: record.offset };
      }
    } else {
      if (scope !== "lap" && scope !== "trailing_context") throw new OnlineRecordingError("unsupported_recording_format");
      if (!sawLap) {
        // Even a frame-local source needs explicit complete-lap-start framing.
        if (!contextOpen) yield { kind: "segment-context", offset: record.offset, endOffset: record.offset };
        yield { kind: "segment-context-end", offset: record.offset, endOffset: record.offset };
        contextOpen = false;
      }
      if (scope === "lap") {
        if (sawTrailing) throw new OnlineRecordingError("unsupported_recording_format");
        sawLap = true;
        ownedFrames++;
      } else {
        if (!sawLap) throw new OnlineRecordingError("unsupported_recording_format");
        sawTrailing = true;
        trailingFrames++;
      }
    }
    // A genuine next-boundary frame closes the intended lap. It is not skipped
    // as decoder-only context and never changes its native time or participant.
    yield record;
  }
  if (!sawLap || contextOpen || ownedFrames !== source.window.frameCount ||
      trailingFrames !== source.window.trailingContextFrameCount) {
    throw new OnlineRecordingError("unsupported_recording_format");
  }
}

/** Uses the same native detector integration as service processing, not packet-count guesses. */
async function assertIntendedLap(bytes: Buffer, source: OnlineLapSource, gameId: UploadGame, lapTimeMs: number) {
  const inputs: TelemetryBatchInput[] = [];
  let count = 0;
  for (const record of iterateSessionCaptureRecords(bytes, 12, { strict: true })) {
    if (record.kind === "frame") {
      inputs.push({ data: record.frame, rawByteOffset: record.offset, frameTimeMs: record.frameTimeMs,
        timestampMs: record.frameTimeMs });
    } else if (record.kind === "parser-bootstrap") {
      throw new OnlineRecordingError("unsupported_recording_format");
    } else if (record.kind === "segment-context") inputs.push({ type: "segment-context", completeLapStart: true });
    else if (record.kind === "segment-context-end") inputs.push({ type: "segment-context-end" });
    else if (record.kind === "segment-boundary") inputs.push({ type: "segment-boundary" });
    else if (record.kind === "clock-anchor") continue;
    else throw new OnlineRecordingError("unsupported_recording_format");
    if (++count % 256 === 0) await yieldToWorker();
  }
  const result = await processTelemetryBatch(gameId, inputs, { parser: getServerGame(gameId) });
  if (result.logicalLapCount !== 1) throw new OnlineRecordingError("unsupported_recording_format");
  const complete = result.laps.filter(lap => lap.complete && lap.valid);
  if (complete.length !== 1) throw new OnlineRecordingError("unsupported_recording_format");
  const lap = complete[0];
  const session = result.sessions.find(candidate => candidate.sessionKey === lap.sessionKey);
  if (!session || session.gameId !== gameId || session.carId !== source.carId || session.trackId !== source.trackId ||
      lap.lapNumber !== source.lapNumber || Math.round(lap.lapTime * 1000) !== lapTimeMs ||
      !lap.sectors?.length || lap.sectors.length > 64 ||
      lap.sectors.some(sector => !Number.isFinite(sector) || !Number.isSafeInteger(Math.round(sector * 1000)) ||
        Math.round(sector * 1000) <= 0 || Math.round(sector * 1000) > lapTimeMs)) {
    throw new OnlineRecordingError("lap_identity_conflict");
  }
}

function sameSource(left: OnlineLapSource, right: OnlineLapSource) {
  const a = left.capturedBinding, b = right.capturedBinding;
  return left.lapId === right.lapId && left.lapGuid === right.lapGuid &&
    left.sessionId === right.sessionId &&
    left.gameId === right.gameId && left.carId === right.carId && left.trackId === right.trackId &&
    left.sourceKind === right.sourceKind && left.ownerUserId === right.ownerUserId &&
    left.publicationIdentity === right.publicationIdentity && left.lapNumber === right.lapNumber &&
    left.lapTime === right.lapTime && left.totalTimeMs === right.totalTimeMs &&
    left.recordedAt === right.recordedAt && left.createdAt === right.createdAt &&
    left.frameClock === right.frameClock &&
    left.clockAnchor?.frameTimeMs === right.clockAnchor?.frameTimeMs &&
    left.clockAnchor?.utcTimeMs === right.clockAnchor?.utcTimeMs &&
    left.window.startByteOffset === right.window.startByteOffset &&
    left.window.frameCount === right.window.frameCount &&
    left.window.trailingContextFrameCount === right.window.trailingContextFrameCount &&
    left.sourceClock.domain === right.sourceClock.domain && left.sourceClock.startMs === right.sourceClock.startMs &&
    left.sourceClock.endMs === right.sourceClock.endMs &&
    a.id === b.id && a.gameId === b.gameId && a.sourceKind === b.sourceKind &&
    a.nativeIdentity === b.nativeIdentity && a.confirmation === b.confirmation && a.revision === b.revision;
}

/** Constructed in the dedicated worker only; historical binding registration is REQUIRED. */
export function createOnlineRecordingProducer(options: OnlineRecordingProducerOptions):
  (lapId: number, setupUploads: boolean) => Promise<PreparedOnlineLapUpload> {
  if (!options || typeof options.resolveDriverBinding !== "function") {
    throw new OnlineRecordingError("driver_identity_required");
  }
  const resolveDriverBinding = options.resolveDriverBinding;
  return async (lapId, setupUploads) => {
    try {
      const loaded = await readOnlineLapSource(lapId);
      if (loaded.kind === "held") throw new OnlineLapSourceHeldError(loaded.reason);
      const source = Object.freeze({ ...loaded.source,
        sourceClock: Object.freeze({ ...loaded.source.sourceClock }),
        capturedBinding: Object.freeze({ ...loaded.source.capturedBinding }),
        window: Object.freeze({ ...loaded.source.window }),
        capture: Object.freeze({ ...loaded.source.capture }),
      });
      const gameId = UPLOAD_GAME_IDS.find(game => game === source.gameId);
      if (!gameId) throw new OnlineRecordingError("unsupported_recording_format");
      // Recording eligibility remains F1 World only; local analysis and aggregate stats are independent.
      if (gameId === "f1-2025" && source.carId !== "41") throw new OnlineRecordingError("ineligible_lap");
      if (source.lapId !== lapId || !source.lapGuid || !source.originalActivityId || !source.sourceRevision ||
          (source.sourceKind !== "native_capture" && source.sourceKind !== "verified_portable")) {
        throw new OnlineRecordingError("activity_identity_ambiguous");
      }
      if (!source.ownerUserId) throw new OnlineRecordingError("activity_owner_conflict");
      if (!isWholeLapSelf(source.driverAttributionStints, source.sourceClock.startMs, source.sourceClock.endMs, source.sourceClock.domain)) {
        throw new OnlineRecordingError("mixed_driver_lap");
      }
      const capturedBinding: GameIdentityBinding = source.capturedBinding;
      if (capturedBinding.gameId !== gameId) throw new OnlineRecordingError("driver_identity_required");
      const lapTimeMs = source.totalTimeMs !== null && source.totalTimeMs > 0
        ? source.totalTimeMs : Math.round(source.lapTime * 1000);
      if (!Number.isSafeInteger(lapTimeMs) || lapTimeMs <= 0) throw new OnlineRecordingError("lap_identity_conflict");
      const native = await encodeNativeOnlineRecording(onlineLapRecords(source), gameId);
      await assertNativeOnlineDriver(native, {
        gameId, carId: source.carId, trackId: source.trackId, capturedBinding,
        sourceClockDomain: source.sourceClock.domain, sourceLapStartMs: source.sourceClock.startMs,
        sourceLapEndMs: source.sourceClock.endMs,
      });
      await assertIntendedLap(native, source, gameId, lapTimeMs);
      const codec = createNativeOnlineRecordingCodec(gameId);
      // carSetup/tuneId are cached UI snapshots, never genuine service attachments.
      // No verified external attachment format exists in this source contract.
      if (setupUploads && codec.supportsSetupAttachment(gameId)) throw new OnlineRecordingError("unsupported_recording_format");
      const recording = await compressNativeOnlineRecording(native);
      if (!await codec.isServiceCompatible(recording, gameId)) throw new OnlineRecordingError("unsupported_recording_format");
      if (gameId === "f1-2025" && await codec.hasF1SetupTelemetry(recording)) throw new OnlineRecordingError("f1_sanitization_failed");
      const registration = await resolveDriverBinding(capturedBinding).catch((cause: unknown) => {
        if (cause instanceof OnlineAdapterError) throw cause;
        throw new OnlineRecordingError("driver_identity_required");
      });
      const registered = Object.freeze({ id: registration.id, revision: registration.revision });
      if (!registered.id || !Number.isSafeInteger(registered.revision) || registered.revision <= 0) {
        throw new OnlineRecordingError("driver_identity_required");
      }
      const fingerprint = await uploadPayloadFingerprint(recording, null);
      await yieldToWorker();
      const current = await readOnlineLapSource(lapId);
      if (current.kind === "held") throw new OnlineLapSourceHeldError(current.reason);
      if (current.source.ownerUserId !== source.ownerUserId) throw new OnlineRecordingError("activity_owner_conflict");
      if (!sameSource(source, current.source)) throw new OnlineRecordingError("lap_identity_conflict");
      return {
        gameId, trackId: source.trackId, carId: source.carId, lapId, lapTimeMs,
        
        recording, setup: null, filename: `${gameId}.bin.gz`, fingerprint, codec,
        lapGuid: source.lapGuid, originalActivityId: source.originalActivityId,
        sourceRevision: source.sourceRevision, sourceKind: source.sourceKind,
        ownerUserId: source.ownerUserId, driverBindingId: registered.id, driverBindingRevision: registered.revision,
        async isSourceCurrent() {
          await waitOnlineWorkerTestBarrier("before_upload_transport");
          const latest = await readOnlineLapSource(lapId);
          return latest.kind === "ready" && sameSource(source, latest.source);
        },
      };
    } catch (cause) {
      if (cause instanceof OnlineRecordingError || cause instanceof OnlineAdapterError) throw cause;
      if (cause instanceof OnlineLapSourceError) throw new OnlineLapSourceHeldError(cause.code);
      throw new OnlineRecordingError("unsupported_recording_format");
    }
  };
}

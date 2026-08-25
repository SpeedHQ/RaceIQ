import { existsSync, unlinkSync } from "node:fs";
import type { GameId } from "../../shared/games/ids";
import {
  DEFAULT_LAP_CLASSIFICATION,
  type LapClassification,
} from "../../shared/racing/laps/classification";
import type { LapMeta, SessionOwnership } from "../../shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import {
  LOCAL_PLAYER_EVIDENCE,
  type ArchiveVerification,
  type EligibilityDecisionSet,
  type EvidenceSourceKind,
  type LapQualitySummary,
  type ParticipantEvidence,
  type QualityReasonCode,
  type RecordingLifecycleState,
  type RecordingQualitySummary,
  type SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import { deleteSession } from "../db/session-queries";
import type { PersistLapInput } from "../db/lap-mutation-queries";
import { getServerGame } from "../games/registry";
import { LiveTelemetryPipeline } from "../telemetry/live-pipeline";
import {
  NullWsAdapter,
  RealDbAdapter,
  type DbAdapter,
} from "../telemetry/pipeline-ports";
import { reconcileSessionResult } from "../race-results/reconcile";
import {
  activateSessionAnalysisAttempt,
  beginSessionAnalysisAttempt,
} from "../analysis-provenance/session-attempt";
import { enqueueCanonicalArchiveForSession } from "./canonical-archive";
import { finalizeLapQualityGeneration } from "../lap-analysis/quality-generation";
import { DatabaseRaceEventStore } from "../race-events/store";

export class TelemetryImportError extends Error {
  readonly code: string;
  readonly lifecycleState: RecordingLifecycleState;
  readonly reasons: readonly QualityReasonCode[];

  constructor(
    message: string,
    code: string,
    lifecycleState: RecordingLifecycleState,
    reasons: readonly QualityReasonCode[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelemetryImportError";
    this.code = code;
    this.lifecycleState = lifecycleState;
    this.reasons = reasons;
  }
}

export class InvalidImportDataError extends TelemetryImportError {
  constructor(
    message = "Import contains unusable telemetry data",
    options?: ErrorOptions,
  ) {
    super(
      message,
      "INVALID_IMPORT_DATA",
      "corrupt",
      ["recording_corrupt"],
      options,
    );
    this.name = "InvalidImportDataError";
  }
}

export class IncompleteImportError extends TelemetryImportError {
  constructor(message = "No complete, importable laps were found") {
    super(
      message,
      "INCOMPLETE_IMPORT",
      "incomplete",
      ["recording_incomplete"],
    );
    this.name = "IncompleteImportError";
  }
}

export function importErrorPayload(error: unknown): {
  error: string;
  code: string;
  quality: {
    lifecycleState: RecordingLifecycleState;
    reasons: readonly QualityReasonCode[];
  };
} {
  if (error instanceof TelemetryImportError) {
    return {
      error: error.message,
      code: error.code,
      quality: {
        lifecycleState: error.lifecycleState,
        reasons: error.reasons,
      },
    };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    code: "IMPORT_FAILED",
    quality: {
      lifecycleState: "unavailable",
      reasons: ["recording_unavailable"],
    },
  };
}

export interface ImportedLap extends LapClassification {
  lapId: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal: number;
  trackOrdinal: number;
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
}

export interface ImportSessionFramesOptions {
  /** Roll back imported session and capture when no complete lap exists. */
  requireLaps?: boolean;
  /** Verification and identity of original source evidence. */
  sourceArchiveVerification?: ArchiveVerification;
  /** Verification applied while transporting original evidence. */
  sourceTransportVerification?: ArchiveVerification;
  /** Opt out of background profile generation for offline imports. */
  notifyDriverProfile?: boolean;
  /** Original evidence source; direct RaceIQ frame imports default to raw. */
  sourceKind?: EvidenceSourceKind;
  /** Preserve source parser and catalog identity during deterministic replay. */
  versionIdentity?: TelemetryVersionIdentity;
  /** Source-authored fidelity for canonical fields occupied by transcoded data. */
  sourceChannelProfile?: SourceChannelProfile;
  /** Ownership classification applied to every created session. */
  ownership?: SessionOwnership;
  /** Participant identity carried by imported evidence. */
  participant?: ParticipantEvidence;
}

/**
 * Delegates to RealDbAdapter but captures the returned lap IDs + session
 * metadata so an import caller can tell the UI what got inserted and build
 * deep links into the analyse page.
 */
export class ImportCaptureAdapter implements DbAdapter {
  private readonly _inner: DbAdapter;
  readonly laps: ImportedLap[] = [];
  readonly sessionIds = new Set<number>();
  readonly rawFiles = new Set<string>();
  private readonly _pendingLapWrites = new Set<Promise<number>>();
  private _lapWriteFailure: unknown;
  private readonly _lapIdentity = new Map<
    number,
    {
      lapNumber: number;
      rawByteOffset: number | null;
      rawFrameCount: number;
    }
  >();
  private readonly _sessionMeta = new Map<number, { carOrdinal: number; trackOrdinal: number }>();

  constructor({
    notifyDriverProfile,
    ownership,
    db,
  }: {
    notifyDriverProfile?: boolean;
    ownership?: SessionOwnership;
    db?: DbAdapter;
  } = {}) {
    this._inner =
      db ?? new RealDbAdapter({ notifyDriverProfile, ownership });
  }

  async insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string,
    versionIdentity?: TelemetryVersionIdentity,
    sourceKind?: EvidenceSourceKind,
    sourceChannelProfile?: SourceChannelProfile,
    ownership?: SessionOwnership,
  ): Promise<number> {
    const id = await this._inner.insertSession(
      carOrdinal,
      trackOrdinal,
      gameId,
      sessionType,
      versionIdentity,
      sourceKind,
      sourceChannelProfile,
      ownership,
    );
    this.sessionIds.add(id);
    this._sessionMeta.set(id, { carOrdinal, trackOrdinal });
    return id;
  }

  insertLap(input: PersistLapInput): Promise<number> {
    const pending = this._inner.insertLap(input).then((id) => {
      const meta = this._sessionMeta.get(input.sessionId);
      this.laps.push({
        lapId: id,
        sessionId: input.sessionId,
        lapNumber: input.lapNumber,
        lapTime: input.lapTime,
        isValid: input.isValid,
        ...DEFAULT_LAP_CLASSIFICATION,
        ...input.classification,
        quality: input.quality!,
        eligibility: input.eligibility!,
        carOrdinal: meta?.carOrdinal ?? 0,
        trackOrdinal: meta?.trackOrdinal ?? 0,
      });
      this._lapIdentity.set(id, {
        lapNumber: input.lapNumber,
        rawByteOffset: input.rawByteOffset,
        rawFrameCount: input.rawFrameCount,
      });
      return id;
    });
    this._pendingLapWrites.add(pending);
    void pending.then(
      () => this._pendingLapWrites.delete(pending),
      (error) => {
        this._pendingLapWrites.delete(pending);
        this._lapWriteFailure ??= error;
      },
    );
    return pending;
  }
  setSessionAnalysisGeneration(sessionId: number, generationId: string): Promise<void> {
    return this._inner.setSessionAnalysisGeneration?.(sessionId, generationId) ?? Promise.resolve();
  }

  async updateSessionQuality(sessionId: number, quality: RecordingQualitySummary): Promise<RecordingQualitySummary> {
    await this.waitForPendingLapWrites();
    const finalized = await this._inner.updateSessionQuality(sessionId, quality);
    for (const lap of this.laps) {
      if (lap.sessionId !== sessionId) continue;
      const identity = this._lapIdentity.get(lap.lapId);
      if (!identity) continue;
      const generated = finalizeLapQualityGeneration(lap.quality, finalized.provenance.sourceGeneration, identity);
      lap.quality = generated.quality;
      lap.eligibility = generated.eligibility;
    }
    return finalized;
  }
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
    return this._inner.setLapMetrics(lapId, fuelPerLap, tyreWear);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return this._inner.getLaps(gameId, limit);
  }
  getTuneAssignment(gameId: GameId, carOrdinal: number, trackOrdinal: number) {
    return this._inner.getTuneAssignment(gameId, carOrdinal, trackOrdinal);
  }
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void> {
    this.rawFiles.add(rawFile);
    return this._inner.updateSessionRawFile(sessionId, rawFile, lapDetectorVersion);
  }
  updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void> {
    this._sessionMeta.set(sessionId, { carOrdinal, trackOrdinal });
    return this._inner.updateSessionCarTrack(sessionId, carOrdinal, trackOrdinal);
  }
  getLapsForExclusionScope(experimentId: number, tuneId: number) {
    return this._inner.getLapsForExclusionScope(experimentId, tuneId);
  }
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
    return this._inner.setLapAutoExclusion(lapId, excluded);
  }
  getLapExperimentScope(lapId: number) {
    return this._inner.getLapExperimentScope(lapId);
  }

  async waitForPendingLapWrites(): Promise<void> {
    while (this._pendingLapWrites.size > 0) {
      await Promise.allSettled([...this._pendingLapWrites]);
    }
    if (this._lapWriteFailure) throw this._lapWriteFailure;
  }

  /**
   * Best-effort rollback for an isolated file import. The recorder must be
   * stopped before this runs so no process still owns the canonical capture.
   */
  async rollback(): Promise<void> {
    // Let already-issued lap writes settle before deleting their parent session.
    // Otherwise a late write can recreate part of a rejected import after its
    // session graph has been removed.
    await Promise.allSettled([...this._pendingLapWrites]);

    let cleanupFailure: unknown;
    for (const sessionId of this.sessionIds) {
      try {
        await deleteSession(sessionId);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    for (const rawFile of this.rawFiles) {
      try {
        if (existsSync(rawFile)) unlinkSync(rawFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailure ??= error;
      }
    }
    this.laps.length = 0;
    this.sessionIds.clear();
    this.rawFiles.clear();
    this._lapIdentity.clear();
    this._sessionMeta.clear();
    if (cleanupFailure) throw cleanupFailure;
  }
}

async function rollbackImport(capture: ImportCaptureAdapter, error: unknown): Promise<never> {
  await capture.rollback();
  throw error;
}

type SessionFrameSource = Iterable<Buffer> | AsyncIterable<Buffer>;

/**
 * Feed any canonical raw-frame stream through an isolated parser + pipeline.
 * The live telemetry pipeline recorder writes the imported source back out as RaceIQ's
 * standard session `.bin`, so replay/export/reprocessing work identically no
 * matter which source format supplied the frames.
 */
export async function importSessionFrames(
  frames: SessionFrameSource,
  gameId: GameId,
  options: ImportSessionFramesOptions = {},
): Promise<{
  packetCount: number;
  laps: ImportedLap[];
  sessionIds: number[];
}> {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const sourceKind = options.sourceKind ?? "raceiq-raw";
  const db = new ImportCaptureAdapter({
    notifyDriverProfile: options.notifyDriverProfile,
    ownership: options.ownership,
  });
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    raceEventStore: new DatabaseRaceEventStore(),
    bypassPacketRateFilter: true,
    reconcileAfterEachLap: false,
    sourceKind,
    participant: options.participant ?? LOCAL_PLAYER_EVIDENCE,
    versionIdentity: options.versionIdentity,
    sourceChannelProfile: options.sourceChannelProfile,
    sourceArchiveVerification: options.sourceArchiveVerification,
    sourceTransportVerification: options.sourceTransportVerification,
    onSessionAnalysisStarted: (sessionId, sessionGameId) =>
      beginSessionAnalysisAttempt(
        sessionId,
        sessionGameId,
        options.sourceChannelProfile,
      ),
    onSessionFinalized: async (
      sessionId,
      sessionGameId,
      analysisGenerationId,
    ) => {
      await reconcileSessionResult(
        sessionId,
        sessionGameId,
        analysisGenerationId,
      );
    },
    onSessionAnalysisFinalized: async (attempt, sessionGameId) => {
      await activateSessionAnalysisAttempt(attempt, sessionGameId);
    },
    onCanonicalArchiveEnqueued: (
      sessionId,
      sessionGameId,
      sourceContentHash,
    ) =>
      enqueueCanonicalArchiveForSession(
        sessionId,
        sessionGameId,
        sourceContentHash,
      ),
  });

  let packetCount = 0;
  let failure: unknown;
  const asyncIterator = (frames as AsyncIterable<Buffer>)[
    Symbol.asyncIterator
  ];
  const iterator: AsyncIterator<Buffer> | Iterator<Buffer> = asyncIterator
    ? asyncIterator.call(frames)
    : (frames as Iterable<Buffer>)[Symbol.iterator]();
  try {
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = await iterator.next();
      } catch (cause) {
        throw new InvalidImportDataError(
          "Import frame stream is corrupt",
          { cause },
        );
      }
      if (next.done) break;

      let packet: TelemetryPacket | null;
      try {
        packet = serverGame.tryParse(next.value, state);
      } catch (cause) {
        throw new InvalidImportDataError(
          "Import contains an invalid telemetry frame",
          { cause },
        );
      }
      if (!packet) continue;
      await pipeline.processPacket(packet, next.value);
      packetCount++;
    }

    await pipeline.finalizeCurrentSession("stream-ended");
    await db.waitForPendingLapWrites();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await iterator.return?.();
    } catch (cause) {
      failure ??= new InvalidImportDataError(
        "Import frame stream could not be closed",
        { cause },
      );
    }
    if (pipeline.isSessionActive) {
      try {
        await pipeline.flushSessionRecorder();
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure) {
    return rollbackImport(db, failure);
  }
  if (options.requireLaps && !db.laps.some((lap) => lap.quality.complete)) {
    return rollbackImport(db, new IncompleteImportError());
  }

  return {
    packetCount,
    laps: db.laps,
    sessionIds: [...db.sessionIds],
  };
}

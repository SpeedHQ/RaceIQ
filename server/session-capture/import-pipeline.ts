import { existsSync, unlinkSync } from "node:fs";
import type { GameId } from "../../shared/games/ids";
import type { LapClassification } from "../../shared/racing/laps/classification";
import type { LapMeta, SessionOwnership } from "../../shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { EligibilityDecisionSet, EvidenceSourceKind, LapQualitySummary, RecordingQualitySummary, SourceChannelProfile } from "../../shared/racing/quality/contracts";
import type { PersistLapInput } from "../db/lap-mutation-queries";
import { deleteSession } from "../db/session-queries";
import { getServerGame } from "../games/registry";
import { LiveTelemetryPipeline } from "../telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter, type DbAdapter } from "../telemetry/pipeline-ports";
import { reconcileSessionResult } from "../race-results/reconcile";
import { finalizeLapQualityGeneration } from "../lap-analysis/quality-generation";


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

/**
 * metadata so import callers can report inserted rows and build deep links.
 */
export class ImportCaptureAdapter implements DbAdapter {
  private readonly _inner: DbAdapter;
  readonly laps: ImportedLap[] = [];
  readonly sessionIds = new Set<number>();
  readonly rawFiles = new Set<string>();
  private readonly _pendingLapWrites = new Set<Promise<number>>();
  private _lapWriteFailure: unknown;
  private readonly _lapIdentity = new Map<number, { lapNumber: number; rawByteOffset: number | null; rawFrameCount: number }>();
  private readonly _sessionMeta = new Map<number, { carOrdinal: number; trackOrdinal: number }>();

  constructor(options: { notifyDriverProfile?: boolean; ownership?: SessionOwnership } = {}) {
    this._inner = new RealDbAdapter(options);
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
    const id = await this._inner.insertSession(carOrdinal, trackOrdinal, gameId, sessionType, versionIdentity, sourceKind, sourceChannelProfile, ownership);
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
    for (const sessionId of this.sessionIds) {
      await deleteSession(sessionId);
    }
    for (const rawFile of this.rawFiles) {
      if (existsSync(rawFile)) unlinkSync(rawFile);
    }
    this.laps.length = 0;
  }
}

async function rollbackImport(
  capture: ImportCaptureAdapter,
  error: unknown,
): Promise<never> {
  await capture.rollback();
  throw error;
}

type SessionFrameSource = Iterable<Buffer> | AsyncIterable<Buffer>;

interface ImportSessionFramesOptions {
  /** Roll back the imported session and capture when no complete lap exists. */
  requireLaps?: boolean;
  /** Opt out of background profile generation for offline imports such as seeds. */
  notifyDriverProfile?: boolean;
  /** Ownership classification applied to every created session. */
  ownership?: SessionOwnership;
}

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
  const db = new ImportCaptureAdapter({
    notifyDriverProfile: options.notifyDriverProfile,
    ownership: options.ownership,
  });
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    bypassPacketRateFilter: true,
  });

  let packetCount = 0;
  let failure: unknown;
  try {
    for await (const sourceFrame of frames) {
      const packet = serverGame.tryParse(sourceFrame, state);
      if (!packet) continue;
      await pipeline.processPacket(packet, sourceFrame);
      packetCount++;
    }

    await pipeline.flushIncompleteLap();
    await db.waitForPendingLapWrites();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await pipeline.flushSessionRecorder();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure) {
    return rollbackImport(db, failure);
  }
  if (options.requireLaps && db.laps.length === 0) {
    return rollbackImport(
      db,
      new Error("No complete, importable laps were found"),
    );
  }

  try {
    for (const sessionId of db.sessionIds) {
      await reconcileSessionResult(sessionId, gameId);
    }
  } catch (error) {
    return rollbackImport(db, error);
  }

  return {
    packetCount,
    laps: db.laps,
    sessionIds: [...db.sessionIds],
  };
}


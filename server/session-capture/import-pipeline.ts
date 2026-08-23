import { existsSync, unlinkSync } from "node:fs";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta, SessionOwnership } from "../../shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { deleteSession } from "../db/session-queries";
import type { PersistLapInput } from "../db/lap-mutation-queries";
import { getServerGame } from "../games/registry";
import { LiveTelemetryPipeline } from "../telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter, type DbAdapter, type RealDbAdapterOptions } from "../telemetry/pipeline-ports";
import { reconcileSessionResult } from "../race-results/reconcile";

export interface ImportedLap {
  lapId: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal: number;
  trackOrdinal: number;
}
export interface ImportSessionFramesOptions extends RealDbAdapterOptions {
  /** Roll back the imported session and capture when no complete lap exists. */
  requireLaps?: boolean;
}

/**
 * Delegates to RealDbAdapter but captures the returned lap IDs + session
 * metadata so an import caller can tell the UI what got inserted and build
 * deep links into the analyse page.
 */
export class ImportCaptureAdapter implements DbAdapter {
  private readonly _inner: RealDbAdapter;
  readonly laps: ImportedLap[] = [];
  readonly sessionIds = new Set<number>();
  readonly rawFiles = new Set<string>();
  private readonly _pendingLapWrites = new Set<Promise<number>>();
  private _lapWriteFailure: unknown;
  private readonly _sessionMeta = new Map<number, { carOrdinal: number; trackOrdinal: number }>();

  constructor(options: RealDbAdapterOptions = {}) {
    this._inner = new RealDbAdapter(options);
  }

  async insertSession(carOrdinal: number, trackOrdinal: number, gameId: GameId, sessionType?: string, versionIdentity?: TelemetryVersionIdentity, ownership?: SessionOwnership): Promise<number> {
    const id = await this._inner.insertSession(carOrdinal, trackOrdinal, gameId, sessionType, versionIdentity, ownership);
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
        carOrdinal: meta?.carOrdinal ?? 0,
        trackOrdinal: meta?.trackOrdinal ?? 0,
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
  updateSessionQuality(sessionId: number, quality: Parameters<DbAdapter["updateSessionQuality"]>[1]) {
    return this._inner.updateSessionQuality(sessionId, quality);
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
  const sourceKind = options.source ?? "raceiq-raw";
  const db = new ImportCaptureAdapter({ ...options, source: sourceKind });
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    qualityContext: {
      sourceKind,
      ownership: options.ownership,
      sourceChannelProfile: options.sourceChannelProfile,
    },
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
    return rollbackImport(db, new Error("No complete, importable laps were found"));
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

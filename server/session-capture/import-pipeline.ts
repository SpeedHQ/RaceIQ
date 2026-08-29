import { existsSync, unlinkSync } from "node:fs";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta, SessionOwnership } from "../../shared/racing/sessions/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { deleteSession, updateSessionSource } from "../db/session-queries";
import { getServerGame } from "../games/registry";
import { LiveTelemetryPipeline } from "../telemetry/live-pipeline";
import { NullWsAdapter, RealDbAdapter, type DbAdapter, type SessionRecorderAdapter } from "../telemetry/pipeline-ports";
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
  private readonly _sessionMeta = new Map<
    number,
    { carOrdinal: number; trackOrdinal: number }
  >();
  private readonly _sessionSource?: string;


  constructor(options: { notifyDriverProfile?: boolean; ownership?: SessionOwnership; sessionSource?: string } = {}) {
    this._inner = new RealDbAdapter(options);
    this._sessionSource = options.sessionSource;
  }


  async insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string,
    versionIdentity?: TelemetryVersionIdentity,
    ownership?: SessionOwnership,
  ): Promise<number> {
    const id = await this._inner.insertSession(
      carOrdinal,
      trackOrdinal,
      gameId,
      sessionType,
      versionIdentity,
      ownership,
    );
    this.sessionIds.add(id);
    this._sessionMeta.set(id, { carOrdinal, trackOrdinal });
    if (this._sessionSource) await updateSessionSource(id, this._sessionSource);
    return id;

  }

  insertLap(
    sessionId: number,
    lapNumber: number,
    lapTime: number,
    isValid: boolean,
    rawByteOffset: number | null,
    rawFrameCount: number,
    profileId: number | null,
    tuneId: number | null,
    invalidReason: string | null,
    sectors: number[] | null,
    versionIdentity?: TelemetryVersionIdentity,
  ): Promise<number> {
    const pending = this._inner.insertLap(
      sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, versionIdentity
    ).then((id) => {
      const meta = this._sessionMeta.get(sessionId);
      this.laps.push({
        lapId: id,
        sessionId,
        lapNumber,
        lapTime,
        isValid,
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
/** Tracks canonical offsets for imports without persisting derived `.bin` bytes. */
export class ImportSourceOffsetTracker implements SessionRecorderAdapter {
  private activeState = false;
  private started = false;
  private offset = 0;
  private currentEpoch = 0;
  private readonly sourcePath: string;

  constructor(sourcePath: string) {
    this.sourcePath = sourcePath;
  }

  get active(): boolean { return this.activeState; }
  get path(): string | null { return this.activeState ? this.sourcePath : null; }
  get epoch(): number { return this.currentEpoch; }
  start(_gameId: GameId): void {
    if (this.started) throw new Error("Import source cannot be started more than once");
    this.started = true;
    this.activeState = true;
    this.offset = 0;
    this.currentEpoch++;
  }
  writeMetaFrame(): void { if (this.activeState) this.offset = 12; }
  writeRecord(frame: Buffer): void { if (this.activeState) this.offset += 4 + frame.length; }
  getCurrentByteOffset(): number { return this.activeState ? this.offset : 0; }
  flush(): void {}
  async stop(): Promise<void> { this.activeState = false; }
}


export interface ImportSessionOptions {
  /** Roll back the imported session and capture when no complete lap exists. */
  requireLaps?: boolean;
  /** Opt out of background profile generation for offline imports such as seeds. */
  notifyDriverProfile?: boolean;
  /** Ownership classification applied to every created session. */
  ownership?: SessionOwnership;
  /** Recorder used to persist the source representation. */
  recorder?: SessionRecorderAdapter;
  /** Source marker stamped on created sessions before reconciliation. */
  sessionSource?: string;
}


/**
 * Feed any canonical raw-frame stream through an isolated parser + pipeline.
 * The pipeline recorder persists the source representation supplied by the caller,
 * while parser and lap detection operate on canonical frames in memory.
 */
export async function importSessionFrames(
  frames: SessionFrameSource,
  gameId: GameId,
  options: ImportSessionOptions = {},

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
    sessionSource: options.sessionSource,
  });
  const pipeline = new LiveTelemetryPipeline(db, new NullWsAdapter(), {
    bypassPacketRateFilter: true,
    recorder: options.recorder,
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


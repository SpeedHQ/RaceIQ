import type { TelemetryPacket, GameId, LapMeta } from "../shared/types";
import {
  type DbAdapter,
  type WsAdapter,
  type SessionRecorderAdapter,
  RealDbAdapter,
  RealWsAdapter,
  RealSessionRecorderAdapter,
} from "./pipeline-adapters";
import type { ILapDetector, LapDetectorCallbacks } from "./lap-detector-interface";
import { SectorTracker, PitTracker } from "./sector-tracker";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";
import { getServerGame } from "./games/registry";
import { fillNormSuspension } from "./telemetry-utils";
import { LAP_DETECTOR_ID } from "./lap-detector";

export class Pipeline {
  private sectorTracker = new SectorTracker();
  private pitTracker = new PitTracker();
  private _lapDetector: ILapDetector | null = null;
  private _lapDetectorGameId: GameId | null = null;
  private _totalProcessed = 0;
  private db: DbAdapter;
  private ws: WsAdapter;
  private recorder: SessionRecorderAdapter;
  private _bypassPacketRateFilter: boolean;
  private _skipHistorySeeding: boolean;
  private _skipDevState: boolean;
  private _sessionLaps: LapMeta[] = [];

  /** Expose the current lap detector for external readers (routes, UDP handler). */
  get lapDetector(): ILapDetector | null {
    return this._lapDetector;
  }

  /** True while a session is being recorded (session recorder is open). */
  get isSessionActive(): boolean {
    return this.recorder.active;
  }

  /** In-memory session laps — sent to newly connected WS clients. */
  get sessionLaps(): readonly LapMeta[] {
    return this._sessionLaps;
  }

  constructor(
    db: DbAdapter,
    ws: WsAdapter,
    options?: {
      bypassPacketRateFilter?: boolean;
      skipHistorySeeding?: boolean;
      skipDevState?: boolean;
      recorder?: SessionRecorderAdapter;
    },
  ) {
    this.db = db;
    this.ws = ws;
    this.recorder = options?.recorder ?? new RealSessionRecorderAdapter();
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
    this._skipHistorySeeding = options?.skipHistorySeeding ?? false;
    this._skipDevState = options?.skipDevState ?? false;
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {
      onSessionStart: async (session) => {
        // Close previous session recording before opening a new one.
        await this.recorder.stop();
        this.recorder.start(session.gameId);
        this.recorder.writeMetaFrame();
        if (this.recorder.path) {
          await this.db.updateSessionRawFile(
            session.sessionId,
            this.recorder.path,
            this._lapDetector?.detectorId ?? LAP_DETECTOR_ID,
          );
        }

        await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
        this.pitTracker.reset();
        const adapter = tryGetGame(session.gameId);
        if (adapter) this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
        if (!this._skipHistorySeeding) {
          // Seed fuel from history (same engine regardless of compound).
          // Tire wear is NOT seeded — compound-dependent, starts fresh each session.
          await this.pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId);
          await this._seedSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
        } else {
          this._sessionLaps = [];
        }
        this._broadcastSessionLaps();
      },

      onLapComplete: (event) => {
        if (event.isValid) {
          this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
          // Only ACC uses distance-based wear curves; F1/Forza use simple rolling average
          const session = this._lapDetector?.session ?? null;
          if (session && PitTracker.shouldUseCurves(session.gameId)) {
            this.pitTracker.updateWearCurves(event.packets, event.lapDistStart);
          }
        }
      },

      onLapSaved: (event) => {
        this.ws.broadcastNotification({ type: "lap-saved", ...event });
        // Append to in-memory list and broadcast
        const session = this._lapDetector?.session ?? null;
        if (session) {
          this._sessionLaps.push({
            id: event.lapId,
            sessionId: session.sessionId,
            lapNumber: event.lapNumber,
            lapTime: event.lapTime,
            isValid: event.isValid,
            createdAt: new Date().toISOString(),
            gameId: session.gameId,
            carOrdinal: session.carOrdinal,
            trackOrdinal: session.trackOrdinal,
            s1Time: event.sectors?.s1,
            s2Time: event.sectors?.s2,
            s3Time: event.sectors?.s3,
          });
          this._broadcastSessionLaps();
        }
      },
    };
  }

  private _getOrCreateDetector(gameId: GameId): ILapDetector {
    // Create a fresh detector if none exists, or if the game changed
    if (this._lapDetector === null || this._lapDetectorGameId !== gameId) {
      const serverAdapter = getServerGame(gameId);
      this._lapDetector = serverAdapter.createLapDetector({
        db: this.db,
        bypassPacketRateFilter: this._bypassPacketRateFilter,
        callbacks: this._buildCallbacks(),
      });
      this._lapDetectorGameId = gameId;
    }
    return this._lapDetector;
  }

  /**
   * Flush any in-progress lap at end-of-stream as an invalid incomplete lap.
   * Called when the recording ends or a session terminates.
   */
  async flushIncompleteLap(): Promise<void> {
    await this._lapDetector?.flushIncompleteLap?.();
  }

  /** Seed in-memory session laps from DB (called once on session start). */
  private async _seedSessionLaps(
    sessionId: number,
    trackOrdinal: number,
    carOrdinal: number,
    gameId: GameId
  ): Promise<void> {
    try {
      const allLaps = await this.db.getLaps(gameId, 200);
      this._sessionLaps = allLaps.filter(
        (l) => l.sessionId === sessionId && l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal
      );
    } catch {
      this._sessionLaps = [];
    }
  }

  /** Push in-memory session laps to all WS clients. */
  private _broadcastSessionLaps(): void {
    this.ws.broadcastNotification({ type: "session-laps", laps: this._sessionLaps });
  }

  /**
   * Shared telemetry processing pipeline.
   * Called by both UDP listener (Forza/F1) and ACC shared memory reader.
   *
   * Pipeline: normalize coords → lap detection → track calibration (~10Hz) → WebSocket broadcast (30Hz)
   */
  async processPacket(packet: TelemetryPacket, rawBuf?: Buffer): Promise<void> {
    this._totalProcessed++;

    // Snapshot byte offset BEFORE writing so it points to this packet's position
    let rawByteOffset: number | undefined;
    const epochBefore = this.recorder.epoch;
    if (rawBuf && this.recorder.active) {
      rawByteOffset = this.recorder.getCurrentByteOffset();
      this.recorder.writePacket(rawBuf);
    }

    // Normalize coordinates so all games use the same display convention.
    const adapter = tryGetGame(packet.gameId);
    if (adapter && adapter.coordSystem === "standard-xyz") {
      // ACC is right-handed — flip X to match left-handed display convention
      packet.PositionX = -packet.PositionX;
      packet.VelocityX = -packet.VelocityX;
      packet.AccelerationX = -packet.AccelerationX;
    }

    // Compute NormSuspensionTravel for games that don't provide it (F1/ACC)
    fillNormSuspension(packet);

    const detector = this._getOrCreateDetector(packet.gameId);
    await detector.feed(packet, rawByteOffset);

    // If a new session was created during feed — either the very first
    // session (recorder was null) or a rotation (car-changed, etc.) — the
    // triggering packet was written to the PREVIOUS recorder (or not at all).
    // Catch up: write it to the NEW recorder as lap 1's first frame and patch
    // the detector's lap byte offset so the DB row points at the right place.
    if (rawBuf && this.recorder.active && this.recorder.epoch !== epochBefore) {
      const firstOffset = this.recorder.getCurrentByteOffset();
      this.recorder.writePacket(rawBuf);
      detector.setCurrentLapByteOffset?.(firstOffset);
    }

    const sectors = this.sectorTracker.feed(packet);

    // ACC doesn't reliably broadcast BestLap via shared memory — override from session best
    const sessionBest = detector.session?.bestLapTime ?? 0;
    if (packet.gameId === "acc" && sessionBest > 0) {
      packet.BestLap = sessionBest;
    }

    const pit = this.pitTracker.feed(
      packet,
      this.sectorTracker.getTrackLength(),
      this.sectorTracker.getLapDistStart()
    );

    // Track calibration only needed for games whose coordinate system differs from the
    // track outline space (Forza, F1). ACC outlines are already in standard-xyz — skip.
    if (this._totalProcessed % 6 === 0 && adapter?.coordSystem !== "standard-xyz") {
      const session = detector.session;
      if (session && session.trackOrdinal) {
        const outline = getTrackOutlineByOrdinal(session.trackOrdinal, session.gameId);
        if (outline) {
          feedPosition(
            session.trackOrdinal,
            { x: packet.PositionX, z: packet.PositionZ },
            packet.LapNumber,
            outline
          );
        }
      }
    }

    // Broadcast to WebSocket clients (handles 30Hz throttle internally)
    this.ws.broadcast(packet, sectors, pit);

    if (!this._skipDevState) {
      this.ws.broadcastDevState({
        lapDetector: detector.getDebugState?.() ?? {},
        sectorTracker: this.sectorTracker.getDebugState(),
        pitTracker: this.pitTracker.getDebugState(),
      });
    }
  }

  async flushSessionRecorder(): Promise<void> {
    await this.recorder.stop();
  }

  /** Flush buffered writes to disk without closing. */
  flushSessionRecorderBuffer(): void {
    this.recorder.flush();
  }
}

// Backward-compatible singleton exports — unchanged for all callers
const _defaultWs = new RealWsAdapter();
const _default = new Pipeline(new RealDbAdapter(), _defaultWs);

// Wire session laps provider so WS manager can send laps on client connect
import { wsManager } from "./ws";
wsManager.setSessionLapsProvider(() => _default.sessionLaps);

export const processPacket = (p: TelemetryPacket, rawBuf?: Buffer) => _default.processPacket(p, rawBuf);

/** Returns the current lap detector (may be null before the first packet is processed). */
export const lapDetector = {
  get session() { return _default.lapDetector?.session ?? null; },
  get fuelHistory() { return _default.lapDetector?.fuelHistory ?? []; },
  get tireWearHistory() { return _default.lapDetector?.tireWearHistory ?? []; },
  async finalizeCurrentSession() { await _default.lapDetector?.finalizeCurrentSession?.(); },
};

/** In-memory session laps for the current session. */
export function getSessionLaps(): readonly LapMeta[] {
  return _default.sessionLaps;
}

// Periodic check: flush stale laps when packets stop (e.g. race ended, game
// closed). `.unref()` so bun test's event loop can exit once the tests are
// done — without it every test that transitively imports this module hangs
// the runner waiting for a never-arriving interval tick.
const _maintenanceInterval = setInterval(() => _default.lapDetector?.flushStaleLap?.(), 5_000);
_maintenanceInterval.unref?.();

/** Stop the module-level maintenance interval. Call in test/bench contexts to allow clean exit. */
export function stopMaintenanceTasks(): void {
  clearInterval(_maintenanceInterval);
}

/** True while a session is actively being recorded. */
export function isSessionActive(): boolean {
  return _default.isSessionActive;
}

/** Flush and close the active session recorder. Call on graceful shutdown. */
export async function flushSessionRecorder(): Promise<void> {
  await _default.flushSessionRecorder();
}

/** Flush buffered writes to disk. Call periodically so lap offsets stay consistent with file size. */
export function flushSessionRecorderBuffer(): void {
  _default.flushSessionRecorderBuffer();
}

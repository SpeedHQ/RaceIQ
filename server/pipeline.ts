import type { TelemetryPacket, GameId } from "../shared/types";
import { type DbAdapter, type WsAdapter, RealDbAdapter, RealWsAdapter } from "./pipeline-adapters";
import type { ILapDetector, LapDetectorCallbacks } from "./lap-detector-interface";
import { SectorTracker, PitTracker } from "./sector-tracker";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";
import { getServerGame } from "./games/registry";
import { fillNormSuspension } from "./telemetry-utils";

export class Pipeline {
  private sectorTracker = new SectorTracker();
  private pitTracker = new PitTracker();
  private _lapDetector: ILapDetector | null = null;
  private _lapDetectorGameId: GameId | null = null;
  private _totalProcessed = 0;
  private db: DbAdapter;
  private ws: WsAdapter;
  private _bypassPacketRateFilter: boolean;

  /** Expose the current lap detector for external readers (routes, UDP handler). */
  get lapDetector(): ILapDetector | null {
    return this._lapDetector;
  }

  constructor(db: DbAdapter, ws: WsAdapter, options?: { bypassPacketRateFilter?: boolean }) {
    this.db = db;
    this.ws = ws;
    this._bypassPacketRateFilter = options?.bypassPacketRateFilter ?? false;
  }

  private _buildCallbacks(): LapDetectorCallbacks {
    return {
      onSessionStart: async (session) => {
        await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
        this.pitTracker.reset();
        const adapter = tryGetGame(session.gameId);
        if (adapter) this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
        // Seed fuel from history (same engine regardless of compound).
        // Tire wear is NOT seeded — compound-dependent, starts fresh each session.
        await this.pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId);
        await this._broadcastSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
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
        // Re-push updated lap list after save completes
        const session = this._lapDetector?.session ?? null;
        if (session) this._broadcastSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
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

  /** Push the current session's recorded laps (filtered by session) to all WS clients. */
  private async _broadcastSessionLaps(
    sessionId: number,
    trackOrdinal: number,
    carOrdinal: number,
    gameId: GameId
  ): Promise<void> {
    try {
      const allLaps = await this.db.getLaps(gameId, 200);
      const laps = allLaps.filter(
        (l) => l.sessionId === sessionId && l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal
      );
      this.ws.broadcastNotification({ type: "session-laps", laps });
    } catch {}
  }

  /**
   * Shared telemetry processing pipeline.
   * Called by both UDP listener (Forza/F1) and ACC shared memory reader.
   *
   * Pipeline: normalize coords → lap detection → track calibration (~10Hz) → WebSocket broadcast (30Hz)
   */
  async processPacket(packet: TelemetryPacket): Promise<void> {
    this._totalProcessed++;

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
    await detector.feed(packet);

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

    this.ws.broadcastDevState({
      lapDetector: detector.getDebugState?.() ?? {},
      sectorTracker: this.sectorTracker.getDebugState(),
      pitTracker: this.pitTracker.getDebugState(),
    });
  }
}

// Backward-compatible singleton exports — unchanged for all callers
const _default = new Pipeline(new RealDbAdapter(), new RealWsAdapter());
export const processPacket = (p: TelemetryPacket) => _default.processPacket(p);

/** Returns the current lap detector (may be null before the first packet is processed). */
export const lapDetector = {
  get session() { return _default.lapDetector?.session ?? null; },
  get fuelHistory() { return _default.lapDetector?.fuelHistory ?? []; },
  get tireWearHistory() { return _default.lapDetector?.tireWearHistory ?? []; },
};

// Periodic check: flush stale laps when packets stop (e.g. race ended, game closed)
setInterval(() => _default.lapDetector?.flushStaleLap?.(), 5_000);

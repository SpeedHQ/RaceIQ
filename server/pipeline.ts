import type { TelemetryPacket, GameId } from "../shared/types";
import { type DbAdapter, type WsAdapter, RealDbAdapter, RealWsAdapter } from "./pipeline-adapters";
import { LapDetector } from "./lap-detector";
import { SectorTracker, PitTracker } from "./sector-tracker";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";
import { fillNormSuspension } from "./telemetry-utils";

export class Pipeline {
  private sectorTracker = new SectorTracker();
  private pitTracker = new PitTracker();
  readonly lapDetector: LapDetector;
  private _totalProcessed = 0;

  constructor(private db: DbAdapter, private ws: WsAdapter) {
    this.lapDetector = new LapDetector(db);

    this.lapDetector.onSessionStart = async (session) => {
      await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
      this.pitTracker.reset();
      const adapter = tryGetGame(session.gameId);
      if (adapter) this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
      // Seed fuel from history (same engine regardless of compound).
      // Tire wear is NOT seeded — compound-dependent, starts fresh each session.
      await this.pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId);
      await this._broadcastSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
    };

    this.lapDetector.onLapComplete_ = (event) => {
      if (event.isValid) {
        this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
        // Only ACC uses distance-based wear curves; F1/Forza use simple rolling average
        const session = this.lapDetector.session;
        if (session && PitTracker.shouldUseCurves(session.gameId)) {
          this.pitTracker.updateWearCurves(event.packets, event.lapDistStart);
        }
      }
    };

    this.lapDetector.onLapSaved = (event) => {
      ws.broadcastNotification({ type: "lap-saved", ...event });
      // Re-push updated lap list after save completes
      const session = this.lapDetector.session;
      if (session) this._broadcastSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
    };
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

    await this.lapDetector.feed(packet);

    const sectors = this.sectorTracker.feed(packet);

    // ACC doesn't reliably broadcast BestLap via shared memory — override from session best
    const sessionBest = this.lapDetector.session?.bestLapTime ?? 0;
    if (packet.gameId === "acc" && sessionBest > 0) {
      packet.BestLap = sessionBest;
    }

    const pit = this.pitTracker.feed(
      packet,
      this.sectorTracker.getTrackLength(),
      this.sectorTracker.getLapDistStart()
    );

    // Track calibration only needs sparse position data (~10Hz)
    if (this._totalProcessed % 6 === 0) {
      const session = this.lapDetector.session;
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
      lapDetector: this.lapDetector.getDebugState(),
      sectorTracker: this.sectorTracker.getDebugState(),
      pitTracker: this.pitTracker.getDebugState(),
    });
  }
}

// Backward-compatible singleton exports — unchanged for all callers
const _default = new Pipeline(new RealDbAdapter(), new RealWsAdapter());
export const processPacket = (p: TelemetryPacket) => _default.processPacket(p);
export const lapDetector = _default.lapDetector;

// Periodic check: flush stale laps when packets stop (e.g. race ended, game closed)
setInterval(() => _default.lapDetector.flushStaleLap(), 5_000);

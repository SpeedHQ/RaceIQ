import type { TelemetryPacket, GameId } from "../shared/types";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { SectorTracker, PitTracker } from "./sector-tracker";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";
import { fillNormSuspension } from "./telemetry-utils";
import { getLaps } from "./db/queries";

const sectorTracker = new SectorTracker();
const pitTracker = new PitTracker();

/** Push the current session's recorded laps (filtered by track+car) to all WS clients. */
async function broadcastSessionLaps(trackOrdinal: number, carOrdinal: number, gameId: GameId): Promise<void> {
  try {
    const allLaps = await getLaps(gameId, 200);
    const laps = allLaps.filter((l) => l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal);
    wsManager.broadcastNotification({ type: "session-laps", laps });
  } catch {}
}

lapDetector.onSessionStart = async (session) => {
  await sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
  pitTracker.reset();
  const adapter = tryGetGame(session.gameId);
  if (adapter) pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
  // Seed fuel from history (same engine regardless of compound).
  // Tire wear is NOT seeded — compound-dependent, starts fresh each session.
  await pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId);
  await broadcastSessionLaps(session.trackOrdinal, session.carOrdinal, session.gameId);
};

lapDetector.onLapComplete_ = (event) => {
  if (event.isValid) {
    sectorTracker.updateRefLap(event.packets, event.lapDistStart, event.lapTime, event.sectors);
    // Only ACC uses distance-based wear curves; F1/Forza use simple rolling average
    const session = lapDetector.session;
    if (session && PitTracker.shouldUseCurves(session.gameId)) {
      pitTracker.updateWearCurves(event.packets, event.lapDistStart);
    }
  }
};

lapDetector.onLapSaved = (event) => {
  wsManager.broadcastNotification({ type: "lap-saved", ...event });
  // Re-push updated lap list after save completes
  const session = lapDetector.session;
  if (session) broadcastSessionLaps(session.trackOrdinal, session.carOrdinal, session.gameId);
};

let _totalProcessed = 0;

/**
 * Shared telemetry processing pipeline.
 * Called by both UDP listener (Forza/F1) and ACC shared memory reader.
 *
 * Pipeline: normalize coords → lap detection → track calibration (~10Hz) → WebSocket broadcast (30Hz)
 */
export async function processPacket(packet: TelemetryPacket): Promise<void> {
  _totalProcessed++;

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

  await lapDetector.feed(packet);

  const sectors = sectorTracker.feed(packet);
  const pit = pitTracker.feed(packet, sectorTracker.getTrackLength(), sectorTracker.getLapDistStart());

  // Track calibration only needs sparse position data (~10Hz)
  if (_totalProcessed % 6 === 0) {
    const session = lapDetector.session;
    if (session && session.trackOrdinal) {
      const outline = getTrackOutlineByOrdinal(
        session.trackOrdinal,
        session.gameId
      );
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
  wsManager.broadcast(packet, sectors, pit);
}

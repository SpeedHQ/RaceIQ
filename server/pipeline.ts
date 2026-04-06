import type { TelemetryPacket } from "../shared/types";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { SectorTracker, PitTracker } from "./sector-tracker";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";
import { fillNormSuspension } from "./telemetry-utils";

const sectorTracker = new SectorTracker();
const pitTracker = new PitTracker();

lapDetector.onSessionStart = async (session) => {
  await sectorTracker.reset(session.trackOrdinal, session.gameId);
  pitTracker.reset();
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
  const pit = pitTracker.feed(packet, sectorTracker.getTrackLength());

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

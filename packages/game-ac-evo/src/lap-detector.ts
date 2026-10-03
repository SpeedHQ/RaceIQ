import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getOrCreateDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import type { LapDetectorOptions } from "@raceiq/backend-core/lap-detection/types";
import { KunosLapDetector } from "@raceiq/backend-core/games/kunos/lap-detector";
import { classifyKunosTrackLimits } from "@raceiq/backend-core/games/kunos/lap-rules";

// v4: compact replays preserve validity transitions for track-limits classification.
export const LAP_DETECTOR_AC_EVO_ID = "ac_evo_lapdetector_v4";

/** AC Evo policy hooks for the shared Kunos lap lifecycle. */
export class LapDetectorAcEvo extends KunosLapDetector {
  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_AC_EVO_ID, "[AC Evo Lap Detector]");
  }

  /**
   * AC Evo has no stable car ordinals. Register unresolved shared-memory
   * model names in discovered_cars to obtain a stable ordinal.
   */
  protected resolveCarOrdinal(packet: TelemetryPacket): number | Promise<number> {
    if (packet.CarOrdinal >= 0 || !packet.carModelName || packet.gameId !== "ac-evo") {
      return packet.CarOrdinal;
    }
    return getOrCreateDiscoveredCar(packet.gameId, packet.carModelName);
  }

  protected async backfillSessionIdentifiers(packet: TelemetryPacket): Promise<void> {
    const session = this.session!;
    const resolvedTrack = packet.TrackOrdinal ?? -1;
    const carOrdinalResult = this.resolveCarOrdinal(packet);
    const resolvedCarOrdinal =
      typeof carOrdinalResult === "number" ? carOrdinalResult : await carOrdinalResult;
    if (
      (session.trackOrdinal < 0 && resolvedTrack >= 0) ||
      (session.carOrdinal < 0 && resolvedCarOrdinal >= 0)
    ) {
      if (resolvedTrack >= 0) session.trackOrdinal = resolvedTrack;
      if (resolvedCarOrdinal >= 0) session.carOrdinal = resolvedCarOrdinal;
      await this.db.updateSessionCarTrack(
        session.sessionId,
        session.carOrdinal,
        session.trackOrdinal,
      );
    }
  }

  protected classifyTrackLimits(packets: TelemetryPacket[]): "track limits" | null {
    return classifyKunosTrackLimits(packets);
  }
}

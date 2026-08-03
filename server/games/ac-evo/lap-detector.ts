import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { getOrCreateDiscoveredCar } from "../../db/discovered-cars";
import type { LapDetectorOptions } from "../../lap-detection/types";
import { KunosLapDetector } from "../kunos/lap-detector";
import { classifyKunosTrackLimits } from "../kunos/lap-rules";

// v2: added track-limits invalidation from the per-frame is_valid_lap flag.
// Bumping the id makes every previously-recorded AC Evo session stale so
// /api/sessions/reprocess-stale backfills the new invalid reasons.
export const LAP_DETECTOR_AC_EVO_ID = "ac_evo_lapdetector_v2";

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

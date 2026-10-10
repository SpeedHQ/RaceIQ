import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getOrCreateDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import { getOrCreateDiscoveredTrack } from "@raceiq/backend-core/db/discovered-tracks";
import type { LapDetectorOptions } from "@raceiq/backend-core/lap-detection/types";
import { KunosLapDetector } from "@raceiq/backend-core/games/kunos/lap-detector";
import { classifyKunosTrackLimits } from "@raceiq/telemetry-core/processor/kunos-policy";

import { isAcEvoTouristLayout } from "./layout-policy";
// v5: tourist timed attempts use source finish counts and open-route geometry.
export const LAP_DETECTOR_AC_EVO_ID = "ac_evo_lapdetector_v5";

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
    if (packet.gameId !== "ac-evo" || !packet.acEvoIdentity) return packet.CarOrdinal;
    return getOrCreateDiscoveredCar(packet.gameId, packet.acEvoIdentity.carName || packet.carModelName || "");
  }

  protected resolveTrackOrdinal(packet: TelemetryPacket): number | Promise<number> {
    if (packet.gameId !== "ac-evo" || !packet.acEvoIdentity) return packet.TrackOrdinal;
    return getOrCreateDiscoveredTrack(
      packet.gameId,
      packet.acEvoIdentity.trackName,
      packet.acEvoIdentity.trackConfiguration,
    );
  }
  protected isOpenRoute(packet: TelemetryPacket): boolean {
    return isAcEvoTouristLayout(packet);
  }

  protected async backfillSessionIdentifiers(packet: TelemetryPacket): Promise<void> {
    const session = this.session!;
    const nextTrack = packet.TrackOrdinal;
    const nextCar = packet.CarOrdinal;
    const trackChanged = nextTrack >= 0 && nextTrack !== session.trackOrdinal;
    const carChanged = nextCar >= 0 && nextCar !== session.carOrdinal;
    if (!trackChanged && !carChanged) return;
    if (trackChanged) session.trackOrdinal = nextTrack;
    if (carChanged) session.carOrdinal = nextCar;
    await this.db.updateSessionCarTrack(
      session.sessionId,
      session.carOrdinal,
      session.trackOrdinal,
    );
  }

  protected classifyTrackLimits(packets: TelemetryPacket[]): "track limits" | null {
    return classifyKunosTrackLimits(packets);
  }
}

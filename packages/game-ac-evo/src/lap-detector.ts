import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { registerAcEvoCar } from "@raceiq/backend-core/db/discovered-cars";
import { registerAcEvoTrack } from "@raceiq/backend-core/db/discovered-tracks";
import type { SessionIdentity } from "@raceiq/backend-core/telemetry/pipeline-ports";
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

  protected async resolveSessionIdentity(packet: TelemetryPacket): Promise<SessionIdentity | undefined> {
    if (packet.gameId !== "ac-evo" || !packet.acEvoIdentity) return undefined;
    const [carId, trackId] = await Promise.all([
      registerAcEvoCar(packet.acEvoIdentity.carName || packet.carModelName || ""),
      registerAcEvoTrack(packet.acEvoIdentity.trackName, packet.acEvoIdentity.trackConfiguration),
    ]);
    return carId && trackId ? { carId, trackId } : undefined;
  }

  protected isOpenRoute(packet: TelemetryPacket): boolean {
    return isAcEvoTouristLayout(packet);
  }

  protected classifyTrackLimits(packets: TelemetryPacket[]): "track limits" | null {
    return classifyKunosTrackLimits(packets);
  }
}

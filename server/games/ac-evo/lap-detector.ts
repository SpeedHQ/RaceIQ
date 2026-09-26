import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { LapDetectorOptions } from "../../lap-detection/types";
import { KunosLapDetector } from "../kunos/lap-detector";
import { classifyKunosTrackLimits } from "../kunos/lap-rules";

// v3: drops short pre-lap timer prefixes and aligns capture frame windows.
// Bumping the id makes prior captures stale so reprocessing repairs offsets.
export const LAP_DETECTOR_AC_EVO_ID = "ac_evo_lapdetector_v3";

/** AC Evo policy hooks for the shared Kunos lap lifecycle. */
export class LapDetectorAcEvo extends KunosLapDetector {
  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_AC_EVO_ID, "[AC Evo Lap Detector]");
  }


  protected classifyTrackLimits(packets: TelemetryPacket[]): "track limits" | null {
    return classifyKunosTrackLimits(packets);
  }
}

import type { LapDetectorOptions } from "../../lap-detection/types";
import { KunosLapDetector } from "../kunos/lap-detector";

// v4: prefers source-reported validity for completed laps.
export const LAP_DETECTOR_ACC_ID = "acc_lapdetector_v4";

/** ACC policy hooks for the shared Kunos lap lifecycle. */
export class LapDetectorAcc extends KunosLapDetector {
  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_ACC_ID, "[ACC Lap Detector]");
  }
}

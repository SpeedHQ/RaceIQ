import type { LapDetectorOptions } from "../../lap-detection/types";
import { KunosLapDetector } from "../kunos/lap-detector";

export const LAP_DETECTOR_ACC_ID = "acc_lapdetector_v2";

/** ACC policy hooks for the shared Kunos lap lifecycle. */
export class LapDetectorAcc extends KunosLapDetector {
  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_ACC_ID, "[ACC Lap Detector]");
  }
}

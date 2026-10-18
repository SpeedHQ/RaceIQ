import type { LapDetectorOptions } from "@raceiq/backend-core/lap-detection/types";
import { KunosLapDetector } from "@raceiq/backend-core/games/kunos/lap-detector";

// v5: circuit lap boundaries use timing evidence, not distance-counter resets.
export const LAP_DETECTOR_ACC_ID = "acc_lapdetector_v5";

/** ACC adapter keeps host detector identity while policy lives in processor. */
export class LapDetectorAcc extends KunosLapDetector {

  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_ACC_ID, "[ACC Lap Detector]");
  }
}

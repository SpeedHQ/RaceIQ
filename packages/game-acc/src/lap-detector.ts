import type { LapDetectorOptions } from "@raceiq/backend-core/lap-detection/types";
import { KunosLapDetector } from "@raceiq/backend-core/games/kunos/lap-detector";

// v6: distinguish teleport-to-pits resets from driven pit entries.
export const LAP_DETECTOR_ACC_ID = "acc_lapdetector_v6";

/** ACC adapter keeps host detector identity while policy lives in processor. */
export class LapDetectorAcc extends KunosLapDetector {

  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_ACC_ID, "[ACC Lap Detector]");
  }
}

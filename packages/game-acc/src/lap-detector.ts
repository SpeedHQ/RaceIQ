import type { LapDetectorOptions } from "@raceiq/backend-core/lap-detection/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { KunosLapDetector } from "@raceiq/backend-core/games/kunos/lap-detector";

// v4: prefers source-reported validity for completed laps.
export const LAP_DETECTOR_ACC_ID = "acc_lapdetector_v4";

/** ACC policy hooks for the shared Kunos lap lifecycle. */
export class LapDetectorAcc extends KunosLapDetector {
  protected override recordedLapValidity(packets: readonly TelemetryPacket[], trigger?: TelemetryPacket): boolean | null {
    return packets[packets.length - (trigger ? 2 : 1)]?.acc?.isValidLap ?? null;
  }

  constructor(opts: LapDetectorOptions) {
    super(opts, LAP_DETECTOR_ACC_ID, "[ACC Lap Detector]");
  }
}

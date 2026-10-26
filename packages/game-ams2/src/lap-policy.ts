import type { LapDetectorPolicy } from "@raceiq/telemetry-core/processor/lap-policy";
import { resolveAMS2LapReset } from "./lap-reset";
import { classifyAMS2PitCycle, resolveAMS2InvalidReason } from "./lap-validity";

export const AMS2_LAP_DETECTOR_POLICY: LapDetectorPolicy = {
  resolveLapReset: resolveAMS2LapReset,
  resolveLapTime: (_packets, next) => next.LastLap > 0 ? next.LastLap : 0,
  classifyPitCycle: classifyAMS2PitCycle,
  invalidReason: resolveAMS2InvalidReason,
};

import type { WheelTrace } from "@raceiq/analysis-core/racing/laps/alignment/types";
import type { LapTrace } from "../../../lib/stint-traces";

export type TrackFocusTrace = LapTrace & {
  fuel: Float32Array;
  tireWearTrace: WheelTrace<Float32Array> | null;
};

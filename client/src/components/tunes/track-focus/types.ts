import type { WheelTrace } from "@shared/racing/laps/alignment/types";
import type { LapTrace } from "../../../lib/stint-traces";

export type TrackFocusTrace = LapTrace & {
  fuel: Float32Array;
  tireWearTrace: WheelTrace<Float32Array> | null;
};

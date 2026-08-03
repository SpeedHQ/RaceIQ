export interface TireAverages {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}

/** Per-sample (distance-fraction binned) traces for each tire corner. */
export interface TireTraces {
  FL: Float32Array;
  FR: Float32Array;
  RL: Float32Array;
  RR: Float32Array;
}

export interface LapTrace {
  lapId: number;
  lapNumber: number;
  isValid: boolean;
  n: number;
  /** Distance fraction 0..1 for each sample. */
  frac: Float32Array;
  throttle: Float32Array;
  brake: Float32Array;
  /** Signed -1..1 (negative = left, positive = right). */
  steer: Float32Array;
  speedKmh: Float32Array;
  /** Seconds elapsed since the first sample, derived from TimestampMS
   *  (wrap-corrected) — used to compute time-at-distance deltas between laps. */
  timeS: Float32Array;
  /** Per-lap average tire temp (°C-ish, game units), skipping zero frames.
   *  Null when the lap has no usable tire temp data. */
  tire: TireAverages | null;
  /** Per-lap average tire pressure, skipping zero frames. Null when absent
   *  (e.g. non-ACC games with no TirePressure* fields). */
  pressure: TireAverages | null;
  /** Per-sample tire temp per corner (zero frames skipped, carry-forward
   *  across empty bins). Null when the lap has no usable tire temp data. */
  tireTempTrace: TireTraces | null;
  /** Per-sample tire pressure per corner. Null when absent. */
  pressureTrace: TireTraces | null;
  /** Signed per-frame axle slip delta in degrees: mean(|slipFL|,|slipFR|) −
   *  mean(|slipRL|,|slipRR|). Positive = front slips more (understeer),
   *  negative = rear slips more (oversteer). Null when the game reports no
   *  slip-angle data (all frames exactly 0). */
  balance: Float32Array | null;
  /** Lateral g (AccelerationX / 9.81). Null when the source field is absent. */
  latG: Float32Array | null;
  /** Longitudinal g (AccelerationZ / 9.81). Negative under braking. Null
   *  when the source field is absent. */
  longG: Float32Array | null;
  /** Per-corner normalized suspension travel (0..1). ACC: absolute
   *  compression (0 = full droop). AC Evo: centred at 0.5 (neutral ride
   *  height). Null when absent (e.g. F1, which hardcodes 0). */
  suspTravel: TireTraces | null;
  /** Per-corner combined tire slip magnitude. Null when absent. */
  combinedSlip: TireTraces | null;
  /** Per-lap average brake temp per corner (°C, game units), skipping zero
   *  frames. Null when the lap has no usable brake temp data. */
  brakeTemp: TireAverages | null;
  /** Per-sample brake temp per corner (zero frames skipped, carry-forward like
   *  tire temp). Null when absent. */
  brakeTempTrace: TireTraces | null;
}

export interface EncodedTireTraces {
  FL: string;
  FR: string;
  RL: string;
  RR: string;
}

export interface EncodedLapTrace {
  lapId: number;
  lapNumber: number;
  isValid: boolean;
  n: number;
  frac: string;
  throttle: string;
  brake: string;
  steer: string;
  speedKmh: string;
  timeS: string;
  tire: TireAverages | null;
  pressure: TireAverages | null;
  tireTempTrace: EncodedTireTraces | null;
  pressureTrace: EncodedTireTraces | null;
  balance: string | null;
  latG: string | null;
  longG: string | null;
  suspTravel: EncodedTireTraces | null;
  combinedSlip: EncodedTireTraces | null;
  brakeTemp: TireAverages | null;
  brakeTempTrace: EncodedTireTraces | null;
}

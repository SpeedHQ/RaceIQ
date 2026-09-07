export type WheelKey = "FL" | "FR" | "RL" | "RR";

export interface WheelTrace<T> {
  FL: T;
  FR: T;
  RL: T;
  RR: T;
}

export interface WheelAverages {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}

export interface AlignedLapTrace {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  frac: Float32Array;
  sourceIndices: Uint32Array;
  speedMps: Float32Array;
  throttle: Float32Array;
  brake: Float32Array;
  steer: Float32Array;
  rpm: Float32Array;
  gear: Uint8Array;
  positionX: Float32Array;
  positionZ: Float32Array;
  yaw: Float32Array;
  elapsedTimeS: Float32Array;
  fuel: Float32Array;
  tireWear: Float32Array | null;
  tireTemp: WheelTrace<Float32Array> | null;
  tirePressure: WheelTrace<Float32Array> | null;
  brakeTemp: WheelTrace<Float32Array> | null;
  suspTravel: WheelTrace<Float32Array> | null;
  combinedSlip: WheelTrace<Float32Array> | null;
  balanceDeg: Float32Array | null;
  latG: Float32Array | null;
  longG: Float32Array | null;
  tireAverages: WheelAverages | null;
  pressureAverages: WheelAverages | null;
  brakeTempAverages: WheelAverages | null;
}

export interface AlignedLapSet {
  distanceMeters: Float32Array;
  distanceFractions: Float32Array;
  nominalSpanMeters: number;
  distanceStartMeters: number;
  distanceEndMeters: number;
  stepMeters: number;
  referenceLapId: number;
  laps: AlignedLapTrace[];
}

export interface EncodedWheelTrace {
  FL: string;
  FR: string;
  RL: string;
  RR: string;
}

export interface EncodedAlignedLapTrace {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sourceIndices: string;
  speedMps: string;
  throttle: string;
  brake: string;
  steer: string;
  rpm: string;
  gear: string;
  positionX: string;
  positionZ: string;
  yaw: string;
  elapsedTimeS: string;
  fuel: string;
  tireWear: string | null;
  tireTemp: EncodedWheelTrace | null;
  tirePressure: EncodedWheelTrace | null;
  brakeTemp: EncodedWheelTrace | null;
  suspTravel: EncodedWheelTrace | null;
  combinedSlip: EncodedWheelTrace | null;
  balanceDeg: string | null;
  latG: string | null;
  longG: string | null;
  tireAverages: WheelAverages | null;
  pressureAverages: WheelAverages | null;
  brakeTempAverages: WheelAverages | null;
}

export interface EncodedAlignedLapSet {
  distanceMeters: string;
  distanceFractions: string;
  nominalSpanMeters: number;
  distanceStartMeters: number;
  distanceEndMeters: number;
  stepMeters: number;
  referenceLapId: number;
  laps: EncodedAlignedLapTrace[];
}

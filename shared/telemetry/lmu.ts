import type { TelemetryTimestamp } from "./resolver/contracts";
import type { LmuSupplementalObservation } from "./lmu-supplemental";
export interface LmuFrameKey {
  sessionKey: string;
  captureSequence: string;
  frameTime: TelemetryTimestamp;
}
/** Phase 1 player/session supplement; no competitor collection. */
export interface LmuLiveContext {
  schemaVersion: 1;
  key: LmuFrameKey;
  playerVehicleId: number | null;
  status: "active" | "unavailable";
  supplemental: readonly LmuSupplementalObservation[];
}
export interface LMUExtendedData {
  carId: string;
  trackId: string;
  gameVersion: number;
  /** Native telemetry mElapsedTime, in session seconds; invalid source values stay unavailable. */
  elapsedTime?: number | null;
  /** Native scoring mCurrentET, in the same session clock, sampled at scoring cadence. */
  scoringCurrentElapsedTime?: number | null;
  sessionType: string;
  sessionTypeOrdinal: number;
  deltaBest?: number;
  /** Internal native telemetry clock metadata; not a user-facing metric. */
  telemetryElapsedTime?: number;
  /** Internal native scoring clock metadata; not a user-facing metric. */
  scoringElapsedTime?: number;
  vehicleId?: number;
  driverName: string;
  carName: string;
  carModel: string;
  vehicleClass: number;
  trackName: string;
  trackLengthM: number;
  lapDistanceM?: number;
  currentSectorIndex?: number;
  bestSector1?: number;
  bestSector2?: number;
  lastSector1?: number;
  lastSector2?: number;
  currentSector1?: number;
  currentSector2?: number;
  lapInvalidated?: boolean;
  inPits?: boolean;
  pitState?: number;
  frontTireCompound?: string;
  rearTireCompound?: string;
  rearFlapActivated?: boolean;
  rearFlapLegalStatus?: number;
  speedLimiterActive?: boolean;
  tcActive?: boolean;
  tcLevel?: number;
  absActive?: boolean;
  tcCutLevel?: number;
  absLevel?: number;
  motorMap?: number;
  migration?: number;
  frontAntiSway?: number;
  rearAntiSway?: number;
  batteryChargeFraction?: number;
  stateOfCharge?: number;
  virtualEnergy?: number;
  regenKw?: number;
  trackLimitsSteps?: number;
  trackGripLevel?: number;
  cloudCoverage?: number;
  engineRpm?: number;
  motorWaterTemperature?: number;
  motorState?: number;
  steeringShaftTorque?: number;
  throttle?: number;
  brake?: number;
  steering?: number;
  clutch?: number;
  timeGapCarAhead?: number;
  timeGapCarBehind?: number;
  timeGapPlaceAhead?: number;
  timeGapPlaceBehind?: number;
  engineWaterTemp?: number;
  engineOilTemp?: number;
  engineTorque?: number;
  motorRpm?: number;
  motorTorque?: number;
  motorTemperature?: number;
  rainIntensity?: number;
  darkCloud?: number;
  minimumPathWetness?: number;
  maximumPathWetness?: number;
  averagePathWetness?: number;
  wind?: readonly number[];
  ignitionStarter?: number;
  overheating?: boolean;
  penaltyCount?: number;
  pitStopCount?: number;
  inGarageStall?: boolean;
  finishStatus?: number;
  control?: number;
  yellowFlagState?: number;
  sectorFlags?: readonly number[];
  gamePhase?: number;
  scheduledStops?: number;
  primaryFlag?: number;
  underYellow?: boolean;
  countLapFlag?: number;
}

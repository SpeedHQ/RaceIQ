export interface IRacingCompetitor {
  carIndex: number;
  userId?: number;
  displayName?: string;
  carClassId?: number;
  carClassShortName?: string;
  isSpectator?: boolean;
  carIsPaceCar?: boolean;
  position?: number;
  classPosition?: number;
  lapsComplete?: number;
  lastLapTime?: number;
  bestLapTime?: number;
  onPitRoad?: boolean;
  trackLocation?: number;
}

export interface IRacingExtendedData {
  sessionTick: number;
  sessionNum: number;
  driverCarIdx: number;
  trackLengthM: number;
  lapDistanceM: number;
  lapDistancePct: number;
  /** Native current-lap timer before RaceIQ's physical-line correction. */
  sdkCurrentLapTime?: number;
  /** Native session-info sector layout; absent when the SDK did not publish it. */
  sectorStarts?: number[];
  onPitRoad: boolean;
  playerTrackSurface: number;
  /** Native irsdk_CarLeftRight occupancy code for spotter use. */
  carLeftRight?: number;
  sessionFlags?: number;
  sessionState?: number;
  sessionTimeRemain?: number;
  carIdxPosition?: readonly number[];
  carIdxClassPosition?: readonly number[];
  carIdxLapCompleted?: readonly number[];
  carIdxOnPitRoad?: readonly boolean[];
  incidents: number;
  /** Native irsdk_TrackWetness category (0 unknown through 7 extremely wet). */
  trackWetness: number;
  /** Pit-only tire channels have produced a complete four-corner snapshot. */
  pitTireTemperatureAvailable?: boolean;
  pitTireWearAvailable?: boolean;
  carName: string;
  carClassName: string;
  trackName: string;
  competitors?: readonly IRacingCompetitor[];
  /** Native opponent arrays retained for conservative completed-lap inference. */
  carIdxLap?: readonly number[];
  carIdxLastLapTime?: readonly number[];
  carIdxBestLapTime?: readonly number[];
  carIdxTrackSurface?: readonly number[];
}

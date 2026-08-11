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
  incidents: number;
  /** Native irsdk_TrackWetness category (0 unknown through 7 extremely wet). */
  trackWetness: number;
  /** Pit-only tire channels have produced a complete four-corner snapshot. */
  pitTireTemperatureAvailable?: boolean;
  pitTireWearAvailable?: boolean;
  carName: string;
  carClassName: string;
  trackName: string;
}

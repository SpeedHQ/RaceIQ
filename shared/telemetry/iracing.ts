export interface IRacingExtendedData {
  sessionTick: number;
  sessionNum: number;
  /** Native SessionFlags bitfield retained for catalog-semantic race control. */
  sessionFlags?: number;
  /** Native SessionState enum retained for catalog-semantic race control. */
  sessionState?: number;
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
  /** Raw native SDK values retained for catalog-semantic resolution. */
  PlayerCarInPitStall?: boolean;
  PitstopActive?: boolean;
  PlayerCarPitSvStatus?: number;
  PitSvFlags?: number;
  PitSvFuel?: number;
  PitRepairLeft?: number;
  PitOptRepairLeft?: number;
  LFTiresUsed?: number;
  RFTiresUsed?: number;
  LRTiresUsed?: number;
  RRTiresUsed?: number;
  /** Native full-set counter; each increment represents four tires. */
  TireSetsUsed?: number;
  carName: string;
  carClassName: string;
  trackName: string;
}

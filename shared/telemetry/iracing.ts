export interface IRacingCompetitor {
  carIndex: number;
  driverId: string;
  driverName: string;
  carClassIdString: string;
  carClassName: string;
  pitStatus: "in_pit" | "out";
  trackLocationName: "not-in-world" | "off-track" | "pit-stall" | "approaching-pits" | "track";
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
  sessionType: string;
  driverCarIdx: number;
  playerCarClassId?: string;
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
  trackWetness: number;
  pitTireTemperatureAvailable?: boolean;
  pitTireWearAvailable?: boolean;
  carName: string;
  carClassName: string;
  trackName: string;
  competitors?: readonly IRacingCompetitor[];
  competitorDriverId?: readonly string[];
  competitorDriverName?: readonly string[];
  competitorCarClassIdString?: readonly string[];
  competitorCarClassName?: readonly string[];
  competitorPitStatus?: readonly ("in_pit" | "out")[];
  competitorTrackLocationName?: readonly IRacingCompetitor["trackLocationName"][];
  carIdxLap?: readonly number[];
  carIdxLastLapTime?: readonly number[];
  carIdxBestLapTime?: readonly number[];
  carIdxTrackSurface?: readonly number[];
}

export type AccBroadcastLocation = number;

export interface AccBroadcastLap {
  timeMs: number | null;
  carIndex: number;
  driverIndex: number;
  splitsMs: readonly (number | null)[];
  isInvalid: boolean;
  isValidForBest: boolean;
  isOutlap: boolean;
  isInlap: boolean;
}

export interface AccBroadcastCar {
  carIndex: number;
  driverIndex: number;
  driverCount: number;
  gear: number;
  worldPosX: number;
  worldPosY: number;
  yaw: number;
  location: AccBroadcastLocation;
  kmh: number;
  position: number;
  cupPosition: number;
  splinePosition: number;
  laps: number;
  deltaMs: number;
  bestLapTimeMs: number | null;
  lastLapTimeMs: number | null;
  lastLapValid: boolean;
  currentLapTimeMs: number | null;
}

export interface AccBroadcastDriver {
  firstName: string;
  lastName: string;
  shortName: string;
  category: number;
  nationality: number;
}

export interface AccBroadcastEntry {
  carIndex: number;
  carModelType: number;
  teamName: string;
  raceNumber: number;
  cupCategory: number;
  currentDriverIndex: number;
  nationality: number;
  drivers: readonly AccBroadcastDriver[];
}

export type AccBroadcastMessage =
  | { type: "registration-result"; connectionId: number; success: boolean; readOnly: boolean; error: string }
  | { type: "realtime-update"; eventIndex: number; sessionIndex: number; sessionType: number; phase: number; sessionTimeMs: number; sessionEndTimeMs: number; focusedCarIndex: number; activeCameraSet: string; activeCamera: string; currentHudPage: string; replayPlaying: boolean; bestSessionLap: AccBroadcastLap }
  | ({ type: "realtime-car-update" } & AccBroadcastCar)
  | { type: "entry-list"; connectionId: number; carIndexes: readonly number[] }
  | ({ type: "entry-list-car" } & AccBroadcastEntry)
  | { type: "track-data"; connectionId: number; trackName: string; trackId: number; trackMeters: number }
  | { type: "broadcasting-event"; eventType: number; message: string; timeMs: number; carId: number };

export interface AccBroadcastExtension {
  sessionIndex: number;
  sessionType: string;
  phase: number;
  playerCarIndex: number;
  playerCarClassId?: string;
  carIndex: readonly number[];
  driverId: readonly string[];
  driverName: readonly string[];
  carClassId: readonly string[];
  carClassName: readonly string[];
  lapsComplete: readonly number[];
  pitStatus: readonly string[];
  trackLocation: readonly string[];
  positionX: readonly number[];
  positionY: readonly number[];
  positionZ: readonly number[];
  speed: readonly number[];
  yaw: readonly number[];
  lastLapTime: readonly number[];
  lastLapValid: readonly boolean[];
  connected: readonly boolean[];
}

export interface TrackInfo {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  hasOutline: boolean;
  /** Any drawable map, including an official static SVG. */
  hasMap?: boolean;
  /** Public static map for layouts without RaceIQ centerline points. */
  mapUrl?: string | null;
  /** Curated satellite image shared by every layout at this venue. */
  baseImageUrl?: string | null;
  category?: string;
  cornersPerLap?: number | null;
  pitRoadSpeedLimitMph?: number | null;
  numberPitStalls?: number | null;
  maxCars?: number | null;
  nightLighting?: boolean | null;
  rainEnabled?: boolean | null;
  latitude?: number | null;
  longitude?: number | null;
  timeZone?: string | null;
  pitMapUrl?: string | null;
  startFinishMapUrl?: string | null;
  turnsMapUrl?: string | null;
  createdAt: string | null;
  lapCount?: number;
}

export interface Point {
  x: number;
  z: number;
}

export interface TrackSegment {
  type: "corner" | "straight";
  name: string;
  /** Official turn number for this corner (corners only). */
  number?: number;
  /** Extra official turn numbers this one entry accounts for when the detector can't split them. */
  covers?: number[];
  /** Shared by the two halves of a straight the start/finish line splits. */
  group?: string;
  direction?: "left" | "right";
  startFrac: number;
  endFrac: number;
  startIdx: number;
  endIdx: number;
}

export interface TrackSectors {
  segments: TrackSegment[];
  totalDist: number;
}

export interface TrackBoundaries {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine?: Point[];
  pitLane: Point[] | null;
  raceLine?: Point[] | null;
  coordSystem: string;
}

export interface TrackCalibration {
  calibrated: boolean;
  pointsCollected: number;
}

export interface TrackCurb {
  points: Point[];
  side: string;
}

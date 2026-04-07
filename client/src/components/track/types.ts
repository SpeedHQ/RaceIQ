export interface TrackInfo {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  hasOutline: boolean;
  createdAt: string | null;
}

export interface Point {
  x: number;
  z: number;
}

export interface TrackSegment {
  type: "corner" | "straight";
  name: string;
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

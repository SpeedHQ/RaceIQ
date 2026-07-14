export interface TrackInfo {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  hasOutline: boolean;
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
  /** Official turn numbers this section covers (corners only) — a chicane merges several. */
  numbers?: number[];
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

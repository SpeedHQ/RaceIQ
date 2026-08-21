export interface Point {
  x: number;
  z: number;
}

export interface TrackBoundary {
  leftEdge: Point[];
  rightEdge: Point[];
  pitLane: Point[] | null;
}


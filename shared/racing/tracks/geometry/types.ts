export interface Point {
  x: number;
  z: number;
}

export interface TrackBoundary {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine?: Point[];
  pitLane: Point[] | null;
  /** Disconnected supported sections; never join their endpoints to the primary edges. */
  additionalSections?: Pick<TrackBoundary, "leftEdge" | "rightEdge">[];
}

export type TrackSource = "tumftm" | "osm" | "recorded";

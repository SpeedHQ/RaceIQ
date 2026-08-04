import type { TelemetryPacket } from "../../../../../shared/telemetry/types";

export interface Point {
  x: number;
  z: number;
}

export interface TrackMapLabel extends Point {
  text: string;
}

export interface TrackMapHandle {
  updateCursor: (idx: number) => void;
}

export interface SectorBoundaries {
  sectorStarts: number[];
  sectorCount: number;
}

export interface TrackHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

export interface TrackMapBoundaries {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}

export interface TrackMapProps {
  telemetry: TelemetryPacket[];
  cursorIdx: number;
  outline: Point[] | null;
  mapLabels?: TrackMapLabel[] | null;
  boundaries: TrackMapBoundaries | null;
  sectors: SectorBoundaries | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  highlights?: TrackHighlight[] | null;
  showInputs?: boolean;
  showTrace?: boolean;
  rotateWithCar: boolean;
  zoom?: number;
}

export interface TrackTransform {
  w: number;
  h: number;
  offsetX: number;
  offsetZ: number;
  scale: number;
  maxX: number;
  minZ: number;
  displayOutline: Point[];
  offW: number;
  offH: number;
}

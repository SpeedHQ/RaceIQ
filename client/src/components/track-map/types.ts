import { isTelemetryVariableId } from "../../../../shared/telemetry/catalog/query";
import type { TelemetryVariableId } from "../../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { GameId } from "../../../../shared/games/ids";
import type { PitLine } from "@/lib/canvas/draw-track";
import type { TrackImagery, TrackImageryGeographicPoint } from "../../../../shared/racing/tracks/imagery";


export interface SemanticAnalysisFrame {
  values: Readonly<Record<string, unknown>>;
  states: Readonly<Record<string, string | undefined>>;
  freshness: Readonly<Record<string, string | undefined>>;
}

export interface SemanticValueEntry {
  semanticId: string;
  value: unknown;
}

export function semanticValues(entries: readonly SemanticValueEntry[]): SemanticAnalysisFrame["values"] {
  const values: Partial<Record<TelemetryVariableId, unknown>> = {};
  for (const entry of entries) {
    if (isTelemetryVariableId(entry.semanticId)) {
      values[entry.semanticId] = entry.value;
    }
  }
  return values;
}

export const semanticNumber = (frame: SemanticAnalysisFrame | undefined, id: TelemetryVariableId): number | null => {
  const value = frame?.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const semanticBoolean = (frame: SemanticAnalysisFrame | undefined, id: TelemetryVariableId): boolean => semanticNumber(frame, id) === 1;

export interface Point {
  x: number;
  z: number;
}

export interface TrackOverlays {
  inputs: boolean;
  segments: boolean;
  sectors: boolean;
  racingLine: boolean;
}

export type TrackOverlayKey = keyof TrackOverlays;

export const DEFAULT_TRACK_OVERLAYS: TrackOverlays = {
  inputs: false,
  segments: false,
  sectors: false,
  racingLine: false,
};
export const TRACK_MAP_MIN_ZOOM = 0.5;
export const TRACK_MAP_MAX_ZOOM = 64;
export const TRACK_MAP_MAX_RENDER_ZOOM = 4;
export const TRACK_MAP_ZOOM_BUTTON_FACTOR = 1.5;

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
  raceLine?: Point[] | null;
  pitLane?: Point[] | null;
  coordSystem: string;
}

export interface TrackMapLayerState {
  imagery: boolean;
  boundaries: boolean;
  pitLane: boolean;
  outline: boolean;
  racingLine: boolean;
  segments: boolean;
  sectors: boolean;
  curbs: boolean;
  trace: boolean;
  inputs: boolean;
  highlights: boolean;
  car: boolean;
}

export type TrackMapLayerKey = keyof TrackMapLayerState;

export interface TrackMapViewportCamera {
  center: Point;
  rotation?: number;
}

export interface TrackMapOverlayContext {
  context: CanvasRenderingContext2D;
  toCanvas: (x: number, z: number) => [number, number];
  width: number;
  height: number;
  transform: TrackTransform;
  cursorIdx: number;
}

export type TrackMapOverlayRenderer = (overlay: TrackMapOverlayContext) => void;

export interface TrackMapProps {
  gameId?: GameId;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: Point[] | null;
  mapLabels?: TrackMapLabel[] | null;
  pitLines?: PitLine[] | null;
  imagery?: TrackImagery | null;
  geographicPositions?: readonly (TrackImageryGeographicPoint | null)[];
  boundaries: TrackMapBoundaries | null;
  sectors?: SectorBoundaries | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  curbs?: { points: Point[]; side: string }[] | null;
  highlights?: TrackHighlight[] | null;
  layers: TrackMapLayerState;
  rotateWithCar: boolean;
  zoom?: number;
  onZoomChange?: (updater: (zoom: number) => number) => void;
  viewport?: TrackMapViewportCamera | null;
  renderWorldOverlay?: TrackMapOverlayRenderer;
  renderScreenOverlay?: TrackMapOverlayRenderer;
  coordinatesPrepared?: boolean;
  testId?: string;
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

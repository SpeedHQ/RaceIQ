import { isTelemetryVariableId } from "../../../../../shared/telemetry/catalog/query";
import type { TelemetryVariableId } from "../../../../../shared/telemetry/catalog/generated/telemetry-catalog.types";

export interface SemanticAnalysisFrame {
  values: Readonly<Record<string, unknown>>;
  states: Readonly<Record<string, string | undefined>>;
  freshness: Readonly<Record<string, string | undefined>>;
}

export interface SemanticValueEntry {
  semanticId: string;
  value: unknown;
}

export function semanticValues(
  entries: readonly SemanticValueEntry[],
): SemanticAnalysisFrame["values"] {
  const values: Partial<Record<TelemetryVariableId, unknown>> = {};
  for (const entry of entries) {
    if (isTelemetryVariableId(entry.semanticId)) {
      values[entry.semanticId] = entry.value;
    }
  }
  return values;
}

export const semanticNumber = (
  frame: SemanticAnalysisFrame | undefined,
  id: TelemetryVariableId,
): number | null => {
  const value = frame?.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const semanticBoolean = (
  frame: SemanticAnalysisFrame | undefined,
  id: TelemetryVariableId,
): boolean => semanticNumber(frame, id) === 1;

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
  gameId?: import("../../../../../shared/games/ids").GameId;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: Point[] | null;
  mapLabels?: TrackMapLabel[] | null;
  pitRoad?: Point[][] | null;
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

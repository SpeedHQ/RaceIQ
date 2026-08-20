import { useMemo } from "react";
import { resolveTrackImageryMatrix, type TrackImageryMatrix } from "../../../../shared/racing/tracks/imagery";
import { TRACK_MAP_MAX_RENDER_ZOOM, type Point, type TrackMapBoundaries, type TrackMapProps } from "./types";
import { pathForwardOffsets, resolveTrackPositions } from "./path";

export interface TrackMapRenderData {
  visibleBoundaries: TrackMapBoundaries | null;
  resolvedPositions: Point[];
  resolvedDirections: ([number, number] | null)[];
  imageryLocalPositions: readonly Point[];
  imageryMatrix: TrackImageryMatrix | null;
  directVectorRender: boolean;
  showImagery: boolean;
  showBoundaries: boolean;
  showPitLane: boolean;
  showOutline: boolean;
  showRaceLine: boolean;
  showSegments: boolean;
  showSectors: boolean;
  showCurbs: boolean;
  showTrace: boolean;
  showInputs: boolean;
  showHighlights: boolean;
  showCar: boolean;
}

export function useTrackMapRenderData(props: TrackMapProps): TrackMapRenderData {
  const { gameId, telemetry, outline, boundaries, layers, zoom = 1, imagery, geographicPositions, imageryLocalPositions: providedImageryLocalPositions, viewport, coordinatesPrepared } = props;

  const {
    imagery: showImagery,
    boundaries: showBoundaries,
    pitLane: showPitLane,
    outline: showOutline,
    racingLine: showRaceLine,
    segments: showSegments,
    sectors: showSectors,
    curbs: showCurbs,
    trace: showTrace,
    inputs: showInputs,
    highlights: showHighlights,
    car: showCar,
  } = layers;

  const visibleBoundaries = useMemo<TrackMapBoundaries | null>(
    () =>
      boundaries
        ? {
            ...boundaries,
            leftEdge: showBoundaries ? boundaries.leftEdge : [],
            rightEdge: showBoundaries ? boundaries.rightEdge : [],
            centerLine: showBoundaries ? boundaries.centerLine : [],
            raceLine: showRaceLine ? boundaries.raceLine : null,
            pitLane: showPitLane ? boundaries.pitLane : null,
          }
        : null,
    [boundaries, showBoundaries, showPitLane, showRaceLine],
  );

  const resolvedPositions = useMemo(() => resolveTrackPositions(telemetry, outline, coordinatesPrepared ? undefined : gameId), [telemetry, outline, coordinatesPrepared, gameId]);
  const imageryLocalPositions = useMemo(
    () => providedImageryLocalPositions ?? (resolvedPositions.length > 0 ? resolvedPositions : outline ?? []),
    [providedImageryLocalPositions, resolvedPositions, outline],
  );
  const imageryMatrix = useMemo(
    () =>
      showImagery && imagery && geographicPositions && imageryLocalPositions.length > 1
        ? resolveTrackImageryMatrix(imageryLocalPositions, geographicPositions, imagery.calibration)
        : null,
    [geographicPositions, imagery, imageryLocalPositions, showImagery],
  );

  const resolvedDirections = useMemo(() => pathForwardOffsets(resolvedPositions), [resolvedPositions]);
  const directVectorRender = zoom > TRACK_MAP_MAX_RENDER_ZOOM || viewport != null;

  return {
    visibleBoundaries,
    resolvedPositions,
    resolvedDirections,
    imageryLocalPositions,
    imageryMatrix,
    directVectorRender,
    showImagery,
    showBoundaries,
    showPitLane,
    showOutline,
    showRaceLine,
    showSegments,
    showSectors,
    showCurbs,
    showTrace,
    showInputs,
    showHighlights,
    showCar,
  };
}

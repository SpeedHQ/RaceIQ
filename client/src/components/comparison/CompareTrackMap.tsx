import type { GameId } from "@shared/games/ids";
import { flipBoundaries, flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import type { TrackImagery, TrackImageryGeographicPoint } from "@shared/racing/tracks/imagery";
import type { SemanticTelemetrySample } from "@shared/racing/comparison/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TrackMapCanvas } from "@/components/track-map/TrackMapCanvas";
import { TrackMapLayerMenu, type TrackMapLayerMenuItem } from "@/components/track-map/TrackMapLayerMenu";
import {
  TRACK_MAP_MAX_ZOOM,
  TRACK_MAP_MIN_ZOOM,
  TRACK_MAP_ZOOM_BUTTON_FACTOR,
  type SemanticAnalysisFrame,
  type TrackMapLayerState,
  type TrackMapLayerKey,
  type TrackMapOverlayRenderer,
  type TrackMapViewportCamera,
} from "@/components/track-map/types";
import {
  type BoundaryData,
  computeMultiComparisonZoom,
  drawInputsHUD,
  drawMultiComparisonWorldOverlay,
  resolveAlignedCursor,
  resolveComparisonImageryLocalPositions,
  type Point,
} from "@/lib/comparison-utils";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { CompareSegmentTable, type SegmentTiming } from "./CompareSegmentTable";

const numberValue = (sample: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): number | undefined => {
  const value = sample.values[id];
  return typeof value === "number" ? value : undefined;
};
export interface CompareMapSeries {
  telemetry: SemanticTelemetrySample[];
  distanceGrid: number[];
  sourceIndices: number[];
  color: string;
  label: string;
}

interface CompareTrackMapProps {
  outline: Point[];
  series: CompareMapSeries[];
  segments: SegmentTiming[];
  hoveredDistanceRef: React.RefObject<number | null>;
  redrawRef: React.MutableRefObject<(() => void) | null>;
  trackOrdinal?: number | null;
  gameId?: GameId | null;
  imagery?: TrackImagery | null;
  geographicPositions?: readonly (TrackImageryGeographicPoint | null)[] | null;
}

const COMPARE_OVERVIEW_LAYERS: TrackMapLayerState = {
  imagery: true,
  boundaries: true,
  pitLane: true,
  outline: true,
  racingLine: false,
  segments: true,
  sectors: false,
  curbs: false,
  trace: true,
  inputs: false,
  highlights: false,
  car: false,
};

const COMPARE_ZOOM_LAYERS: TrackMapLayerState = {
  ...COMPARE_OVERVIEW_LAYERS,
  outline: false,
  segments: false,
  inputs: true,
};

interface CompareMapZoomControlsProps {
  label: string;
  zoom: number;
  onZoomChange: (updater: (zoom: number) => number) => void;
  onReset: () => void;
}

function CompareMapZoomControls({ label, zoom, onZoomChange, onReset }: CompareMapZoomControlsProps) {
  return (
    <div className="flex items-center gap-1">
      <Button variant="app-outline" size="icon-xs" aria-label={`Zoom out ${label}`} onClick={() => onZoomChange((current) => Math.max(TRACK_MAP_MIN_ZOOM, current / TRACK_MAP_ZOOM_BUTTON_FACTOR))}>
        −
      </Button>
      <Button variant="app-outline" size="xs" aria-label={`Reset ${label} zoom`} onClick={onReset}>
        {zoom.toFixed(1)}×
      </Button>
      <Button variant="app-outline" size="icon-xs" aria-label={`Zoom in ${label}`} onClick={() => onZoomChange((current) => Math.min(TRACK_MAP_MAX_ZOOM, current * TRACK_MAP_ZOOM_BUTTON_FACTOR))}>
        +
      </Button>
    </div>
  );
}

/** Dual-panel track map: overview (left) + zoomed follow (right) */
export function CompareTrackMap({ outline, series, segments, hoveredDistanceRef, redrawRef, trackOrdinal, gameId, imagery, geographicPositions }: CompareTrackMapProps) {
  const segmentTableRef = useRef<HTMLTableSectionElement>(null);
  const prevActiveSegRef = useRef<number>(-1);
  const redrawFrameRef = useRef<number | null>(null);
  const [drawRevision, setDrawRevision] = useState(0);

  const [boundaries, setBoundaries] = useState<BoundaryData | null>(null);
  const [followCar, setFollowCar] = useState(false);
  const [overviewZoom, setOverviewZoom] = useState(1);
  const [zoomMultiplier, setZoomMultiplier] = useState(1);
  const [overviewLayers, setOverviewLayers] = useState<TrackMapLayerState>(() => ({ ...COMPARE_OVERVIEW_LAYERS }));
  const [zoomLayers, setZoomLayers] = useState<TrackMapLayerState>(() => ({ ...COMPARE_ZOOM_LAYERS }));
  const updateOverviewLayer = useCallback((key: TrackMapLayerKey, checked: boolean) => {
    setOverviewLayers((current) => ({ ...current, [key]: checked }));
  }, []);
  const updateZoomLayer = useCallback((key: TrackMapLayerKey, checked: boolean) => {
    setZoomLayers((current) => ({ ...current, [key]: checked }));
  }, []);
  const overviewCanvasLayers = useMemo(() => ({ ...overviewLayers, trace: false, segments: false, inputs: false }), [overviewLayers]);
  const zoomCanvasLayers = useMemo(() => ({ ...zoomLayers, trace: false, segments: false, inputs: false }), [zoomLayers]);

  // Fetch track boundaries
  useEffect(() => {
    if (!trackOrdinal) {
      setBoundaries(null);
      return;
    }
    if (!gameId) return;
    client.api["track-boundaries"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as unknown as BoundaryData)
      .then((data) => setBoundaries(data))
      .catch(() => setBoundaries(null));
  }, [trackOrdinal, gameId]);

  // Compare imagery, cursor positions, and both racing lines are indexed to lap
  // telemetry. Use that same world space for overview bounds; registry geometry
  // can use a different origin or layout and must not move the comparison data.
  const flip = needsTrackFlip(gameId);
  const fallbackOutline = useMemo(() => (flip ? flipPoints(outline) : outline), [outline, flip]);
  const displayBoundaries = useMemo(() => {
    if (!flip || !boundaries) return boundaries;
    return flipBoundaries(boundaries);
  }, [boundaries, flip]);
  const referenceTelemetry = series[0]?.telemetry ?? [];
  const { alignedOutline, alignedBoundaries, trackRange } = useMemo(() => {
    const telemetryPoints: Point[] = [];
    for (const sample of referenceTelemetry) {
      const x = numberValue(sample, "motion.position-x");
      const z = numberValue(sample, "motion.position-z");
      if (x != null && z != null && (x !== 0 || z !== 0)) telemetryPoints.push({ x, z });
    }

    const useTelemetryGeometry = telemetryPoints.length >= 20 && telemetryPoints.length / Math.max(1, referenceTelemetry.length) >= 0.8;
    let mapOutline = fallbackOutline;
    if (useTelemetryGeometry) {
      const stride = Math.max(1, Math.ceil(telemetryPoints.length / 400));
      mapOutline = telemetryPoints.filter((_, index) => index % stride === 0);
      const last = telemetryPoints.at(-1)!;
      if (mapOutline.at(-1) !== last) mapOutline.push(last);
    }

    if (mapOutline.length < 2) return { alignedOutline: mapOutline, alignedBoundaries: null, trackRange: 1 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of mapOutline) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    return {
      alignedOutline: mapOutline,
      alignedBoundaries: useTelemetryGeometry ? null : displayBoundaries,
      trackRange: Math.max(maxX - minX || 1, maxZ - minZ || 1),
    };
  }, [displayBoundaries, fallbackOutline, referenceTelemetry]);
  const layerItems = useMemo<TrackMapLayerMenuItem[]>(
    () => [
      { key: "imagery", label: "Aerial background", available: imagery != null, unavailableReason: "Unavailable" },
      { key: "outline", label: "Track outline", available: alignedOutline.length > 1 },
      { key: "trace", label: "Comparison lines", available: true },
      { key: "segments", label: "Segment markers", available: segments.length > 0, unavailableReason: "Unavailable" },
      { key: "inputs", label: "Input overlay", available: series.length === 2, unavailableReason: m.compare_inputs_two_laps_only() },
      {
        key: "boundaries",
        label: "Boundaries",
        available: (alignedBoundaries?.leftEdge.length ?? 0) > 1 && (alignedBoundaries?.rightEdge.length ?? 0) > 1,
        unavailableReason: "Unavailable",
      },
      { key: "pitLane", label: "Pit lane", available: (alignedBoundaries?.pitLane?.length ?? 0) > 1, unavailableReason: "Unavailable" },
    ],
    [alignedBoundaries, alignedOutline.length, imagery, segments.length, series.length],
  );

  const mapTelemetry = useMemo<SemanticAnalysisFrame[]>(
    () => referenceTelemetry.map((sample) => ({ values: sample.values as SemanticAnalysisFrame["values"], states: {}, freshness: {} })),
    [referenceTelemetry],
  );
  const mapGeographicPositions = geographicPositions ?? undefined;
  const imageryLocalPositions = resolveComparisonImageryLocalPositions(referenceTelemetry, alignedOutline);
  const hoveredDistance = hoveredDistanceRef.current;
  const seriesCursors = series.map((entry) => resolveAlignedCursor(entry.telemetry, [], entry.distanceGrid, entry.sourceIndices, [], hoveredDistance));
  const overlaySeries = series.map((entry, index) => ({
    telemetry: entry.telemetry,
    color: entry.color,
    cursorIndex: seriesCursors[index]?.gridIndex == null ? undefined : entry.sourceIndices[seriesCursors[index]!.gridIndex],
  }));
  const cursorIdx = 0;
  const segmentPoints = useMemo(
    () =>
      segments.length > 0 && referenceTelemetry.length >= 2
        ? segments
            .map((segment) => {
              const index = Math.round(segment.startFrac * (referenceTelemetry.length - 1));
              const sample = referenceTelemetry[index];
              return {
                x: numberValue(sample, "motion.position-x") ?? 0,
                z: numberValue(sample, "motion.position-z") ?? 0,
                type: segment.type,
                label: segment.name,
              };
            })
            .filter((point) => point.x !== 0 || point.z !== 0)
        : undefined,
    [referenceTelemetry, segments],
  );
  const zoomView =
    hoveredDistance == null
      ? null
      : computeMultiComparisonZoom(
          overlaySeries.map((entry) => ({ telemetry: entry.telemetry, sourceIndex: entry.cursorIndex })),
          hoveredDistance,
          trackRange,
          (x) => x,
          alignedOutline,
        );
  const automaticZoom = zoomView ? Math.min(TRACK_MAP_MAX_ZOOM, Math.max(1, trackRange / zoomView.range)) : 1;
  const zoom = Math.min(TRACK_MAP_MAX_ZOOM, Math.max(TRACK_MAP_MIN_ZOOM, automaticZoom * zoomMultiplier));
  const setZoomedZoom = useCallback(
    (updater: (zoom: number) => number) => {
      setZoomMultiplier((current) => {
        const currentZoom = Math.min(TRACK_MAP_MAX_ZOOM, Math.max(TRACK_MAP_MIN_ZOOM, automaticZoom * current));
        const nextZoom = Math.min(TRACK_MAP_MAX_ZOOM, Math.max(TRACK_MAP_MIN_ZOOM, updater(currentZoom)));
        return nextZoom / automaticZoom;
      });
    },
    [automaticZoom],
  );
  const focusSample = seriesCursors[0]?.packetA ?? null;
  const focusYaw = focusSample ? numberValue(focusSample, "motion.yaw") : undefined;
  const zoomViewport: TrackMapViewportCamera | null = zoomView
    ? {
        center: { x: zoomView.centerX, z: zoomView.centerZ },
        ...(followCar && focusYaw !== undefined ? { rotation: Math.PI - focusYaw } : {}),
      }
    : null;

  const renderOverviewOverlay = useCallback<TrackMapOverlayRenderer>(
    ({ context, toCanvas, width, height }) => {
      drawMultiComparisonWorldOverlay({
        context,
        toCanvas,
        width,
        height,
        outline: alignedOutline,
        series: overlaySeries,
        hoveredDistance,
        zoomed: false,
        showRacingLines: overviewLayers.trace,
        segmentPoints: overviewLayers.segments ? segmentPoints : undefined,
      });
    },
    [alignedOutline, hoveredDistance, overlaySeries, overviewLayers.segments, overviewLayers.trace, segmentPoints],
  );
  const renderZoomOverlay = useCallback<TrackMapOverlayRenderer>(
    ({ context, toCanvas, width, height }) => {
      drawMultiComparisonWorldOverlay({
        context,
        toCanvas,
        width,
        height,
        outline: alignedOutline,
        series: overlaySeries,
        hoveredDistance,
        zoomed: true,
        showRacingLines: zoomLayers.trace,
        segmentPoints: zoomLayers.segments ? segmentPoints : undefined,
      });
    },
    [alignedOutline, hoveredDistance, overlaySeries, segmentPoints, zoomLayers.segments, zoomLayers.trace],
  );
  const referenceCursor = seriesCursors[0]?.packetA ?? null;
  const comparedCursor = seriesCursors[1]?.packetA ?? null;
  const renderZoomHud = useCallback<TrackMapOverlayRenderer>(
    ({ context, width, height }) => {
      if (series.length !== 2 || !referenceCursor || !comparedCursor || !zoomLayers.inputs) return;
      drawInputsHUD(context, width, height, referenceCursor, comparedCursor);
    },
    [comparedCursor, referenceCursor, series.length, zoomLayers.inputs],
  );

  useEffect(() => {
    redrawRef.current = () => {
      if (redrawFrameRef.current !== null) return;
      redrawFrameRef.current = requestAnimationFrame(() => {
        redrawFrameRef.current = null;
        setDrawRevision((revision) => revision + 1);
      });
    };
    return () => {
      redrawRef.current = null;
      if (redrawFrameRef.current !== null) cancelAnimationFrame(redrawFrameRef.current);
      redrawFrameRef.current = null;
    };
  }, [redrawRef]);

  useEffect(() => {
    if (!segmentTableRef.current || segments.length === 0) return;
    let activeIndex = -1;
    if (hoveredDistance != null && referenceTelemetry.length >= 2) {
      const firstDistance = numberValue(referenceTelemetry[0], "timing.distance-traveled") ?? 0;
      const lastDistance = numberValue(referenceTelemetry.at(-1)!, "timing.distance-traveled") ?? firstDistance;
      const totalDistance = lastDistance - firstDistance;
      if (totalDistance > 0) {
        const fraction = hoveredDistance / totalDistance;
        activeIndex = segments.findIndex((segment) => fraction >= segment.startFrac && fraction < segment.endFrac);
      }
    }
    if (activeIndex === prevActiveSegRef.current) return;
    const rows = segmentTableRef.current.children;
    if (prevActiveSegRef.current >= 0 && prevActiveSegRef.current < rows.length) {
      (rows[prevActiveSegRef.current] as HTMLElement).classList.remove("bg-app-surface-alt/60");
    }
    if (activeIndex >= 0 && activeIndex < rows.length) {
      (rows[activeIndex] as HTMLElement).classList.add("bg-app-surface-alt/60");
      (rows[activeIndex] as HTMLElement).scrollIntoView({ block: "nearest" });
    }
    prevActiveSegRef.current = activeIndex;
  }, [referenceTelemetry, drawRevision, hoveredDistance, segments]);

  return (
    <div className="flex h-full flex-col overflow-y-auto border border-app-border text-app-body text-app-text">
      <div className="relative min-h-32 basis-56 shrink">
        <span className="absolute top-2 left-2 text-app-caption text-app-text-dim uppercase tracking-wider z-10">{m.compare_overview()}</span>
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <TrackMapLayerMenu layers={overviewLayers} items={layerItems} onLayerChange={updateOverviewLayer} align="right" ariaLabel="Overview map layers" />
          <CompareMapZoomControls label="overview map" zoom={overviewZoom} onZoomChange={setOverviewZoom} onReset={() => setOverviewZoom(1)} />
        </div>
        {alignedOutline.length < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">{m.compare_no_outline()}</div>
        ) : (
          <TrackMapCanvas
            gameId={gameId ?? undefined}
            telemetry={mapTelemetry}
            cursorIdx={cursorIdx}
            outline={alignedOutline}
            imagery={imagery}
            geographicPositions={mapGeographicPositions}
            imageryLocalPositions={imageryLocalPositions}
            boundaries={alignedBoundaries}
            segments={null}
            layers={overviewCanvasLayers}
            rotateWithCar={false}
            zoom={overviewZoom}
            onZoomChange={setOverviewZoom}
            renderWorldOverlay={renderOverviewOverlay}
            testId="compare-overview-track-map"
            coordinatesPrepared
          />
        )}
      </div>
      <div data-testid="compare-map-divider" aria-hidden="true" className="flex h-1.5 w-full shrink-0 items-center justify-center border-y border-app-border bg-app-border-input/70 @3xl/workspace:h-2">
        <span className="h-1 w-12 rounded-full bg-app-border-hover" />
      </div>
      <div className="relative min-h-40 basis-80 shrink border-b border-app-border">
        <span className="absolute top-2 left-2 text-app-caption text-app-text-dim uppercase tracking-wider z-10">{m.compare_zoomed()}</span>
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <Button onClick={() => setFollowCar((current) => !current)} variant={followCar ? "selected-toggle" : "app-outline"} size="app-sm">
            {followCar ? m.compare_follow_view() : m.compare_fixed_view()}
          </Button>
          <TrackMapLayerMenu layers={zoomLayers} items={layerItems} onLayerChange={updateZoomLayer} align="right" ariaLabel="Zoomed map layers" />
          <CompareMapZoomControls label="zoomed map" zoom={zoom} onZoomChange={setZoomedZoom} onReset={() => setZoomMultiplier(1)} />
        </div>
        {alignedOutline.length < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">{m.compare_no_outline()}</div>
        ) : (
          <TrackMapCanvas
            gameId={gameId ?? undefined}
            telemetry={mapTelemetry}
            cursorIdx={cursorIdx}
            outline={alignedOutline}
            imagery={imagery}
            geographicPositions={mapGeographicPositions}
            imageryLocalPositions={imageryLocalPositions}
            boundaries={alignedBoundaries}
            segments={null}
            layers={zoomCanvasLayers}
            rotateWithCar={false}
            zoom={zoom}
            onZoomChange={setZoomedZoom}
            viewport={zoomViewport}
            renderWorldOverlay={renderZoomOverlay}
            renderScreenOverlay={renderZoomHud}
            testId="compare-zoom-track-map"
            coordinatesPrepared
          />
        )}
      </div>
      <CompareSegmentTable segments={segments} laps={series} tableRef={segmentTableRef} />
    </div>
  );
}

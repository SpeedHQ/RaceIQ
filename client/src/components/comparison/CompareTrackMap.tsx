import type { GameId } from "@shared/games/ids";
import { flipBoundaries, flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import type { TrackImagery, TrackImageryGeographicPoint } from "@shared/racing/tracks/imagery";
import type { SemanticTelemetrySample } from "@shared/racing/comparison/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TrackMapCanvas } from "@/components/track-map/TrackMapCanvas";
import type { SemanticAnalysisFrame, TrackMapLayerState, TrackMapOverlayRenderer, TrackMapViewportCamera } from "@/components/track-map/types";
import { type BoundaryData, computeZoom, drawComparisonWorldOverlay, drawInputsHUD, resolveAlignedCursor, type Point } from "@/lib/comparison-utils";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { CompareSegmentTable } from "./CompareSegmentTable";

const numberValue = (sample: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): number | undefined => {
  const value = sample.values[id];
  return typeof value === "number" ? value : undefined;
};
export interface SegmentTiming {
  name: string;
  type: "corner" | "straight";
  timeA: number;
  timeB: number;
  startFrac: number;
  endFrac: number;
}

interface CompareTrackMapProps {
  outline: Point[];
  telemetryA: SemanticTelemetrySample[];
  telemetryB: SemanticTelemetrySample[];
  distanceGrid: number[];
  sourceIndicesA: number[];
  sourceIndicesB: number[];
  labelA: string;
  labelB: string;
  lapTimeA: string;
  lapTimeB: string;
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
  segments: false,
  sectors: false,
  curbs: false,
  trace: false,
  inputs: false,
  highlights: false,
  car: false,
};

const COMPARE_ZOOM_LAYERS: TrackMapLayerState = {
  ...COMPARE_OVERVIEW_LAYERS,
  outline: false,
};

/** Dual-panel track map: overview (left) + zoomed follow (right) */
export function CompareTrackMap({
  outline,
  telemetryA,
  telemetryB,
  distanceGrid,
  sourceIndicesA,
  sourceIndicesB,
  segments,
  hoveredDistanceRef,
  redrawRef,
  trackOrdinal,
  gameId,
  imagery,
  geographicPositions,
}: CompareTrackMapProps) {
  const segmentTableRef = useRef<HTMLTableSectionElement>(null);
  const prevActiveSegRef = useRef<number>(-1);
  const redrawFrameRef = useRef<number | null>(null);
  const [drawRevision, setDrawRevision] = useState(0);

  const [boundaries, setBoundaries] = useState<BoundaryData | null>(null);
  const [followCar, setFollowCar] = useState(false);

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

  // Align outline to telemetry coordinate space.
  // Extracted outlines (e.g. F1 2025 from AI spline data) may be in a different
  // coordinate system than telemetry PositionX/Z. Detect misalignment by checking
  // bounding box overlap, and if needed apply Procrustes (translate + rotate + scale).
  // Pre-flip outline/boundary X so they render correctly against telemetry.
  const flip = needsTrackFlip(gameId);
  const displayOutline = useMemo(() => (flip ? flipPoints(outline) : outline), [outline, flip]);
  const displayBoundaries = useMemo(() => {
    if (!flip || !boundaries) return boundaries;
    return flipBoundaries(boundaries);
  }, [boundaries, flip]);

  const { alignedOutline, alignedBoundaries, transformPoint, trackRange } = useMemo(() => {
    const outline = displayOutline;
    const boundaries = displayBoundaries;
    const identity = (point: Point): Point => point;

    const computeRange = (pts: Point[]) => {
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      return Math.max(maxX - minX || 1, maxZ - minZ || 1);
    };

    // Extract telemetry positions from lap A
    const telPts: Point[] = [];
    for (const p of telemetryA) {
      if ((numberValue(p, "motion.position-x") ?? 0) !== 0 || (numberValue(p, "motion.position-z") ?? 0) !== 0)
        telPts.push({ x: numberValue(p, "motion.position-x") ?? 0, z: numberValue(p, "motion.position-z") ?? 0 });
    }
    if (telPts.length < 20 || outline.length < 10) {
      return { alignedOutline: outline, alignedBoundaries: boundaries, transformPoint: identity, trackRange: computeRange(outline) };
    }

    // Check bounding box overlap between outline and telemetry
    let oMinX = Infinity,
      oMaxX = -Infinity,
      oMinZ = Infinity,
      oMaxZ = -Infinity;
    for (const p of outline) {
      oMinX = Math.min(oMinX, p.x);
      oMaxX = Math.max(oMaxX, p.x);
      oMinZ = Math.min(oMinZ, p.z);
      oMaxZ = Math.max(oMaxZ, p.z);
    }
    let tMinX = Infinity,
      tMaxX = -Infinity,
      tMinZ = Infinity,
      tMaxZ = -Infinity;
    for (const p of telPts) {
      tMinX = Math.min(tMinX, p.x);
      tMaxX = Math.max(tMaxX, p.x);
      tMinZ = Math.min(tMinZ, p.z);
      tMaxZ = Math.max(tMaxZ, p.z);
    }

    const oRangeX = oMaxX - oMinX,
      oRangeZ = oMaxZ - oMinZ;
    const tRangeX = tMaxX - tMinX,
      tRangeZ = tMaxZ - tMinZ;
    const oCx = (oMinX + oMaxX) / 2;
    const tCx = (tMinX + tMaxX) / 2;

    // Check if bounding boxes overlap (with some tolerance)
    const overlapX = Math.max(0, Math.min(oMaxX, tMaxX) - Math.max(oMinX, tMinX));
    const overlapZ = Math.max(0, Math.min(oMaxZ, tMaxZ) - Math.max(oMinZ, tMinZ));
    const overlapRatioX = overlapX / Math.max(oRangeX, tRangeX, 1);
    const overlapRatioZ = overlapZ / Math.max(oRangeZ, tRangeZ, 1);
    const overlaps = overlapRatioX > 0.3 && overlapRatioZ > 0.3;

    // Also check if just X-flip fixes it (old F1 laps)
    if (overlaps) {
      if (oCx !== 0 && Math.sign(tCx) !== Math.sign(oCx) && Math.abs(tCx) > 50) {
        const flipX = (point: Point): Point => ({ x: -point.x, z: point.z });
        return { alignedOutline: outline, alignedBoundaries: boundaries, transformPoint: flipX, trackRange: computeRange(outline) };
      }
      return { alignedOutline: outline, alignedBoundaries: boundaries, transformPoint: identity, trackRange: computeRange(outline) };
    }

    // No overlap — need full Procrustes alignment.
    // Downsample both to ~100 points for matching.
    const ds = (pts: Point[], n: number): Point[] => {
      if (pts.length <= n) return pts;
      const step = pts.length / n;
      const out: Point[] = [];
      for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * step)]);
      return out;
    };
    const N = 100;
    const src = ds(outline, N); // outline points (source)
    const tgt = ds(telPts, N); // telemetry points (target)

    const centroid = (pts: Point[]) => {
      let sx = 0,
        sz = 0;
      for (const p of pts) {
        sx += p.x;
        sz += p.z;
      }
      return { x: sx / pts.length, z: sz / pts.length };
    };

    // ICP: iteratively find closest points and compute rigid+scale transform
    let scale = 1,
      rotation = 0,
      tx = 0,
      tz = 0;
    let transformed = src.map((p) => ({ ...p }));

    for (let iter = 0; iter < 30; iter++) {
      // Find closest target point for each transformed source point
      const pairs: { s: Point; t: Point }[] = [];
      for (const sp of transformed) {
        let bestD = Infinity,
          bestT = tgt[0];
        for (const tp of tgt) {
          const d = (sp.x - tp.x) ** 2 + (sp.z - tp.z) ** 2;
          if (d < bestD) {
            bestD = d;
            bestT = tp;
          }
        }
        pairs.push({ s: sp, t: bestT });
      }

      // Procrustes on original source → paired targets
      const srcPaired = pairs.map((_, i) => src[i]);
      const tgtPaired = pairs.map((p) => p.t);
      const cSrc = centroid(srcPaired);
      const cTgt = centroid(tgtPaired);
      const srcC = srcPaired.map((p) => ({ x: p.x - cSrc.x, z: p.z - cSrc.z }));
      const tgtC = tgtPaired.map((p) => ({ x: p.x - cTgt.x, z: p.z - cTgt.z }));

      let num = 0,
        den = 0,
        srcSq = 0;
      for (let i = 0; i < srcC.length; i++) {
        num += srcC[i].x * tgtC[i].z - srcC[i].z * tgtC[i].x;
        den += srcC[i].x * tgtC[i].x + srcC[i].z * tgtC[i].z;
        srcSq += srcC[i].x ** 2 + srcC[i].z ** 2;
      }
      const newRot = Math.atan2(num, den);
      const cosR = Math.cos(newRot),
        sinR = Math.sin(newRot);
      let tgtSq = 0;
      for (const p of tgtC) tgtSq += p.x ** 2 + p.z ** 2;
      const newScale = srcSq > 0 ? Math.sqrt(tgtSq / srcSq) : 1;
      const newTx = cTgt.x - newScale * (cosR * cSrc.x - sinR * cSrc.z);
      const newTz = cTgt.z - newScale * (sinR * cSrc.x + cosR * cSrc.z);

      const dScale = Math.abs(newScale - scale);
      const dRot = Math.abs(newRot - rotation);
      scale = newScale;
      rotation = newRot;
      tx = newTx;
      tz = newTz;

      // Apply transform
      const cosA = Math.cos(rotation),
        sinA = Math.sin(rotation);
      transformed = src.map((p) => ({
        x: scale * (cosA * p.x - sinA * p.z) + tx,
        z: scale * (sinA * p.x + cosA * p.z) + tz,
      }));

      if (dScale < 0.0001 && dRot < 0.0001) break;
    }

    // Apply final transform to full outline and all telemetry coordinates.
    const cosA = Math.cos(rotation),
      sinA = Math.sin(rotation);
    const applyTransform = (p: Point): Point => ({
      x: scale * (cosA * p.x - sinA * p.z) + tx,
      z: scale * (sinA * p.x + cosA * p.z) + tz,
    });

    const newOutline = outline.map(applyTransform);

    // Also transform boundaries if available
    let newBoundaries = boundaries;
    if (boundaries?.leftEdge && boundaries?.rightEdge && boundaries?.centerLine) {
      newBoundaries = {
        ...boundaries,
        leftEdge: boundaries.leftEdge.map(applyTransform),
        rightEdge: boundaries.rightEdge.map(applyTransform),
        centerLine: boundaries.centerLine.map(applyTransform),
        pitLane: boundaries.pitLane?.map(applyTransform) ?? null,
      };
    }

    return { alignedOutline: newOutline, alignedBoundaries: newBoundaries, transformPoint: applyTransform, trackRange: computeRange(newOutline) };
  }, [displayOutline, telemetryA, displayBoundaries]);

  const transformTelemetry = useCallback(
    (sample: SemanticTelemetrySample) => {
      const x = numberValue(sample, "motion.position-x");
      const z = numberValue(sample, "motion.position-z");
      if (x == null || z == null || (x === 0 && z === 0)) return sample;
      const point = transformPoint({ x, z });
      return point.x === x && point.z === z ? sample : { ...sample, values: { ...sample.values, "motion.position-x": point.x, "motion.position-z": point.z } };
    },
    [transformPoint],
  );

  const displayTelemetryA = useMemo(() => telemetryA.map(transformTelemetry), [telemetryA, transformTelemetry]);
  const displayTelemetryB = useMemo(() => telemetryB.map(transformTelemetry), [telemetryB, transformTelemetry]);
  const mapTelemetryA = useMemo<SemanticAnalysisFrame[]>(
    () => displayTelemetryA.map((sample) => ({ values: sample.values as SemanticAnalysisFrame["values"], states: {}, freshness: {} })),
    [displayTelemetryA],
  );
  const mapGeographicPositions = geographicPositions ?? undefined;
  const hoveredDistance = hoveredDistanceRef.current;
  const alignedCursor = resolveAlignedCursor(displayTelemetryA, displayTelemetryB, distanceGrid, sourceIndicesA, sourceIndicesB, hoveredDistance);
  const cursorIndexA = alignedCursor ? sourceIndicesA[alignedCursor.gridIndex] : undefined;
  const cursorIndexB = alignedCursor ? sourceIndicesB[alignedCursor.gridIndex] : undefined;
  const cursorIdx = 0;
  const segmentPoints = useMemo(
    () =>
      segments.length > 0 && displayTelemetryA.length >= 2
        ? segments
            .map((segment) => {
              const index = Math.round(segment.startFrac * (displayTelemetryA.length - 1));
              const sample = displayTelemetryA[index];
              return {
                x: numberValue(sample, "motion.position-x") ?? 0,
                z: numberValue(sample, "motion.position-z") ?? 0,
                type: segment.type,
                label: segment.name,
              };
            })
            .filter((point) => point.x !== 0 || point.z !== 0)
        : undefined,
    [displayTelemetryA, segments],
  );
  const zoomView = hoveredDistance == null ? null : computeZoom(displayTelemetryA, displayTelemetryB, hoveredDistance, trackRange, (x) => x, alignedOutline, cursorIndexA, cursorIndexB);
  const zoom = zoomView ? Math.min(64, Math.max(1, trackRange / zoomView.range)) : 1;
  const focusSample = alignedCursor?.packetA ?? null;
  const focusYaw = focusSample ? numberValue(focusSample, "motion.yaw") : undefined;
  const zoomViewport: TrackMapViewportCamera | null = zoomView
    ? {
        center: { x: zoomView.centerX, z: zoomView.centerZ },
        ...(followCar && focusYaw !== undefined ? { rotation: Math.PI - focusYaw } : {}),
      }
    : null;

  const renderOverviewOverlay = useCallback<TrackMapOverlayRenderer>(
    ({ context, toCanvas, width, height }) => {
      drawComparisonWorldOverlay({
        context,
        toCanvas,
        width,
        height,
        outline: alignedOutline,
        telemetryA: displayTelemetryA,
        telemetryB: displayTelemetryB,
        hoveredDistance,
        zoomed: false,
        segmentPoints,
        cursorIndexA,
        cursorIndexB,
      });
    },
    [alignedOutline, cursorIndexA, cursorIndexB, displayTelemetryA, displayTelemetryB, hoveredDistance, segmentPoints],
  );
  const renderZoomOverlay = useCallback<TrackMapOverlayRenderer>(
    ({ context, toCanvas, width, height }) => {
      drawComparisonWorldOverlay({
        context,
        toCanvas,
        width,
        height,
        outline: alignedOutline,
        telemetryA: displayTelemetryA,
        telemetryB: displayTelemetryB,
        hoveredDistance,
        zoomed: true,
        cursorIndexA,
        cursorIndexB,
      });
    },
    [alignedOutline, cursorIndexA, cursorIndexB, displayTelemetryA, displayTelemetryB, hoveredDistance],
  );
  const renderZoomHud = useCallback<TrackMapOverlayRenderer>(
    ({ context, width, height }) => {
      if (!alignedCursor) return;
      drawInputsHUD(context, width, height, alignedCursor.packetA, alignedCursor.packetB);
    },
    [alignedCursor],
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
    if (hoveredDistance != null && displayTelemetryA.length >= 2) {
      const firstDistance = numberValue(displayTelemetryA[0], "timing.distance-traveled") ?? 0;
      const lastDistance = numberValue(displayTelemetryA.at(-1)!, "timing.distance-traveled") ?? firstDistance;
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
  }, [displayTelemetryA, drawRevision, hoveredDistance, segments]);

  return (
    <div className="flex h-full flex-col overflow-y-auto border border-app-border text-app-body text-app-text">
      <div className="relative min-h-32 basis-56 shrink border-b border-app-border">
        <span className="absolute top-2 left-2 text-app-caption text-app-text-dim uppercase tracking-wider z-10">{m.compare_overview()}</span>
        {alignedOutline.length < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">{m.compare_no_outline()}</div>
        ) : (
          <TrackMapCanvas
            gameId={gameId ?? undefined}
            telemetry={mapTelemetryA}
            cursorIdx={cursorIdx}
            outline={alignedOutline}
            imagery={imagery}
            geographicPositions={mapGeographicPositions}
            boundaries={alignedBoundaries}
            segments={null}
            layers={COMPARE_OVERVIEW_LAYERS}
            rotateWithCar={false}
            zoom={1}
            renderWorldOverlay={renderOverviewOverlay}
            testId="compare-overview-track-map"
            coordinatesPrepared
          />
        )}
      </div>
      <div className="relative min-h-40 basis-80 shrink border-b border-app-border">
        <span className="absolute top-2 left-2 text-app-caption text-app-text-dim uppercase tracking-wider z-10">{m.compare_zoomed()}</span>
        <Button onClick={() => setFollowCar((current) => !current)} variant={followCar ? "selected-toggle" : "app-outline"} size="app-sm" className="absolute top-2 right-2 z-10">
          {followCar ? m.compare_follow_view() : m.compare_fixed_view()}
        </Button>
        {alignedOutline.length < 2 ? (
          <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">{m.compare_no_outline()}</div>
        ) : (
          <TrackMapCanvas
            gameId={gameId ?? undefined}
            telemetry={mapTelemetryA}
            cursorIdx={cursorIdx}
            outline={alignedOutline}
            imagery={imagery}
            geographicPositions={mapGeographicPositions}
            boundaries={alignedBoundaries}
            segments={null}
            layers={COMPARE_ZOOM_LAYERS}
            rotateWithCar={false}
            zoom={zoom}
            viewport={zoomViewport}
            renderWorldOverlay={renderZoomOverlay}
            renderScreenOverlay={renderZoomHud}
            testId="compare-zoom-track-map"
            coordinatesPrepared
          />
        )}
      </div>
      <CompareSegmentTable segments={segments} tableRef={segmentTableRef} />
    </div>
  );
}

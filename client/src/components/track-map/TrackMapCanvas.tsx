import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { applyTrackMapOverlayCamera, compositeFixedTrack, compositeTrack, drawCarOverlay, drawCarPulse, type CarOverlayPosition } from "./overlay-drawing";
import { drawStaticTrack } from "./static-drawing";
import { semanticNumber, type Point, type TrackMapHandle, type TrackMapProps, type TrackMapViewportCamera, type TrackTransform } from "./types";
import { useTrackMapImagery } from "./useTrackMapImagery";
import { useTrackMapRenderData } from "./useTrackMapRenderData";
import { useTrackMapViewport } from "./useTrackMapViewport";

function trackPointAtScreenPosition(
  screenX: number,
  screenY: number,
  transform: TrackTransform,
  pan: Readonly<{ x: number; y: number }>,
  viewport: TrackMapViewportCamera | null | undefined,
  directVectorRender: boolean,
): Point {
  let canvasX: number;
  let canvasY: number;
  if (viewport) {
    const rotation = viewport.rotation ?? 0;
    const dx = screenX - (transform.w / 2 + pan.x);
    const dy = screenY - (transform.h / 2 + pan.y);
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    canvasX = transform.w / 2 + cosine * dx + sine * dy;
    canvasY = transform.h / 2 - sine * dx + cosine * dy;
  } else {
    canvasX = screenX - pan.x - (directVectorRender ? 0 : (transform.w - transform.offW) / 2);
    canvasY = screenY - pan.y - (directVectorRender ? 0 : (transform.h - transform.offH) / 2);
  }
  return {
    x: transform.maxX - (canvasX - transform.offsetX) / transform.scale,
    z: transform.minZ + (canvasY - transform.offsetZ) / transform.scale,
  };
}

export const TrackMapCanvas = forwardRef<TrackMapHandle, TrackMapProps>(function TrackMapCanvas(props, ref) {
  const {
    gameId,
    telemetry,
    cursorIdx,
    outline,
    mapLabels,
    pitLines,
    imagery,
    sectors,
    segments,
    curbs,
    highlights,
    rotateWithCar,
    zoom = 1,
    onZoomChange,
    viewport,
    renderWorldOverlay,
    renderScreenOverlay,
    onTrackHover,
    coordinatesPrepared,
    testId = "analyse-track-map-viewport",
  } = props;
  const {
    visibleBoundaries,
    resolvedPositions,
    resolvedDirections,
    imageryMatrix,
    directVectorRender,
    showImagery,
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
  } = useTrackMapRenderData(props);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const customOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const carCanvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLCanvasElement>(null);
  const carPosRef = useRef<CarOverlayPosition | null>(null);
  const transformRef = useRef<TrackTransform | null>(null);
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef(cursorIdx);
  const redrawAfterPanRef = useRef<() => void>(() => undefined);
  const handlePan = useCallback(() => redrawAfterPanRef.current(), []);
  const { viewportRef, panRef, pointerHandlers } = useTrackMapViewport({ rotateWithCar, zoom, onZoomChange, onPan: handlePan });

  const renderedImagery = useTrackMapImagery({
    gameId,
    imagery,
    imageryMatrix,
    enabled: showImagery,
    canvasRef,
    cursorRef,
    panRef,
    resolvedPositions,
    resolvedDirections,
    rotateWithCar,
    directVectorRender,
  });

  const requestVisibleTiles = useCallback(
    (transform: TrackTransform) => {
      renderedImagery?.requestVisibleTiles?.(transform);
    },
    [renderedImagery],
  );

  const drawStatic = useCallback(
    (idx = cursorRef.current) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const frame = telemetry[idx];
      const position = resolvedPositions[idx];
      const path = resolvedDirections[idx];
      const rotation = path ? -Math.PI / 2 - Math.atan2(path[1], -path[0]) : Math.PI - (semanticNumber(frame, "motion.yaw") ?? 0);
      const cameraCenter = viewport?.center ?? (rotateWithCar && showCar ? position : null);
      const cameraRotation = viewport ? viewport.rotation : rotation;
      const result = drawStaticTrack({
        canvas,
        bufferCanvas: directVectorRender ? canvas : bufferCanvasRef.current,
        telemetry,
        gameId,
        coordinatesPrepared,
        resolvedPositions,
        outline,
        showOutline,
        pitLines: showPitLane ? pitLines : null,
        mapLabels: showSegments ? mapLabels : null,
        imagery: renderedImagery,
        boundaries: visibleBoundaries,
        sectors: showSectors ? (sectors ?? null) : null,
        segments: showSegments ? segments : null,
        curbs: showCurbs ? curbs : null,
        highlights: showHighlights ? highlights : null,
        showInputs,
        showRaceLine,
        showTrace,
        rotateWithCar,
        zoom,
        viewportCamera: directVectorRender
          ? {
              panX: panRef.current.x,
              panY: panRef.current.y,
              ...(cameraCenter ? { center: cameraCenter, rotation: cameraRotation, drawFollowCar: !viewport && rotateWithCar && showCar } : {}),
            }
          : undefined,
      });
      transformRef.current = result.transform;
      if (!directVectorRender) bufferCanvasRef.current = result.bufferCanvas;
      if (rotateWithCar && carCanvasRef.current) {
        const context = getSemanticCanvasContext(carCanvasRef.current);
        context?.clearRect(0, 0, carCanvasRef.current.width, carCanvasRef.current.height);
      }
      if (showCar && directVectorRender && rotateWithCar && result.transform && position) {
        carPosRef.current = {
          x: result.transform.w / 2 + panRef.current.x,
          y: result.transform.h / 2 + panRef.current.y,
          w: result.transform.w,
          h: result.transform.h,
          angle: -Math.PI / 2,
        };
      }
    },
    [
      gameId,
      telemetry,
      resolvedPositions,
      resolvedDirections,
      outline,
      pitLines,
      mapLabels,
      renderedImagery,
      visibleBoundaries,
      sectors,
      segments,
      curbs,
      highlights,
      showCar,
      showCurbs,
      showHighlights,
      showOutline,
      showPitLane,
      showSectors,
      showSegments,
      showInputs,
      showRaceLine,
      showTrace,
      rotateWithCar,
      zoom,
      directVectorRender,
      panRef,
      viewport,
      coordinatesPrepared,
    ],
  );

  const drawCustomOverlays = useCallback(
    (idx = cursorRef.current) => {
      const canvas = customOverlayCanvasRef.current;
      const transform = transformRef.current;
      if (!canvas || !transform) return;
      const { w, h, offsetX, offsetZ, maxX, minZ, scale } = transform;
      syncCanvasSize(canvas, w, h, window.devicePixelRatio || 1, false);
      const context = getSemanticCanvasContext(canvas);
      if (!context) return;
      context.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
      context.clearRect(0, 0, w, h);
      const toCanvas = (x: number, z: number): [number, number] => [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
      context.save();
      applyTrackMapOverlayCamera(context, transform, panRef.current, viewport, directVectorRender);
      renderWorldOverlay?.({ context, toCanvas, width: w, height: h, transform, cursorIdx: idx });
      context.restore();
      renderScreenOverlay?.({ context, toCanvas, width: w, height: h, transform, cursorIdx: idx });
    },
    [directVectorRender, panRef, renderScreenOverlay, renderWorldOverlay, viewport],
  );

  const renderOverlayOptions = useCallback(
    () => ({
      canvas: canvasRef.current!,
      carCanvas: carCanvasRef.current!,
      bufferCanvas: bufferCanvasRef.current,
      telemetry,
      resolvedPositions,
      resolvedDirections,
      transform: transformRef.current,
      panX: panRef.current.x,
      panY: panRef.current.y,
      showCar,
    }),
    [panRef, telemetry, resolvedPositions, resolvedDirections, showCar],
  );

  const composite = useCallback(
    (idx: number) => {
      compositeTrack(renderOverlayOptions(), idx);
      if (transformRef.current) requestVisibleTiles(transformRef.current);
      const frame = telemetry[idx];
      const position = resolvedPositions[idx];
      if (showCar && frame && position && transformRef.current) {
        carPosRef.current = {
          x: transformRef.current.w / 2 + panRef.current.x,
          y: transformRef.current.h / 2 + panRef.current.y,
          w: transformRef.current.w,
          h: transformRef.current.h,
          angle: -Math.PI / 2,
        };
      }
    },
    [panRef, renderOverlayOptions, requestVisibleTiles, telemetry, resolvedPositions, showCar],
  );

  const drawCar = useCallback(
    (idx: number) => {
      if (!carCanvasRef.current) return;
      const position = drawCarOverlay(renderOverlayOptions(), idx);
      if (position) carPosRef.current = position;
    },
    [renderOverlayOptions],
  );

  const drawFixed = useCallback(
    (idx: number) => {
      compositeFixedTrack(renderOverlayOptions());
      drawCar(idx);
    },
    [drawCar, renderOverlayOptions],
  );

  const redrawAfterPan = useCallback(() => {
    if (directVectorRender) {
      drawStatic(cursorRef.current);
      if (!rotateWithCar) drawCar(cursorRef.current);
      drawCustomOverlays(cursorRef.current);
      return;
    }
    if (transformRef.current) requestVisibleTiles(transformRef.current);
    if (rotateWithCar) composite(cursorRef.current);
    else drawFixed(cursorRef.current);
    drawCustomOverlays(cursorRef.current);
  }, [composite, directVectorRender, drawCar, drawCustomOverlays, drawFixed, drawStatic, requestVisibleTiles, rotateWithCar]);

  useLayoutEffect(() => {
    redrawAfterPanRef.current = redrawAfterPan;
  }, [redrawAfterPan]);

  const updateCursor = useCallback(
    (idx: number) => {
      if (directVectorRender && rotateWithCar) drawStatic(idx);
      else if (rotateWithCar) composite(idx);
      else drawCar(idx);
      drawCustomOverlays(idx);
    },
    [directVectorRender, rotateWithCar, drawStatic, composite, drawCar, drawCustomOverlays],
  );
  useImperativeHandle(ref, () => ({ updateCursor }), [updateCursor]);

  useLayoutEffect(drawStatic, [drawStatic]);
  useLayoutEffect(() => {
    if (directVectorRender) {
      if (!rotateWithCar) drawCar(cursorIdx);
    } else if (rotateWithCar) composite(cursorIdx);
    else drawFixed(cursorIdx);
  }, [drawStatic, composite, drawFixed, drawCar, directVectorRender, rotateWithCar]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => drawCustomOverlays(cursorIdx), [cursorIdx, drawCustomOverlays]);

  useEffect(() => {
    cursorRef.current = cursorIdx;
  }, [cursorIdx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      drawStatic(cursorRef.current);
      if (directVectorRender) {
        if (!rotateWithCar) drawCar(cursorRef.current);
      } else if (rotateWithCar) composite(cursorRef.current);
      else drawFixed(cursorRef.current);
      drawCustomOverlays(cursorRef.current);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawStatic, composite, drawFixed, drawCar, drawCustomOverlays, directVectorRender, rotateWithCar]);

  useLayoutEffect(() => {
    if (!rotateWithCar) drawCar(cursorIdx);
  }, [cursorIdx, drawCar, rotateWithCar]);

  useEffect(() => {
    if (!showCar) return;
    const pulse = pulseRef.current;
    if (!pulse) return;
    let animationId: number;
    const draw = () => {
      const position = carPosRef.current;
      if (!position) {
        animationId = requestAnimationFrame(draw);
        return;
      }
      syncCanvasSize(pulse, position.w, position.h, window.devicePixelRatio || 1, false);
      const context = getSemanticCanvasContext(pulse);
      if (!context) {
        animationId = requestAnimationFrame(draw);
        return;
      }
      context.setTransform(pulse.width / position.w, 0, 0, pulse.height / position.h, 0, 0);
      context.clearRect(0, 0, position.w, position.h);
      drawCarPulse(context, position, Date.now());
      animationId = requestAnimationFrame(draw);
    };
    animationId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationId);
  }, [showCar]);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointerHandlers.onPointerMove(event);
      if (!onTrackHover) return;
      const transform = transformRef.current;
      if (!transform) {
        onTrackHover(null);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      onTrackHover(trackPointAtScreenPosition(event.clientX - rect.left, event.clientY - rect.top, transform, panRef.current, viewport, directVectorRender));
    },
    [directVectorRender, onTrackHover, panRef, pointerHandlers, viewport],
  );
  const handlePointerLeave = useCallback(() => onTrackHover?.(null), [onTrackHover]);

  return (
    <div
      ref={viewportRef}
      data-testid={testId}
      className="relative w-full h-full cursor-grab touch-none overscroll-contain active:cursor-grabbing"
      style={{ minHeight: 220 }}
      onPointerDown={pointerHandlers.onPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={pointerHandlers.onPointerUp}
      onPointerCancel={pointerHandlers.onPointerCancel}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={customOverlayCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={carCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={pulseRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
});

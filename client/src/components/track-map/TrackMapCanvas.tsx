import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { compositeFixedTrack, compositeTrack, drawCarOverlay, drawCarPulse, type CarOverlayPosition } from "./overlay-drawing";
import { drawStaticTrack } from "./static-drawing";
import { semanticNumber, type TrackMapHandle, type TrackMapProps, type TrackTransform } from "./types";
import { useTrackMapImagery } from "./useTrackMapImagery";
import { useTrackMapRenderData } from "./useTrackMapRenderData";
import { useTrackMapViewport } from "./useTrackMapViewport";

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
      const result = drawStaticTrack({
        canvas,
        bufferCanvas: directVectorRender ? canvas : bufferCanvasRef.current,
        telemetry,
        gameId,
        resolvedPositions,
        outline,
        showOutline,
        pitLines: showPitLane ? pitLines : null,
        mapLabels: showSegments ? mapLabels : null,
        imagery: renderedImagery,
        boundaries: visibleBoundaries,
        sectors: showSectors ? sectors ?? null : null,
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
              ...(rotateWithCar && showCar && position ? { center: position, rotation, drawFollowCar: true } : {}),
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
    ],
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
      return;
    }
    if (transformRef.current) requestVisibleTiles(transformRef.current);
    if (rotateWithCar) composite(cursorRef.current);
    else drawFixed(cursorRef.current);
  }, [composite, directVectorRender, drawCar, drawFixed, drawStatic, requestVisibleTiles, rotateWithCar]);

  useLayoutEffect(() => {
    redrawAfterPanRef.current = redrawAfterPan;
  }, [redrawAfterPan]);

  const updateCursor = useCallback(
    (idx: number) => {
      if (directVectorRender && rotateWithCar) drawStatic(idx);
      else if (rotateWithCar) composite(idx);
      else drawCar(idx);
    },
    [directVectorRender, rotateWithCar, drawStatic, composite, drawCar],
  );
  useImperativeHandle(ref, () => ({ updateCursor }), [updateCursor]);

  useLayoutEffect(drawStatic, [drawStatic]);
  useLayoutEffect(() => {
    if (directVectorRender) {
      if (!rotateWithCar) drawCar(cursorIdx);
    } else if (rotateWithCar) composite(cursorIdx);
    else drawFixed(cursorIdx);
  }, [drawStatic, composite, drawFixed, drawCar, directVectorRender, rotateWithCar]); // eslint-disable-line react-hooks/exhaustive-deps

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
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawStatic, composite, drawFixed, drawCar, directVectorRender, rotateWithCar]);

  useLayoutEffect(() => {
    if (!rotateWithCar) drawCar(cursorIdx);
  }, [cursorIdx, drawCar, rotateWithCar]);

  useEffect(() => {
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
  }, []);

  return (
    <div
      ref={viewportRef}
      data-testid="analyse-track-map-viewport"
      className="relative w-full h-full cursor-grab touch-none overscroll-contain active:cursor-grabbing"
      style={{ minHeight: 220 }}
      onPointerDown={pointerHandlers.onPointerDown}
      onPointerMove={pointerHandlers.onPointerMove}
      onPointerUp={pointerHandlers.onPointerUp}
      onPointerCancel={pointerHandlers.onPointerCancel}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={carCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={pulseRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
});

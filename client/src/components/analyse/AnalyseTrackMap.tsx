import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { resolveTrackImageryMatrix } from "../../../../shared/racing/tracks/imagery";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { compositeFixedTrack, compositeTrack, drawCarOverlay } from "./track-map/overlay-drawing";
import { pathForwardOffsets, resolveTrackPositions } from "./track-map/path";
import { drawStaticTrack } from "./track-map/static-drawing";
import { semanticNumber, TRACK_MAP_MAX_RENDER_ZOOM, TRACK_MAP_MAX_ZOOM, TRACK_MAP_MIN_ZOOM, type TrackMapHandle, type TrackMapProps, type TrackTransform } from "./track-map/types";

const TRACK_MAP_WHEEL_SENSITIVITY = 0.0015;
const TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME = 240;
const TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA = TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME * 4;
const TRACK_MAP_WHEEL_LINE_HEIGHT = 16;

export const AnalyseTrackMap = forwardRef<TrackMapHandle, TrackMapProps>(function AnalyseTrackMap(props, ref) {
  const {
    gameId,
    telemetry,
    cursorIdx,
    outline,
    mapLabels,
    pitLines,
    imagery,
    geographicPositions,
    showImagery = true,
    boundaries,
    sectors,
    segments,
    highlights,
    showInputs,
    showRaceLine = false,
    showTrace = true,
    rotateWithCar,
    zoom = 1,
    onZoomChange,
  } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carCanvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLCanvasElement>(null);
  const carPosRef = useRef<{ x: number; y: number; w: number; h: number; angle?: number } | null>(null);
  const transformRef = useRef<TrackTransform | null>(null);
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef(cursorIdx);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const viewModeRef = useRef(rotateWithCar);
  const zoomRef = useRef(zoom);
  const wheelAnimationRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelPointerRef = useRef({ x: 0, y: 0 });
  const wheelTargetZoomRef = useRef<number | null>(null);
  const [imageryTextures, setImageryTextures] = useState<readonly { image: HTMLImageElement; opacity: number }[]>([]);
  const resolvedPositions = useMemo(() => resolveTrackPositions(telemetry, outline, gameId), [telemetry, outline, gameId]);
  const imageryMatrix = useMemo(
    () => (showImagery && imagery && geographicPositions ? resolveTrackImageryMatrix(resolvedPositions, geographicPositions, imagery.calibration) : null),
    [geographicPositions, imagery, resolvedPositions, showImagery],
  );
  const resolvedDirections = useMemo(() => pathForwardOffsets(resolvedPositions), [resolvedPositions]);
  const directVectorRender = zoom > TRACK_MAP_MAX_RENDER_ZOOM;
  useEffect(() => {
    setImageryTextures([]);
    if (!showImagery || !imagery) return;
    let cancelled = false;
    void Promise.all(
      imagery.textures.map(
        (texture) =>
          new Promise<{ image: HTMLImageElement; opacity: number }>((resolve, reject) => {
            const image = new Image();
            image.decoding = "async";
            image.onload = () => resolve({ image, opacity: texture.opacity });
            image.onerror = () => reject(new Error(`Unable to load track texture ${texture.id}`));
            image.src = texture.url;
          }),
      ),
    )
      .then((textures) => {
        if (!cancelled) setImageryTextures(textures);
      })
      .catch(() => {
        if (!cancelled) setImageryTextures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [imagery, showImagery]);
  const renderedImagery = useMemo(() => (imageryMatrix && imageryTextures.length > 0 ? { imageToTrack: imageryMatrix, textures: imageryTextures } : null), [imageryMatrix, imageryTextures]);

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
        pitLines,
        mapLabels,
        imagery: renderedImagery,
        boundaries,
        sectors,
        segments,
        highlights,
        showInputs,
        showRaceLine,
        showTrace,
        rotateWithCar,
        zoom,
        viewportCamera: directVectorRender
          ? {
              panX: panRef.current.x,
              panY: panRef.current.y,
              ...(rotateWithCar && position ? { center: position, rotation, drawFollowCar: true } : {}),
            }
          : undefined,
      });
      transformRef.current = result.transform;
      if (!directVectorRender) bufferCanvasRef.current = result.bufferCanvas;
      if (rotateWithCar && carCanvasRef.current) {
        const ctx = getSemanticCanvasContext(carCanvasRef.current);
        ctx?.clearRect(0, 0, carCanvasRef.current.width, carCanvasRef.current.height);
      }
      if (directVectorRender && rotateWithCar && result.transform && position) {
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
      boundaries,
      sectors,
      segments,
      highlights,
      showInputs,
      showRaceLine,
      showTrace,
      rotateWithCar,
      zoom,
      directVectorRender,
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
    }),
    [telemetry, resolvedPositions, resolvedDirections],
  );

  const composite = useCallback(
    (idx: number) => {
      const opts = renderOverlayOptions();
      compositeTrack(opts, idx);
      const pkt = telemetry[idx],
        pos = resolvedPositions[idx];
      if (pkt && pos && transformRef.current)
        carPosRef.current = {
          x: transformRef.current.w / 2 + panRef.current.x,
          y: transformRef.current.h / 2 + panRef.current.y,
          w: transformRef.current.w,
          h: transformRef.current.h,
          angle: -Math.PI / 2,
        };
    },
    [renderOverlayOptions, telemetry, resolvedPositions],
  );
  const drawCar = useCallback(
    (idx: number) => {
      const canvas = carCanvasRef.current;
      if (!canvas) return;
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
  const updateCursor = useCallback(
    (idx: number) => {
      if (directVectorRender && rotateWithCar) drawStatic(idx);
      else if (rotateWithCar) composite(idx);
      else drawCar(idx);
    },
    [directVectorRender, rotateWithCar, drawStatic, composite, drawCar],
  );
  useImperativeHandle(ref, () => ({ updateCursor }), [updateCursor]);
  useLayoutEffect(() => {
    if (viewModeRef.current === rotateWithCar) return;
    panRef.current = { x: 0, y: 0 };
    dragRef.current = null;
    viewModeRef.current = rotateWithCar;
  }, [rotateWithCar]);
  useLayoutEffect(() => {
    const wheelTarget = wheelTargetZoomRef.current;
    if (wheelTarget !== null && zoom !== wheelTarget) return;
    zoomRef.current = zoom;
    wheelTargetZoomRef.current = null;
  }, [zoom]);

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
    let lastW = 0,
      lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === lastW && height === lastH) return;
      lastW = width;
      lastH = height;
      drawStatic(cursorRef.current);
      if (directVectorRender) {
        if (!rotateWithCar) drawCar(cursorRef.current);
      } else if (rotateWithCar) composite(cursorRef.current);
      else drawFixed(cursorRef.current);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [drawStatic, composite, drawFixed, drawCar, directVectorRender, rotateWithCar]);
  useLayoutEffect(() => {
    if (!rotateWithCar) drawCar(cursorIdx);
  }, [cursorIdx, drawCar, rotateWithCar]);

  useEffect(() => {
    const pulse = pulseRef.current;
    if (!pulse) return;
    let animId: number;
    const draw = () => {
      const pos = carPosRef.current;
      if (!pos) {
        animId = requestAnimationFrame(draw);
        return;
      }
      syncCanvasSize(pulse, pos.w, pos.h, window.devicePixelRatio || 1, false);
      const ctx = getSemanticCanvasContext(pulse);
      if (!ctx) {
        animId = requestAnimationFrame(draw);
        return;
      }
      ctx.setTransform(pulse.width / pos.w, 0, 0, pulse.height / pos.h, 0, 0);
      ctx.clearRect(0, 0, pos.w, pos.h);
      const cycle = Date.now() % 2500;
      if (cycle > 1000) {
        animId = requestAnimationFrame(draw);
        return;
      }
      const t = cycle / 1000,
        eased = 1 - (1 - t) ** 3,
        s = 10 + eased * 6;
      ctx.save();
      ctx.translate(pos.x, pos.y);
      if (pos.angle !== undefined) ctx.rotate(pos.angle);
      ctx.beginPath();
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.6, -s * 0.6);
      ctx.lineTo(-s * 0.6, s * 0.6);
      ctx.closePath();
      ctx.globalAlpha = 0.8 * (1 - t);
      ctx.strokeStyle = "var(--app-accent)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      animId = requestAnimationFrame(draw);
    };
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, []);
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }, []);
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      panRef.current.x += event.clientX - drag.x;
      panRef.current.y += event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (directVectorRender) {
        drawStatic(cursorRef.current);
        if (!rotateWithCar) drawCar(cursorRef.current);
      } else if (rotateWithCar) composite(cursorRef.current);
      else drawFixed(cursorRef.current);
    },
    [composite, directVectorRender, drawCar, drawFixed, drawStatic, rotateWithCar],
  );
  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const scheduleWheelZoom = () => {
      if (wheelAnimationRef.current !== null) return;
      wheelAnimationRef.current = requestAnimationFrame(flushWheelZoom);
    };
    const flushWheelZoom = () => {
      wheelAnimationRef.current = null;
      const delta = Math.max(-TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME, Math.min(TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME, wheelDeltaRef.current));
      wheelDeltaRef.current -= delta;
      if (Math.abs(wheelDeltaRef.current) < 0.01) wheelDeltaRef.current = 0;

      const currentZoom = zoomRef.current;
      const nextZoom = Math.max(TRACK_MAP_MIN_ZOOM, Math.min(TRACK_MAP_MAX_ZOOM, currentZoom * Math.exp(-delta * TRACK_MAP_WHEEL_SENSITIVITY)));
      if (nextZoom === currentZoom) {
        wheelDeltaRef.current = 0;
        return;
      }

      const scaleChange = nextZoom / currentZoom;
      panRef.current.x += (1 - scaleChange) * (wheelPointerRef.current.x - panRef.current.x);
      panRef.current.y += (1 - scaleChange) * (wheelPointerRef.current.y - panRef.current.y);
      zoomRef.current = nextZoom;
      wheelTargetZoomRef.current = nextZoom;
      onZoomChange?.(() => nextZoom);
      if (wheelDeltaRef.current !== 0) scheduleWheelZoom();
    };
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!onZoomChange || event.deltaY === 0) return;

      const bounds = viewport.getBoundingClientRect();
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? TRACK_MAP_WHEEL_LINE_HEIGHT : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.max(bounds.height, 1) : 1;
      wheelDeltaRef.current = Math.max(-TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA, Math.min(TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA, wheelDeltaRef.current + event.deltaY * deltaScale));
      wheelPointerRef.current = {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2,
      };
      scheduleWheelZoom();
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      if (wheelAnimationRef.current !== null) cancelAnimationFrame(wheelAnimationRef.current);
      wheelAnimationRef.current = null;
      wheelDeltaRef.current = 0;
    };
  }, [onZoomChange]);

  return (
    <div
      ref={viewportRef}
      data-testid="analyse-track-map-viewport"
      className="relative w-full h-full cursor-grab touch-none overscroll-contain active:cursor-grabbing"
      style={{ minHeight: 220 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={carCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={pulseRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
});

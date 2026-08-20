import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { compositeTrack, drawCarOverlay } from "./track-map/overlay-drawing";
import { pathForwardOffsets, resolveTrackPositions } from "./track-map/path";
import { drawStaticTrack } from "./track-map/static-drawing";
import type { TrackMapHandle, TrackMapProps, TrackTransform } from "./track-map/types";

export const AnalyseTrackMap = forwardRef<TrackMapHandle, TrackMapProps>(function AnalyseTrackMap(props, ref) {
  const { gameId, telemetry, cursorIdx, outline, mapLabels, boundaries, sectors, segments, highlights, showInputs, showTrace = true, rotateWithCar, zoom = 1 } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carCanvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLCanvasElement>(null);
  const carPosRef = useRef<{ x: number; y: number; w: number; h: number; angle?: number } | null>(null);
  const transformRef = useRef<TrackTransform | null>(null);
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resolvedPositions = useMemo(() => resolveTrackPositions(telemetry, outline, gameId), [telemetry, outline, gameId]);
  const resolvedDirections = useMemo(() => pathForwardOffsets(resolvedPositions), [resolvedPositions]);

  const drawStatic = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const result = drawStaticTrack({
      canvas,
      bufferCanvas: bufferCanvasRef.current,
      telemetry,
      gameId,
      resolvedPositions,
      outline,
      mapLabels,
      boundaries,
      sectors,
      segments,
      highlights,
      showInputs,
      showTrace,
      rotateWithCar,
      zoom,
    });
    transformRef.current = result.transform;
    bufferCanvasRef.current = result.bufferCanvas;
    if (rotateWithCar && carCanvasRef.current) {
      const ctx = getSemanticCanvasContext(carCanvasRef.current);
      ctx?.clearRect(0, 0, carCanvasRef.current.width, carCanvasRef.current.height);
    }
  }, [gameId, telemetry, resolvedPositions, outline, mapLabels, boundaries, sectors, segments, highlights, showInputs, showTrace, rotateWithCar, zoom]);

  const renderOverlayOptions = useCallback(
    () => ({
      canvas: canvasRef.current!,
      carCanvas: carCanvasRef.current!,
      bufferCanvas: bufferCanvasRef.current,
      telemetry,
      resolvedPositions,
      resolvedDirections,
      transform: transformRef.current,
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
        carPosRef.current = { x: transformRef.current.w / 2, y: transformRef.current.h / 2, w: transformRef.current.w, h: transformRef.current.h, angle: -Math.PI / 2 };
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
  const updateCursor = useCallback(
    (idx: number) => {
      if (rotateWithCar) composite(idx);
      else drawCar(idx);
    },
    [rotateWithCar, composite, drawCar],
  );
  useImperativeHandle(ref, () => ({ updateCursor }), [updateCursor]);

  useLayoutEffect(() => {
    drawStatic();
    if (rotateWithCar) composite(cursorIdx);
  }, [drawStatic]); // eslint-disable-line react-hooks/exhaustive-deps

  const cursorRef = useRef(cursorIdx);
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
      drawStatic();
      if (rotateWithCar) composite(cursorRef.current);
      else drawCar(cursorRef.current);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [drawStatic, composite, drawCar, rotateWithCar]);
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

  return (
    <div className="relative w-full h-full" style={{ minHeight: 220 }}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={carCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      <canvas ref={pulseRef} className="absolute inset-0 w-full h-full pointer-events-none" />
    </div>
  );
});

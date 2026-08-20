import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { TRACK_MAP_MAX_ZOOM, TRACK_MAP_MIN_ZOOM } from "./types";

const TRACK_MAP_WHEEL_SENSITIVITY = 0.0015;
const TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME = 240;
const TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA = TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME * 4;
const TRACK_MAP_WHEEL_LINE_HEIGHT = 16;

interface UseTrackMapViewportOptions {
  rotateWithCar: boolean;
  zoom: number;
  onZoomChange?: (updater: (zoom: number) => number) => void;
  onPan: () => void;
}

interface TrackMapPointerHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export interface TrackMapViewportModel {
  viewportRef: RefObject<HTMLDivElement | null>;
  panRef: RefObject<{ x: number; y: number }>;
  pointerHandlers: TrackMapPointerHandlers;
}

export function useTrackMapViewport({ rotateWithCar, zoom, onZoomChange, onPan }: UseTrackMapViewportOptions): TrackMapViewportModel {
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const viewModeRef = useRef(rotateWithCar);
  const zoomRef = useRef(zoom);
  const wheelAnimationRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef(0);
  const wheelPointerRef = useRef({ x: 0, y: 0 });
  const wheelTargetZoomRef = useRef<number | null>(null);

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
      onPan();
    },
    [onPan],
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
      wheelDeltaRef.current = Math.max(
        -TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA,
        Math.min(TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA, wheelDeltaRef.current + event.deltaY * deltaScale),
      );
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

  return {
    viewportRef,
    panRef,
    pointerHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerEnd,
      onPointerCancel: handlePointerEnd,
    },
  };
}

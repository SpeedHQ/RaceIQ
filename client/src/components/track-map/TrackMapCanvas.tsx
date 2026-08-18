import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { resolveTrackImageryMatrix } from "../../../../shared/racing/tracks/imagery";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { compositeFixedTrack, compositeTrack, drawCarOverlay } from "./overlay-drawing";
import { pathForwardOffsets, resolveTrackPositions } from "./path";
import { drawStaticTrack } from "./static-drawing";
import { semanticNumber, TRACK_MAP_MAX_RENDER_ZOOM, TRACK_MAP_MAX_ZOOM, TRACK_MAP_MIN_ZOOM, type TrackMapHandle, type TrackMapProps, type TrackTransform } from "./types";

const TRACK_MAP_WHEEL_SENSITIVITY = 0.0015;
const TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME = 240;
const TRACK_MAP_MAX_BUFFERED_WHEEL_DELTA = TRACK_MAP_MAX_WHEEL_DELTA_PER_FRAME * 4;
const TRACK_MAP_WHEEL_LINE_HEIGHT = 16;

type LoadedImagerySource = CanvasImageSource & { close?: () => void };
type LoadedImageryTile = {
  x: number;
  y: number;
  width: number;
  height: number;
  decodeWidth: number;
  decodeHeight: number;
  image: LoadedImagerySource;
  released: boolean;
};
type ImageryTileCamera = {
  mode: "direct" | "composite";
  panX: number;
  panY: number;
  centerX?: number;
  centerY?: number;
  rotation?: number;
};

type ImageryTileManager = {
  key: string;
  close: () => void;
  request: (matrix: [number, number, number, number, number, number], transform: TrackTransform, camera: ImageryTileCamera) => void;
};

const IMAGERY_TILE_CONCURRENCY = 4;
const IMAGERY_TILE_CACHE_FLOOR = 96;

function releaseImagerySource(source: CanvasImageSource | null | undefined): void {
  if (!source) return;
  if ("close" in source && typeof source.close === "function") source.close();
  else if ("src" in source && typeof source.src === "string") (source as HTMLImageElement).src = "";
}

function releaseImageryTile(tile: LoadedImageryTile): void {
  if (tile.released) return;
  tile.released = true;
  releaseImagerySource(tile.image);
}

async function loadImagerySource(url: string, signal: AbortSignal, resize?: { width: number; height: number }): Promise<LoadedImagerySource> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to load imagery tile: ${response.status}`);
  const blob = await response.blob();
  if (typeof createImageBitmap === "function") {
    return (await createImageBitmap(blob, resize ? { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: "high" } : undefined)) as LoadedImagerySource;
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to decode imagery image"));
    });
    image.src = objectUrl;
    await loaded;
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function imageryTileUrl(template: string, x: number, y: number, gameId?: string): string {
  const replaced = template
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{tier\}/g, "hq");
  const url = new URL(replaced, window.location.href);
  if (gameId && !url.searchParams.has("gameId")) url.searchParams.set("gameId", gameId);
  return url.toString();
}

function imagerySourceUrl(url: string): string {
  return new URL(url, window.location.href).toString();
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
    geographicPositions,
    boundaries,
    sectors,
    segments,
    curbs,
    highlights,
    layers,
    rotateWithCar,
    zoom = 1,
    onZoomChange,
  } = props;
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const visibleBoundaries = useMemo(
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
  const [imageryTextures, setImageryTextures] = useState<readonly { image: LoadedImagerySource; opacity: number }[]>([]);
  const imageryTileManagerRef = useRef<ImageryTileManager | null>(null);
  const [imageryTiles, setImageryTiles] = useState<readonly LoadedImageryTile[]>([]);
  const resolvedPositions = useMemo(() => resolveTrackPositions(telemetry, outline, gameId), [telemetry, outline, gameId]);
  const imageryLocalPositions = resolvedPositions.length > 0 ? resolvedPositions : (outline ?? []);
  const imageryMatrix = useMemo(
    () =>
      showImagery && imagery && geographicPositions && imageryLocalPositions.length > 1
        ? resolveTrackImageryMatrix(imageryLocalPositions, geographicPositions, imagery.calibration)
        : null,
    [geographicPositions, imagery, imageryLocalPositions, showImagery],
  );
  const resolvedDirections = useMemo(() => pathForwardOffsets(resolvedPositions), [resolvedPositions]);
  const directVectorRender = zoom > TRACK_MAP_MAX_RENDER_ZOOM;
  useLayoutEffect(() => {
    imageryTileManagerRef.current?.close();
    imageryTileManagerRef.current = null;
    setImageryTiles([]);
    if (!showImagery || !imagery) return;
    const base = imagery.base;
    const width = Math.max(1, base.width);
    const height = Math.max(1, base.height);
    const tileSize = Math.max(1, base.tileSize);
    const columns = Math.max(1, base.columns || Math.ceil(width / tileSize));
    const rows = Math.max(1, base.rows || Math.ceil(height / tileSize));
    const abortController = new AbortController();
    let closed = false;
    let inFlight = 0;
    let cacheLimit = IMAGERY_TILE_CACHE_FLOOR;
    const cache = new Map<string, LoadedImageryTile>();
    const queued = new Set<string>();
    const queue: { x: number; y: number; decodeWidth: number; decodeHeight: number }[] = [];
    let wanted = new Map<string, { x: number; y: number; decodeWidth: number; decodeHeight: number }>();
    const key = `${base.tileUrlTemplate}|${width}x${height}|${tileSize}|${gameId ?? ""}`;
    const publish = () => {
      if (!closed) setImageryTiles([...cache.values()]);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      abortController.abort();
      queue.length = 0;
      queued.clear();
      for (const tile of cache.values()) releaseImageryTile(tile);
      cache.clear();
      if (imageryTileManagerRef.current?.key === key) imageryTileManagerRef.current = null;
    };
    const load = async (x: number, y: number, decodeWidth: number, decodeHeight: number) => {
      const tileWidth = Math.max(1, Math.min(tileSize, width - x * tileSize));
      const tileHeight = Math.max(1, Math.min(tileSize, height - y * tileSize));
      const tileKey = `${x}:${y}`;
      try {
        const image = await loadImagerySource(imageryTileUrl(base.tileUrlTemplate, x, y, gameId), abortController.signal, {
          width: decodeWidth,
          height: decodeHeight,
        });
        if (closed) {
          releaseImagerySource(image);
          return;
        }
        const desired = wanted.get(tileKey);
        if (!desired) {
          releaseImagerySource(image);
          return;
        }
        const previous = cache.get(tileKey);
        const tile: LoadedImageryTile = { x, y, width: tileWidth, height: tileHeight, decodeWidth, decodeHeight, image, released: false };
        if (previous && previous.decodeWidth >= tile.decodeWidth && previous.decodeHeight >= tile.decodeHeight) {
          releaseImageryTile(tile);
          cache.delete(tileKey);
          cache.set(tileKey, previous);
          return;
        }
        cache.delete(tileKey);
        cache.set(tileKey, tile);
        if (previous) releaseImageryTile(previous);
        while (cache.size > cacheLimit) {
          const oldestKey = cache.keys().next().value as string | undefined;
          if (!oldestKey) break;
          const oldest = cache.get(oldestKey);
          cache.delete(oldestKey);
          if (oldest) releaseImageryTile(oldest);
        }
        publish();
      } catch {
        // Abort and unavailable tiles leave neighboring tiles visible.
      } finally {
        inFlight--;
        queued.delete(tileKey);
        const desired = wanted.get(tileKey);
        const cached = cache.get(tileKey);
        if (
          desired &&
          (desired.decodeWidth > decodeWidth || desired.decodeHeight > decodeHeight) &&
          (!cached || cached.decodeWidth < desired.decodeWidth || cached.decodeHeight < desired.decodeHeight)
        ) {
          queued.add(tileKey);
          queue.unshift(desired);
        }
        pump();
      }
    };
    const pump = () => {
      while (!closed && inFlight < IMAGERY_TILE_CONCURRENCY && queue.length > 0) {
        const tile = queue.shift()!;
        const tileKey = `${tile.x}:${tile.y}`;
        const cached = cache.get(tileKey);
        if (cached && cached.decodeWidth >= tile.decodeWidth && cached.decodeHeight >= tile.decodeHeight) {
          queued.delete(tileKey);
          continue;
        }
        inFlight++;
        void load(tile.x, tile.y, tile.decodeWidth, tile.decodeHeight);
      }
    };
    const request = (matrix: [number, number, number, number, number, number], transform: TrackTransform, camera: ImageryTileCamera) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const screenToBuffer = (screenX: number, screenY: number): [number, number] => {
        if (camera.centerX !== undefined && camera.centerY !== undefined) {
          const angle = -(camera.rotation ?? 0);
          const dx = screenX - (transform.w / 2 + camera.panX);
          const dy = screenY - (transform.h / 2 + camera.panY);
          return [camera.centerX + dx * Math.cos(angle) - dy * Math.sin(angle), camera.centerY! + dx * Math.sin(angle) + dy * Math.cos(angle)];
        }
        return camera.mode === "direct"
          ? [screenX - camera.panX, screenY - camera.panY]
          : [screenX - (transform.w - transform.offW) / 2 - camera.panX, screenY - (transform.h - transform.offH) / 2 - camera.panY];
      };
      const determinant = matrix[0] * matrix[3] - matrix[2] * matrix[1];
      if (Math.abs(determinant) < Number.EPSILON) return;
      const corners = [
        [0, 0],
        [rect.width, 0],
        [0, rect.height],
        [rect.width, rect.height],
      ];
      let uMin = Infinity,
        uMax = -Infinity,
        vMin = Infinity,
        vMax = -Infinity;
      for (const [screenX, screenY] of corners) {
        const [bufferX, bufferY] = screenToBuffer(screenX, screenY);
        const trackX = transform.maxX - (bufferX - transform.offsetX) / transform.scale;
        const trackZ = transform.minZ + (bufferY - transform.offsetZ) / transform.scale;
        const dx = trackX - matrix[4];
        const dz = trackZ - matrix[5];
        const u = (matrix[3] * dx - matrix[2] * dz) / determinant;
        const v = (-matrix[1] * dx + matrix[0] * dz) / determinant;
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
      const x0 = Math.max(0, Math.floor((Math.max(0, uMin) * width) / tileSize) - 1);
      const x1 = Math.min(columns - 1, Math.floor((Math.min(1, uMax) * width) / tileSize) + 1);
      const y0 = Math.max(0, Math.floor((Math.max(0, vMin) * height) / tileSize) - 1);
      const y1 = Math.min(rows - 1, Math.floor((Math.min(1, vMax) * height) / tileSize) + 1);
      const nextWanted = new Map<string, { x: number; y: number; decodeWidth: number; decodeHeight: number }>();
      const deviceScale = window.devicePixelRatio || 1;
      const fullTileScreenWidth = (Math.hypot(matrix[0], matrix[1]) * transform.scale * tileSize * deviceScale) / width;
      const fullTileScreenHeight = (Math.hypot(matrix[2], matrix[3]) * transform.scale * tileSize * deviceScale) / height;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const logicalWidth = Math.min(tileSize, width - x * tileSize);
          const logicalHeight = Math.min(tileSize, height - y * tileSize);
          nextWanted.set(`${x}:${y}`, {
            x,
            y,
            decodeWidth: Math.max(1, Math.min(logicalWidth, Math.ceil((fullTileScreenWidth * logicalWidth) / tileSize))),
            decodeHeight: Math.max(1, Math.min(logicalHeight, Math.ceil((fullTileScreenHeight * logicalHeight) / tileSize))),
          });
        }
      }
      wanted = nextWanted;
      cacheLimit = Math.max(IMAGERY_TILE_CACHE_FLOOR, wanted.size);
      for (let index = queue.length - 1; index >= 0; index--) {
        const queuedTile = queue[index];
        const queuedKey = `${queuedTile.x}:${queuedTile.y}`;
        if (!wanted.has(queuedKey)) {
          queue.splice(index, 1);
          queued.delete(queuedKey);
        }
      }
      for (const [tileKey, desired] of wanted) {
        const cached = cache.get(tileKey);
        if (cached) {
          cache.delete(tileKey);
          cache.set(tileKey, cached);
          if (cached.decodeWidth >= desired.decodeWidth && cached.decodeHeight >= desired.decodeHeight) continue;
        }
        const pending = queue.find((tile) => tile.x === desired.x && tile.y === desired.y);
        if (pending) {
          pending.decodeWidth = Math.max(pending.decodeWidth, desired.decodeWidth);
          pending.decodeHeight = Math.max(pending.decodeHeight, desired.decodeHeight);
        } else if (!queued.has(tileKey)) {
          queued.add(tileKey);
          queue.push(desired);
        }
      }
      const centerTileX = (((Math.max(0, uMin) + Math.min(1, uMax)) / 2) * width) / tileSize;
      const centerTileY = (((Math.max(0, vMin) + Math.min(1, vMax)) / 2) * height) / tileSize;
      queue.sort((left, right) => (left.x - centerTileX) ** 2 + (left.y - centerTileY) ** 2 - ((right.x - centerTileX) ** 2 + (right.y - centerTileY) ** 2));
      const hasAllWanted = [...wanted.keys()].every((tileKey) => cache.has(tileKey));
      let evicted = false;
      while (hasAllWanted && cache.size > cacheLimit) {
        const oldestKey = cache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldest) releaseImageryTile(oldest);
        evicted = true;
      }
      if (evicted) publish();
      pump();
    };
    const manager: ImageryTileManager = { key, close, request };
    imageryTileManagerRef.current = manager;
    return close;
  }, [gameId, imagery?.base.columns, imagery?.base.height, imagery?.base.rows, imagery?.base.tileSize, imagery?.base.tileUrlTemplate, imagery?.base.width, showImagery]);
  useEffect(() => {
    setImageryTextures([]);
    if (!showImagery || !imagery) return;
    const abortController = new AbortController();
    let cancelled = false;
    const ownedSources = new Set<LoadedImagerySource>();
    void (async () => {
      for (const texture of imagery.textures) {
        if (cancelled) return;
        try {
          const image = await loadImagerySource(imagerySourceUrl(texture.url), abortController.signal);
          if (cancelled) {
            releaseImagerySource(image);
            return;
          }
          ownedSources.add(image);
          setImageryTextures((current) => [...current, { image, opacity: texture.opacity }]);
        } catch {
          if (cancelled) return;
        }
      }
    })();
    return () => {
      cancelled = true;
      abortController.abort();
      setImageryTextures([]);
      for (const source of ownedSources) releaseImagerySource(source);
      ownedSources.clear();
    };
  }, [imagery, showImagery]);
  const requestVisibleTiles = useCallback(
    (transform: TrackTransform, viewportCamera?: { panX: number; panY: number; center?: { x: number; z: number }; rotation?: number }) => {
      const manager = imageryTileManagerRef.current;
      if (!manager || !imageryMatrix) return;
      const position = resolvedPositions[cursorRef.current];
      const path = resolvedDirections[cursorRef.current];
      const rotation = path ? -Math.PI / 2 - Math.atan2(path[1], -path[0]) : 0;
      let camera: ImageryTileCamera;
      if (viewportCamera?.center) {
        camera = { mode: "direct", panX: viewportCamera.panX, panY: viewportCamera.panY, centerX: transform.w / 2, centerY: transform.h / 2, rotation: viewportCamera.rotation };
      } else if (directVectorRender) {
        camera = { mode: "direct", panX: panRef.current.x, panY: panRef.current.y };
      } else if (rotateWithCar && position) {
        camera = {
          mode: "composite",
          panX: panRef.current.x,
          panY: panRef.current.y,
          centerX: transform.offsetX + (transform.maxX - position.x) * transform.scale,
          centerY: transform.offsetZ + (position.z - transform.minZ) * transform.scale,
          rotation,
        };
      } else {
        camera = { mode: "composite", panX: panRef.current.x, panY: panRef.current.y };
      }
      manager.request(imageryMatrix, transform, camera);
    },
    [directVectorRender, imageryMatrix, resolvedDirections, resolvedPositions, rotateWithCar],
  );
  const renderedImagery = useMemo(
    () =>
      imageryMatrix && imagery
        ? {
            imageToTrack: imageryMatrix,
            base: { width: imagery.base.width, height: imagery.base.height, tileSize: imagery.base.tileSize, tiles: imageryTiles },
            textures: imageryTextures,
            requestVisibleTiles,
          }
        : null,
    [imagery, imageryMatrix, imageryTextures, imageryTiles, requestVisibleTiles],
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
        const ctx = getSemanticCanvasContext(carCanvasRef.current);
        ctx?.clearRect(0, 0, carCanvasRef.current.width, carCanvasRef.current.height);
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
    [telemetry, resolvedPositions, resolvedDirections, showCar],
  );

  const composite = useCallback(
    (idx: number) => {
      const opts = renderOverlayOptions();
      compositeTrack(opts, idx);
      if (transformRef.current) requestVisibleTiles(transformRef.current);
      const pkt = telemetry[idx],
        pos = resolvedPositions[idx];
      if (showCar && pkt && pos && transformRef.current)
        carPosRef.current = {
          x: transformRef.current.w / 2 + panRef.current.x,
          y: transformRef.current.h / 2 + panRef.current.y,
          w: transformRef.current.w,
          h: transformRef.current.h,
          angle: -Math.PI / 2,
        };
    },
    [renderOverlayOptions, requestVisibleTiles, telemetry, resolvedPositions, showCar],
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
      } else {
        if (transformRef.current) requestVisibleTiles(transformRef.current);
        if (rotateWithCar) composite(cursorRef.current);
        else drawFixed(cursorRef.current);
      }
    },
    [composite, directVectorRender, drawCar, drawFixed, drawStatic, requestVisibleTiles, rotateWithCar],
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

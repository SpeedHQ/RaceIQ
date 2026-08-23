import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { TrackImagery, TrackImageryMatrix } from "../../../../shared/racing/tracks/imagery";
import type { GameId } from "../../../../shared/games/ids";
import { createImageryTileManager, imagerySourceUrl, loadImagerySource, releaseImagerySource, type ImageryTileCamera, type ImageryTileManager, type LoadedImagerySource, type LoadedImageryTile } from "./imagery-loading";
import type { StaticTrackImagery } from "./static-drawing";
import type { Point, TrackTransform } from "./types";

interface UseTrackMapImageryOptions {
  gameId?: GameId;
  imagery?: TrackImagery | null;
  imageryMatrix: TrackImageryMatrix | null;
  enabled: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cursorRef: RefObject<number>;
  panRef: RefObject<{ x: number; y: number }>;
  resolvedPositions: Point[];
  resolvedDirections: ([number, number] | null)[];
  rotateWithCar: boolean;
  directVectorRender: boolean;
}

interface ViewportTrackCamera {
  panX: number;
  panY: number;
  center?: Point;
  rotation?: number;
}

export function useTrackMapImagery({
  gameId,
  imagery,
  imageryMatrix,
  enabled,
  canvasRef,
  cursorRef,
  panRef,
  resolvedPositions,
  resolvedDirections,
  rotateWithCar,
  directVectorRender,
}: UseTrackMapImageryOptions): StaticTrackImagery | null {
  const imageryTileManagerRef = useRef<ImageryTileManager | null>(null);
  const [imageryTiles, setImageryTiles] = useState<readonly LoadedImageryTile[]>([]);
  const [imageryTextures, setImageryTextures] = useState<readonly { image: LoadedImagerySource; opacity: number }[]>([]);

  useLayoutEffect(() => {
    imageryTileManagerRef.current?.close();
    imageryTileManagerRef.current = null;
    setImageryTiles([]);
    if (!enabled || !imagery) return;

    const manager = createImageryTileManager({
      base: imagery.base,
      gameId,
      getViewportRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
      onTilesChanged: setImageryTiles,
    });
    imageryTileManagerRef.current = manager;
    return () => {
      manager.close();
      if (imageryTileManagerRef.current === manager) imageryTileManagerRef.current = null;
    };
  }, [
    canvasRef,
    enabled,
    gameId,
    imagery?.base.columns,
    imagery?.base.height,
    imagery?.base.rows,
    imagery?.base.tileSize,
    imagery?.base.tileUrlTemplate,
    imagery?.base.width,
  ]);

  useEffect(() => {
    setImageryTextures([]);
    if (!enabled || !imagery) return;

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
  }, [enabled, imagery]);

  const requestVisibleTiles = useCallback(
    (transform: TrackTransform, viewportCamera?: ViewportTrackCamera) => {
      const manager = imageryTileManagerRef.current;
      if (!manager || !imageryMatrix) return;
      const position = resolvedPositions[cursorRef.current];
      const path = resolvedDirections[cursorRef.current];
      const rotation = path ? -Math.PI / 2 - Math.atan2(path[1], -path[0]) : 0;
      let camera: ImageryTileCamera;
      if (viewportCamera?.center) {
        camera = {
          mode: "direct",
          panX: viewportCamera.panX,
          panY: viewportCamera.panY,
          centerX: transform.w / 2,
          centerY: transform.h / 2,
          rotation: viewportCamera.rotation,
        };
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
    [cursorRef, directVectorRender, imageryMatrix, panRef, resolvedDirections, resolvedPositions, rotateWithCar],
  );

  return useMemo(
    () =>
      enabled && imageryMatrix && imagery
        ? {
            imageToTrack: imageryMatrix,
            base: {
              width: imagery.base.width,
              height: imagery.base.height,
              tileSize: imagery.base.tileSize,
              tiles: imageryTiles,
            },
            textures: imageryTextures,
            requestVisibleTiles,
          }
        : null,
    [enabled, imagery, imageryMatrix, imageryTextures, imageryTiles, requestVisibleTiles],
  );
}

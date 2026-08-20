import type { TrackImageryBase, TrackImageryMatrix } from "../../../../shared/racing/tracks/imagery";
import type { TrackTransform } from "./types";

export type LoadedImagerySource = CanvasImageSource & { close?: () => void };

export interface LoadedImageryTile {
  x: number;
  y: number;
  width: number;
  height: number;
  decodeWidth: number;
  decodeHeight: number;
  image: LoadedImagerySource;
  released: boolean;
}

export interface ImageryTileCamera {
  mode: "direct" | "composite";
  panX: number;
  panY: number;
  centerX?: number;
  centerY?: number;
  rotation?: number;
}

export interface ImageryTileManager {
  request: (matrix: TrackImageryMatrix, transform: TrackTransform, camera: ImageryTileCamera) => void;
  close: () => void;
}

interface ImageryTileManagerOptions {
  base: TrackImageryBase;
  gameId?: string;
  getViewportRect: () => Pick<DOMRect, "width" | "height"> | null;
  onTilesChanged: (tiles: readonly LoadedImageryTile[]) => void;
}

interface RequestedImageryTile {
  x: number;
  y: number;
  decodeWidth: number;
  decodeHeight: number;
}

const IMAGERY_TILE_CONCURRENCY = 4;
const IMAGERY_TILE_CACHE_FLOOR = 96;

export function releaseImagerySource(source: CanvasImageSource | null | undefined): void {
  if (!source) return;
  if ("close" in source && typeof source.close === "function") source.close();
  else if ("src" in source && typeof source.src === "string") (source as HTMLImageElement).src = "";
}

function releaseImageryTile(tile: LoadedImageryTile): void {
  if (tile.released) return;
  tile.released = true;
  releaseImagerySource(tile.image);
}

async function decodeImageryBlob(blob: Blob, resize?: { width: number; height: number }): Promise<LoadedImagerySource> {
  if (typeof createImageBitmap === "function") {
    try {
      return (await createImageBitmap(blob, resize ? { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: "high" } : undefined)) as LoadedImagerySource;
    } catch {
      // Some bitmap decoders reject formats that Image can decode.
    }
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

export async function loadImagerySource(url: string, signal: AbortSignal, resize?: { width: number; height: number }): Promise<LoadedImagerySource> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to load imagery tile: ${response.status}`);
  return decodeImageryBlob(await response.blob(), resize);
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

export function imagerySourceUrl(url: string): string {
  return new URL(url, window.location.href).toString();
}

export function createImageryTileManager({ base, gameId, getViewportRect, onTilesChanged }: ImageryTileManagerOptions): ImageryTileManager {
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
  const staged = new Map<string, LoadedImageryTile>();
  const failed = new Map<string, RequestedImageryTile>();
  const queued = new Set<string>();
  const queue: RequestedImageryTile[] = [];
  let wanted = new Map<string, RequestedImageryTile>();

  const satisfies = (tile: Pick<LoadedImageryTile, "decodeWidth" | "decodeHeight"> | undefined, desired: RequestedImageryTile) =>
    !!tile && tile.decodeWidth >= desired.decodeWidth && tile.decodeHeight >= desired.decodeHeight;

  const publish = () => {
    if (!closed) onTilesChanged([...cache.values()]);
  };

  const commitReadyTiles = () => {
    if (closed || wanted.size === 0) return;
    const ready = [...wanted].every(([tileKey, desired]) => satisfies(cache.get(tileKey), desired) || satisfies(staged.get(tileKey), desired) || satisfies(failed.get(tileKey), desired));
    if (!ready) return;

    let changed = false;
    for (const tileKey of wanted.keys()) {
      const replacement = staged.get(tileKey);
      if (!replacement) continue;
      staged.delete(tileKey);
      const previous = cache.get(tileKey);
      cache.delete(tileKey);
      cache.set(tileKey, replacement);
      if (previous) releaseImageryTile(previous);
      changed = true;
    }

    let evicted = false;
    while (cache.size > cacheLimit) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) releaseImageryTile(oldest);
      evicted = true;
    }
    if (changed || evicted) publish();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    abortController.abort();
    queue.length = 0;
    queued.clear();
    for (const tile of cache.values()) releaseImageryTile(tile);
    for (const tile of staged.values()) releaseImageryTile(tile);
    cache.clear();
    staged.clear();
    failed.clear();
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
      const previousStaged = staged.get(tileKey);
      const previousCached = cache.get(tileKey);
      const tile: LoadedImageryTile = { x, y, width: tileWidth, height: tileHeight, decodeWidth, decodeHeight, image, released: false };
      if (satisfies(previousStaged, tile) || satisfies(previousCached, tile)) {
        releaseImageryTile(tile);
        if (previousCached && !previousStaged) {
          cache.delete(tileKey);
          cache.set(tileKey, previousCached);
        }
        return;
      }
      staged.set(tileKey, tile);
      if (previousStaged) releaseImageryTile(previousStaged);
      const previousFailure = failed.get(tileKey);
      if (previousFailure && decodeWidth >= previousFailure.decodeWidth && decodeHeight >= previousFailure.decodeHeight) failed.delete(tileKey);
    } catch {
      const desired = wanted.get(tileKey);
      if (!closed && desired) {
        const previousFailure = failed.get(tileKey);
        if (!previousFailure || decodeWidth > previousFailure.decodeWidth || decodeHeight > previousFailure.decodeHeight) {
          failed.set(tileKey, { x, y, decodeWidth, decodeHeight });
        }
      }
    } finally {
      inFlight--;
      queued.delete(tileKey);
      const desired = wanted.get(tileKey);
      if (
        !closed &&
        desired &&
        (desired.decodeWidth > decodeWidth || desired.decodeHeight > decodeHeight) &&
        !satisfies(cache.get(tileKey), desired) &&
        !satisfies(staged.get(tileKey), desired) &&
        !satisfies(failed.get(tileKey), desired)
      ) {
        queued.add(tileKey);
        queue.unshift(desired);
      }
      commitReadyTiles();
      pump();
    }
  };

  const pump = () => {
    while (!closed && inFlight < IMAGERY_TILE_CONCURRENCY && queue.length > 0) {
      const tile = queue.shift()!;
      const tileKey = `${tile.x}:${tile.y}`;
      if (satisfies(cache.get(tileKey), tile) || satisfies(staged.get(tileKey), tile) || satisfies(failed.get(tileKey), tile)) {
        queued.delete(tileKey);
        continue;
      }
      inFlight++;
      void load(tile.x, tile.y, tile.decodeWidth, tile.decodeHeight);
    }
  };

  const request = (matrix: TrackImageryMatrix, transform: TrackTransform, camera: ImageryTileCamera) => {
    const rect = getViewportRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const screenToBuffer = (screenX: number, screenY: number): [number, number] => {
      if (camera.centerX !== undefined && camera.centerY !== undefined) {
        const angle = -(camera.rotation ?? 0);
        const dx = screenX - (transform.w / 2 + camera.panX);
        const dy = screenY - (transform.h / 2 + camera.panY);
        return [camera.centerX + dx * Math.cos(angle) - dy * Math.sin(angle), camera.centerY + dx * Math.sin(angle) + dy * Math.cos(angle)];
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
    const nextWanted = new Map<string, RequestedImageryTile>();
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
    const requestChanged =
      wanted.size !== nextWanted.size ||
      [...nextWanted].some(([tileKey, desired]) => {
        const previous = wanted.get(tileKey);
        return !previous || previous.decodeWidth !== desired.decodeWidth || previous.decodeHeight !== desired.decodeHeight;
      });
    if (requestChanged) failed.clear();
    wanted = nextWanted;
    cacheLimit = Math.max(IMAGERY_TILE_CACHE_FLOOR, wanted.size);
    for (const [tileKey, tile] of staged) {
      if (wanted.has(tileKey)) continue;
      staged.delete(tileKey);
      releaseImageryTile(tile);
    }
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
      }
      if (satisfies(cached, desired) || satisfies(staged.get(tileKey), desired) || satisfies(failed.get(tileKey), desired)) continue;
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
    commitReadyTiles();
    pump();
  };

  return { request, close };
}

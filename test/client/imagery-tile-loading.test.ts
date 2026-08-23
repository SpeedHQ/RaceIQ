import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { TrackImageryBase, TrackImageryMatrix } from "../../shared/racing/tracks/imagery";
import { createImageryTileManager, type LoadedImageryTile } from "../../client/src/components/track-map/imagery-loading";
import type { TrackTransform } from "../../client/src/components/track-map/types";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalCreateImageBitmap = globalThis.createImageBitmap;

interface PendingRequest {
  resolve: () => void;
  reject: () => void;
}

let pendingRequests: PendingRequest[] = [];

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1, location: { href: "http://raceiq.test/" } } });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      pendingRequests.push({
        resolve: () => resolve({ ok: true, blob: async () => new Blob() } as Response),
        reject: () => reject(new Error("tile unavailable")),
      });
      return promise;
    },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ close: () => undefined }) as ImageBitmap,
  });
});

beforeEach(() => {
  pendingRequests = [];
});

afterAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: originalCreateImageBitmap });
});

const base = {
  width: 1024,
  height: 1024,
  tileSize: 512,
  columns: 2,
  rows: 2,
  tileUrlTemplate: "/tiles/{x}/{y}",
} as TrackImageryBase;

const matrix: TrackImageryMatrix = [200, 0, 0, 200, 0, 0];
const transform: TrackTransform = {
  w: 200,
  h: 200,
  offsetX: 0,
  offsetZ: 0,
  scale: 1,
  maxX: 200,
  minZ: 0,
  displayOutline: [],
  offW: 0,
  offH: 0,
};
const camera = { mode: "direct" as const, panX: 0, panY: 0 };

async function flushTileWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function resolveAllPending(): Promise<void> {
  const requests = pendingRequests.splice(0);
  for (const request of requests) request.resolve();
  await flushTileWork();
}

function manager(publications: LoadedImageryTile[][]) {
  return createImageryTileManager({
    base,
    getViewportRect: () => ({ width: 200, height: 200 }),
    onTilesChanged: (tiles) => publications.push([...tiles]),
  });
}

test("publishes an initial visible tile set as one complete frame", async () => {
  const publications: LoadedImageryTile[][] = [];
  const tileManager = manager(publications);
  try {
    tileManager.request(matrix, transform, camera);
    expect(pendingRequests).toHaveLength(4);

    pendingRequests.shift()!.resolve();
    await flushTileWork();
    expect(publications).toHaveLength(0);

    await resolveAllPending();
    expect(publications).toHaveLength(1);
    expect(publications[0]).toHaveLength(4);
  } finally {
    tileManager.close();
  }
});

test("keeps the prior tile frame until every zoom replacement is ready", async () => {
  const publications: LoadedImageryTile[][] = [];
  const tileManager = manager(publications);
  try {
    tileManager.request(matrix, transform, camera);
    await resolveAllPending();
    expect(publications).toHaveLength(1);
    const initialTiles = publications[0];

    tileManager.request(matrix, { ...transform, scale: 2 }, camera);
    expect(pendingRequests).toHaveLength(4);
    pendingRequests.shift()!.resolve();
    await flushTileWork();

    expect(publications).toHaveLength(1);
    expect(initialTiles.every((tile) => !tile.released)).toBe(true);

    await resolveAllPending();
    expect(publications).toHaveLength(2);
    expect(publications[1].every((tile) => tile.decodeWidth === 200 && tile.decodeHeight === 200)).toBe(true);
    expect(initialTiles.every((tile) => tile.released)).toBe(true);
  } finally {
    tileManager.close();
  }
});

test("publishes available tiles once after unavailable tiles settle", async () => {
  const publications: LoadedImageryTile[][] = [];
  const tileManager = manager(publications);
  try {
    tileManager.request(matrix, transform, camera);
    pendingRequests.shift()!.reject();
    await resolveAllPending();

    expect(publications).toHaveLength(1);
    expect(publications[0]).toHaveLength(3);

    tileManager.request(matrix, transform, camera);
    expect(pendingRequests).toHaveLength(0);
  } finally {
    tileManager.close();
  }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { drawStaticTrack } from "../../client/src/components/track-map/static-drawing";

const originalWindow = globalThis.window;

beforeAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
});

afterAll(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function canvas(context: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: { width: "", height: "" },
    getBoundingClientRect: () => ({ width: 200, height: 200 }),
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

function context(drawImage: (...args: unknown[]) => void): CanvasRenderingContext2D {
  const target = { drawImage, measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(current, property) {
      if (property in current) return Reflect.get(current, property);
      return () => undefined;
    },
  }) as unknown as CanvasRenderingContext2D;
}

test("draws current imagery before a visibility request can evict it", () => {
  const events: string[] = [];
  let released = false;
  const tileDraw: unknown[] = [];
  const bufferContext = context((...args) => {
    events.push("draw");
    tileDraw.push(...args);
  });

  drawStaticTrack({
    canvas: canvas(context(() => undefined)),
    bufferCanvas: canvas(bufferContext),
    telemetry: [],
    resolvedPositions: [
      { x: 0, z: 0 },
      { x: 100, z: 100 },
      { x: 50, z: 75 },
    ],
    outline: null,
    imagery: {
      imageToTrack: [100, 0, 0, 100, 0, 0],
      base: {
        width: 512,
        height: 512,
        tileSize: 512,
        tiles: [
          {
            x: 0,
            y: 0,
            width: 512,
            height: 512,
            decodeWidth: 100,
            decodeHeight: 100,
            image: {} as CanvasImageSource,
            get released() {
              return released;
            },
          },
        ],
      },
      textures: [],
      requestVisibleTiles: () => {
        events.push("request");
        released = true;
      },
    },
    boundaries: null,
    sectors: null,
    segments: null,
    showTrace: false,
    rotateWithCar: false,
    zoom: 1,
  });

  expect(events).toEqual(["draw", "request"]);
  expect(tileDraw.slice(1)).toEqual([-0.01, -0.01, 1.02, 1.02]);
});

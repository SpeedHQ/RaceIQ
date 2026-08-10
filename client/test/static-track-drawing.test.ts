import { expect, test } from "bun:test";
import { drawStaticTrack } from "../src/components/analyse/track-map/static-drawing";

test("returns no transform when replay has no drawable track points", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const canvas = {
      width: 0,
      height: 0,
      style: {},
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement;

    expect(drawStaticTrack({
      canvas,
      bufferCanvas: null,
      telemetry: [],
      resolvedPositions: [],
      outline: null,
      boundaries: null,
      sectors: null,
      segments: null,
      showTrace: false,
      rotateWithCar: false,
      zoom: 1,
    })).toEqual({ bufferCanvas: null, transform: null });
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("draws throttle input traces in the throttle channel color", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const strokes: Array<{ color: string; alpha: number; width: number }> = [];
    const context = {
      strokeStyle: "",
      globalAlpha: 1,
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      setTransform() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {
        strokes.push({ color: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth });
      },
      save() {},
      restore() {},
      drawImage() {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      style: {},
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const frame = (accel: number) => ({ values: { "inputs.accel": accel, "inputs.brake": 0 }, states: {}, freshness: {} });

    drawStaticTrack({
      canvas,
      bufferCanvas: canvas,
      telemetry: [frame(64), frame(128), frame(255)],
      resolvedPositions: [{ x: 1, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 3 }],
      outline: null,
      boundaries: null,
      sectors: null,
      segments: null,
      showInputs: true,
      showTrace: true,
      rotateWithCar: false,
      zoom: 1,
    });

    expect(strokes.filter((stroke) => stroke.color === "var(--ch-throttle)")).toEqual([
      { color: "var(--ch-throttle)", alpha: 0.35 + (128 / 255) * 0.65, width: 2 },
      { color: "var(--ch-throttle)", alpha: 1, width: 2 },
    ]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

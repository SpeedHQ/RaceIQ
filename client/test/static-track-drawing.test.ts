import { expect, test } from "bun:test";
import { drawStaticTrack } from "../src/components/analyse/track-map/static-drawing";
import { resolveTrackPositions } from "../src/components/analyse/track-map/path";

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

test("aligns imported iRacing GPS paths to analyse-map outlines", () => {
  const gpsPath = [
    { x: 0, z: 0 },
    { x: 90, z: -10 },
    { x: 145, z: 35 },
    { x: 120, z: 105 },
    { x: 55, z: 140 },
    { x: -25, z: 85 },
    { x: -40, z: 25 },
    { x: 0, z: 0 },
  ];
  const angle = 0.37;
  const scale = 1.8;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const outline = gpsPath.map((point) => ({
    x: scale * (cos * point.x - sin * point.z) + 350,
    z: scale * (sin * point.x + cos * point.z) - 120,
  }));
  const telemetry = gpsPath.map((point) => ({
    values: {
      "motion.position-x": point.x,
      "motion.position-z": point.z,
    },
    states: {},
    freshness: {},
  }));

  const aligned = resolveTrackPositions(telemetry, outline, "iracing");
  for (let index = 0; index < outline.length; index++) {
    expect(aligned[index].x).toBeCloseTo(outline[index].x, 3);
    expect(aligned[index].z).toBeCloseTo(outline[index].z, 3);
  }
});

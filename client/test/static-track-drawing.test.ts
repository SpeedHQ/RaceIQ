import { expect, test } from "bun:test";
import { drawStaticTrack } from "../src/components/analyse/track-map/static-drawing";
import { drawPitLines } from "../src/lib/canvas/draw-track";
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

    expect(
      drawStaticTrack({
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
      }),
    ).toEqual({ bufferCanvas: null, transform: null });
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
test("projects telemetry without world coordinates onto the track outline", () => {
  const frame = (fraction: number) => ({
    values: { "motion.position-x": null, "motion.position-z": null, "timing.lap-fraction": fraction },
    states: {},
    freshness: {},
  });
  const outline = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }];

  expect(resolveTrackPositions([frame(0), frame(0.25), frame(0.75), frame(1)], outline)).toEqual([
    { x: 0, z: 0 },
    { x: 50, z: 0 },
    { x: 100, z: 50 },
    { x: 100, z: 100 },
  ]);
});

test("prefers recorded world coordinates over lap-fraction projection", () => {
  const frame = (x: number, z: number, fraction: number) => ({
    values: { "motion.position-x": x, "motion.position-z": z, "timing.lap-fraction": fraction },
    states: {},
    freshness: {},
  });

  expect(resolveTrackPositions(
    [frame(20, 30, 0), frame(40, 50, 1)],
    [{ x: 0, z: 0 }, { x: 100, z: 0 }],
  )).toEqual([{ x: 20, z: 30 }, { x: 40, z: 50 }]);
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
      resolvedPositions: [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
        { x: 3, z: 3 },
      ],
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

test("draws separate solid pit-road and pit-exit lines", () => {
  const strokes: Array<{ color: string; points: number; curves: number; width: number; alpha: number }> = [];
  let points = 0;
  let curves = 0;
  const context = {
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    save() {},
    restore() {},
    beginPath() {
      points = 0;
      curves = 0;
    },
    moveTo() {
      points++;
    },
    lineTo() {
      points++;
    },
    bezierCurveTo() {
      points++;
      curves++;
    },
    stroke() {
      strokes.push({
        color: this.strokeStyle,
        points,
        curves,
        width: this.lineWidth,
        alpha: this.globalAlpha,
      });
    },
  } as unknown as CanvasRenderingContext2D;

  drawPitLines(
    context,
    [
      {
        kind: "pit-road",
        points: [
          { x: 0, z: 0 },
          { x: 1, z: 1 },
          { x: 2, z: 1 },
        ],
      },
      {
        kind: "merge-line",
        points: [
          { x: 3, z: 2 },
          { x: 4, z: 2 },
        ],
      },
    ],
    (x, z) => [x, z],
  );

  expect(strokes).toEqual([
    { color: "var(--track-pit-road)", points: 3, curves: 2, width: 3, alpha: 0.85 },
    { color: "var(--track-pit-exit)", points: 2, curves: 0, width: 3, alpha: 0.85 },
  ]);
  expect(context.lineCap).toBe("round");
  expect(context.lineJoin).toBe("round");
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

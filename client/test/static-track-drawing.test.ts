import { expect, test } from "bun:test";
import { drawStaticTrack } from "../src/components/analyse/track-map/static-drawing";
import { needsTrackFlip } from "../../shared/racing/tracks/coords";
import { initGameAdapters } from "../../shared/games/init";
import type { Point, TrackMapBoundaries, TrackTransform } from "../src/components/analyse/track-map/types";
import { resolveTrackPositions } from "../src/components/analyse/track-map/path";

initGameAdapters();
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

type PathCommand = { kind: "moveTo" | "lineTo" | "arc"; values: number[] } | { kind: "closePath"; values: [] };

interface StrokeRecord {
  color: string;
  alpha: number;
  width: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  commands: PathCommand[];
}

const outlineFixture: Point[] = [
  { x: -4, z: 0 },
  { x: -2, z: 4 },
  { x: 0, z: 0 },
];

function boundaryFixture(raceLine?: Point[] | null, includeRaceLine = true): TrackMapBoundaries {
  const boundaries: TrackMapBoundaries = {
    leftEdge: [
      { x: 4, z: 0 },
      { x: 3, z: 4 },
      { x: 2, z: 0 },
    ],
    rightEdge: [
      { x: 2, z: 0 },
      { x: 1, z: 4 },
      { x: 0, z: 0 },
    ],
    centerLine: [],
    pitLane: null,
    coordSystem: "standard-xyz",
  };
  if (includeRaceLine) boundaries.raceLine = raceLine;
  return boundaries;
}

function createDrawingHarness(): { canvas: HTMLCanvasElement; strokes: StrokeRecord[] } {
  const strokes: StrokeRecord[] = [];
  let commands: PathCommand[] = [];
  const context = {
    strokeStyle: "",
    fillStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    setTransform() {},
    clearRect() {},
    beginPath() {
      commands = [];
    },
    moveTo(x: number, y: number) {
      commands.push({ kind: "moveTo", values: [x, y] });
    },
    lineTo(x: number, y: number) {
      commands.push({ kind: "lineTo", values: [x, y] });
    },
    closePath() {
      commands.push({ kind: "closePath", values: [] });
    },
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
      commands.push({ kind: "arc", values: [x, y, radius, startAngle, endAngle] });
    },
    fill() {},
    stroke() {
      strokes.push({
        color: String(this.strokeStyle),
        alpha: this.globalAlpha,
        width: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        commands: commands.map((command) => ({ ...command, values: [...command.values] }) as PathCommand),
      });
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
  return { canvas, strokes };
}

function drawRaceLineCase(boundaries: TrackMapBoundaries | null, showRaceLine: boolean, gameId: "acc" | "ac-evo" = "acc") {
  const harness = createDrawingHarness();
  const result = drawStaticTrack({
    canvas: harness.canvas,
    bufferCanvas: harness.canvas,
    telemetry: [],
    gameId,
    resolvedPositions: [],
    outline: outlineFixture,
    boundaries,
    sectors: null,
    segments: null,
    showRaceLine,
    showTrace: false,
    rotateWithCar: false,
    zoom: 1,
  });
  expect(harness.strokes.some((stroke) => stroke.color === "var(--track-outline)")).toBe(true);
  return { ...harness, ...result };
}

test("keeps telemetry traces open while closing reference outlines", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const resolvedPositions = [{ x: 1, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 3 }, { x: 4, z: 4 }];
    const trace = createDrawingHarness();
    drawStaticTrack({
      canvas: trace.canvas,
      bufferCanvas: trace.canvas,
      telemetry: [],
      gameId: "acc",
      resolvedPositions,
      outline: outlineFixture,
      boundaries: null,
      sectors: null,
      segments: null,
      showTrace: true,
      rotateWithCar: false,
      zoom: 1,
    });
    const traceStroke = trace.strokes.find((stroke) => stroke.color === "var(--track-outline)")!;
    expect(traceStroke.commands.filter((command) => command.kind === "moveTo")).toHaveLength(1);
    expect(traceStroke.commands.filter((command) => command.kind === "lineTo")).toHaveLength(resolvedPositions.length - 1);

    const reference = createDrawingHarness();
    drawStaticTrack({
      canvas: reference.canvas,
      bufferCanvas: reference.canvas,
      telemetry: [],
      gameId: "acc",
      resolvedPositions: [],
      outline: outlineFixture,
      boundaries: null,
      sectors: null,
      segments: null,
      showTrace: false,
      rotateWithCar: false,
      zoom: 1,
    });
    const referenceStroke = reference.strokes.find((stroke) => stroke.color === "var(--track-outline)")!;
    expect(referenceStroke.commands.filter((command) => command.kind === "lineTo")).toHaveLength(outlineFixture.length);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});


test("draws input, segment, and racing-line overlays together", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const { canvas, strokes } = createDrawingHarness();
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
      gameId: "acc",
      outline: outlineFixture,
      boundaries: boundaryFixture([
        { x: 3.5, z: 1 },
        { x: 2.5, z: 3 },
        { x: 1.5, z: 1 },
      ]),
      sectors: null,
      segments: [{ type: "corner", name: "", startFrac: 0, endFrac: 1 }],
      showInputs: true,
      showRaceLine: true,
      showTrace: true,
      rotateWithCar: false,
      zoom: 1,
    });

    expect(strokes.some((stroke) => stroke.color === "var(--ch-throttle)")).toBe(true);
    expect(strokes.some((stroke) => stroke.color === "var(--track-corner-marker)")).toBe(true);
    expect(strokes.some((stroke) => stroke.color === "var(--track-racing-line)")).toBe(true);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

function projectRaceLinePoint(point: Point, transform: TrackTransform, gameId: "acc" | "ac-evo"): [number, number] {
  const x = needsTrackFlip(gameId) ? -point.x : point.x;
  return [transform.offsetX + (transform.maxX - x) * transform.scale, transform.offsetZ + (point.z - transform.minZ) * transform.scale];
}

test("does not draw available racing-line data while mode is hidden", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const raceLine = [
      { x: 3.5, z: 1 },
      { x: 2.5, z: 3 },
    ];
    const { strokes } = drawRaceLineCase(boundaryFixture(raceLine), false);
    expect(strokes.find((stroke) => stroke.color === "var(--track-racing-line)")).toBeUndefined();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("does not draw missing, null, or one-point racing-line data", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const cases: Array<{ name: string; boundaries: TrackMapBoundaries | null }> = [
      { name: "missing boundaries", boundaries: null },
      { name: "missing field", boundaries: boundaryFixture(undefined, false) },
      { name: "null field", boundaries: boundaryFixture(null) },
      { name: "one point", boundaries: boundaryFixture([{ x: 2, z: 2 }]) },
    ];
    for (const fixture of cases) {
      const { strokes } = drawRaceLineCase(fixture.boundaries, true);
      expect(
        strokes.find((stroke) => stroke.color === "var(--track-racing-line)"),
        fixture.name,
      ).toBeUndefined();
    }
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

for (const gameId of ["acc", "ac-evo"] as const) {
  test(`draws a closed, flipped, transformed ${gameId} racing line`, () => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
    try {
      expect(needsTrackFlip(gameId)).toBe(true);
      const raceLine = [
        { x: 3.5, z: 1 },
        { x: 2.5, z: 3 },
        { x: 1.5, z: 1 },
      ];
      const { strokes, transform } = drawRaceLineCase(boundaryFixture(raceLine), true, gameId);
      expect(transform).not.toBeNull();
      const racingLineStroke = strokes.find((stroke) => stroke.color === "var(--track-racing-line)");
      expect(racingLineStroke).toEqual({
        color: "var(--track-racing-line)",
        alpha: 1,
        width: 2.5,
        lineCap: "round",
        lineJoin: "round",
        commands: [
          { kind: "moveTo", values: projectRaceLinePoint(raceLine[0], transform!, gameId) },
          ...raceLine.slice(1).map((point) => ({ kind: "lineTo" as const, values: projectRaceLinePoint(point, transform!, gameId) })),
          { kind: "closePath", values: [] },
        ],
      });
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });
}

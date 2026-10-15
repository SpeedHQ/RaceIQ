import { afterEach, beforeEach, expect, test } from "bun:test";
import { drawStaticTrack } from "../src/components/analyse/track-map/static-drawing";
import { needsTrackFlip } from "@raceiq/shared/racing/tracks/coords";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import type { Point, TrackMapBoundaries, TrackTransform } from "../src/components/analyse/track-map/types";
import { alignTrackBoundariesToPositions, resolveTrackPositions } from "../src/components/analyse/track-map/path";

let previousPath2D: PropertyDescriptor | undefined;
beforeEach(() => {
  previousPath2D = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
  Object.defineProperty(globalThis, "Path2D", { configurable: true, value: RecordedPath });
});
afterEach(() => {
  if (previousPath2D) Object.defineProperty(globalThis, "Path2D", previousPath2D);
  else Reflect.deleteProperty(globalThis, "Path2D");
});

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
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    expect(
      drawStaticTrack({
        canvas,
        telemetry: [],
        resolvedPositions: [],
        outline: null,
        boundaries: null,
        sectors: null,
        segments: null,
        showTrace: false,
        rotateWithCar: false,
        zoom: 1,
      }).transform,
    ).toBeNull();
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
  const outline = [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
  ];

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

  expect(
    resolveTrackPositions(
      [frame(20, 30, 0), frame(40, 50, 1)],
      [
        { x: 0, z: 0 },
        { x: 100, z: 0 },
      ],
    ),
  ).toEqual([
    { x: 20, z: 30 },
    { x: 40, z: 50 },
  ]);
});


type PathCommand = { kind: "moveTo" | "lineTo" | "arc" | "roundRect"; values: number[] } | { kind: "closePath"; values: [] };

/** Test-only path sink: inspect computed geometry, not native browser rasterization. */
class RecordedPath {
  readonly commands: PathCommand[] = [];
  moveTo(x: number, y: number) { this.commands.push({ kind: "moveTo", values: [x, y] }); }
  lineTo(x: number, y: number) { this.commands.push({ kind: "lineTo", values: [x, y] }); }
  closePath() { this.commands.push({ kind: "closePath", values: [] }); }
  arc(x: number, y: number, radius: number, start: number, end: number) { this.commands.push({ kind: "arc", values: [x, y, radius, start, end] }); }
  roundRect(x: number, y: number, width: number, height: number) { this.commands.push({ kind: "roundRect", values: [x, y, width, height] }); }
}

interface StrokeRecord {
  color: string;
  alpha: number;
  width: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  commands: PathCommand[];
}

interface FillRecord { color: string; commands: PathCommand[] }

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

function createDrawingHarness(): { canvas: HTMLCanvasElement; strokes: StrokeRecord[]; fills: FillRecord[]; texts: string[] } {
  const strokes: StrokeRecord[] = [];
  const fills: FillRecord[] = [];
  const texts: string[] = [];
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
    scale() {},
    setLineDash() {},
    measureText(text: string) { return { width: text.length * 8 }; },
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
    fill(path?: RecordedPath) {
      fills.push({ color: String(this.fillStyle), commands: [...(path?.commands ?? commands)] });
    },
    stroke(path?: RecordedPath) {
      strokes.push({
        color: String(this.strokeStyle),
        alpha: this.globalAlpha,
        width: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        commands: [...(path?.commands ?? commands)],
      });
    },
    save() {},
    restore() {},
    drawImage() {},
    fillText(text: string) { texts.push(text); },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, strokes, fills, texts };
}
test("marks open route endpoints with Start and Finish", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const { canvas, fills, texts } = createDrawingHarness();
    const result = drawStaticTrack({
      canvas,
      telemetry: [],
      gameId: "ac-evo",
      resolvedPositions: [],
      outline: [{ x: 0, z: 0 }, { x: 10, z: 2 }, { x: 20, z: 0 }],
      closed: false,
      boundaries: null,
      sectors: null,
      segments: null,
      showTrace: false,
      rotateWithCar: false,
      zoom: 1,
    });
    const markers = fills.filter(({ commands }) => commands.some(({ kind }) => kind === "arc"));
    expect(markers).toHaveLength(2);
    expect(markers[0]!.color).not.toBe(markers[1]!.color);
    expect(markers[0]!.commands[0]!.values.slice(0, 2)).not.toEqual(markers[1]!.commands[0]!.values.slice(0, 2));
    expect(result.transform).not.toBeNull();
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

function drawRaceLineCase(boundaries: TrackMapBoundaries | null, showRaceLine: boolean, gameId: "acc" | "ac-evo" = "acc") {
  const harness = createDrawingHarness();
  const result = drawStaticTrack({
    canvas: harness.canvas,
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
    const resolvedPositions = [
      { x: 1, z: 1 },
      { x: 2, z: 2 },
      { x: 3, z: 3 },
      { x: 4, z: 4 },
    ];
    const trace = createDrawingHarness();
    drawStaticTrack({
      canvas: trace.canvas,
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

test("places segment overlays on canonical centerline instead of replay trace", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const { canvas, strokes } = createDrawingHarness();
    const centerLine = [
      { x: 0, z: 10 },
      { x: 0, z: 0 },
      { x: 10, z: 0 },
    ];
    const result = drawStaticTrack({
      canvas,
      telemetry: [],
      resolvedPositions: [],
      outline: [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 10 },
      ],
      boundaries: { ...boundaryFixture(), centerLine },
      sectors: null,
      segments: [{ type: "corner", name: "", startFrac: 0, endFrac: 0.5 }],
      showTrace: false,
      rotateWithCar: false,
      zoom: 1,
    });

    const marker = strokes.find((stroke) => stroke.color === "var(--track-corner-marker)");
    expect(marker?.commands[0]).toEqual({
      kind: "moveTo",
      values: [result.transform!.offsetX + result.transform!.maxX * result.transform!.scale, result.transform!.offsetZ + 10 * result.transform!.scale],
    });
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("places sector boundary markers on canonical centerline instead of replay trace", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const { canvas, strokes } = createDrawingHarness();
    const centerLine = Array.from({ length: 11 }, (_, z) => ({ x: 0, z }));
    const result = drawStaticTrack({
      canvas,
      telemetry: [],
      resolvedPositions: [],
      outline: Array.from({ length: 11 }, (_, x) => ({ x, z: 10 })),
      boundaries: { ...boundaryFixture(), centerLine },
      sectors: { sectorCount: 2, sectorStarts: [0, 0.5] },
      segments: null,
      showTrace: false,
      rotateWithCar: false,
      zoom: 1,
    });

    const marker = strokes.find((stroke) => stroke.color === "var(--sector-1)" && stroke.width === 2);
    const markerX = result.transform!.offsetX + result.transform!.maxX * result.transform!.scale;
    const markerY = result.transform!.offsetZ + 5 * result.transform!.scale;
    expect(marker?.commands).toEqual([
      { kind: "moveTo", values: [markerX - 8, markerY] },
      { kind: "lineTo", values: [markerX + 8, markerY] },
    ]);
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
      expect(racingLineStroke?.commands).toEqual([
        { kind: "moveTo", values: projectRaceLinePoint(raceLine[0], transform!, gameId) },
        ...raceLine.slice(1).map((point) => ({ kind: "lineTo" as const, values: projectRaceLinePoint(point, transform!, gameId) })),
        { kind: "closePath", values: [] },
      ]);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });
}

test("aligns LMU boundary geometry to selected lap coordinates", () => {
  const centerLine = Array.from({ length: 80 }, (_, index) => {
    const angle = (index / 80) * Math.PI * 2;
    const radius = 100 + 20 * Math.sin(angle * 3) + 7 * Math.cos(angle * 5);
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.7 };
  });
  const boundaries: TrackMapBoundaries = {
    leftEdge: centerLine.map((point) => ({ x: point.x - 4, z: point.z })),
    rightEdge: centerLine.map((point) => ({ x: point.x + 4, z: point.z })),
    centerLine,
    pitLane: null,
    coordSystem: "lmu",
  };
  const rotation = 0.61;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const positions = centerLine.map((point) => {
    const reflectedX = -point.x;
    return {
      x: 1.2 * (cos * reflectedX - sin * point.z) + 300,
      z: 1.2 * (sin * reflectedX + cos * point.z) - 140,
    };
  });

  const aligned = alignTrackBoundariesToPositions(boundaries, positions);

  expect(aligned).not.toBeNull();
  expect(
    Math.max(
      ...aligned!.centerLine.map((point, index) =>
        Math.hypot(point.x - positions[index].x, point.z - positions[index].z),
      ),
    ),
  ).toBeLessThan(0.001);
});

import { expect, test } from "bun:test";
import { drawStaticTrack } from "../src/components/track-map/static-drawing";
import { applyTrackMapOverlayCamera } from "../src/components/track-map/overlay-drawing";
import { initGameAdapters } from "../../shared/games/init";
import { needsTrackFlip } from "../../shared/racing/tracks/coords";
import { resolveTrackPositions } from "../src/components/track-map/path";
import type { Point, TrackMapBoundaries, TrackTransform } from "../src/components/track-map/types";
import { drawPitLines } from "../src/lib/canvas/draw-track";

initGameAdapters();
test("pans fixed world overlays with the composed map buffer", () => {
  const translations: Array<[number, number]> = [];
  const rotations: number[] = [];
  const context = {
    translate(x: number, y: number) {
      translations.push([x, y]);
    },
    rotate(angle: number) {
      rotations.push(angle);
    },
  } as unknown as CanvasRenderingContext2D;
  const transform: TrackTransform = {
    w: 400,
    h: 200,
    offW: 600,
    offH: 300,
    offsetX: 0,
    offsetZ: 0,
    scale: 1,
    maxX: 0,
    minZ: 0,
    displayOutline: [],
  };

  applyTrackMapOverlayCamera(context, transform, { x: 25, y: -10 }, null, false);

  expect(translations).toEqual([[-75, -60]]);
  expect(rotations).toEqual([]);
});

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
      arc() {},
      fill() {},
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
    const frame = (throttle: number) => ({ values: { "inputs.throttle": throttle, "inputs.brake": 0 }, states: {}, freshness: {} });

    drawStaticTrack({
      canvas,
      bufferCanvas: canvas,
      telemetry: [frame(0.25), frame(0.5), frame(1)],
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
      { color: "var(--ch-throttle)", alpha: 0.35 + 0.5 * 0.65, width: 2 },
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

type PathCommand = { kind: "moveTo" | "lineTo" | "arc"; values: number[] } | { kind: "closePath"; values: [] };

interface StrokeRecord {
  color: string;
  alpha: number;
  width: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  commands: PathCommand[];
  dash?: number[];
}

interface ImageRecord {
  image: CanvasImageSource;
  alpha: number;
  transform: number[];
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

function createDrawingHarness(): { canvas: HTMLCanvasElement; strokes: StrokeRecord[]; images: ImageRecord[]; events: string[] } {
  const strokes: StrokeRecord[] = [];
  const images: ImageRecord[] = [];
  const events: string[] = [];
  const savedStates: Array<{ alpha: number; transform: number[]; dash: number[] }> = [];
  let activeTransform: number[] = [];
  let activeDash: number[] = [];
  let commands: PathCommand[] = [];
  const context = {
    strokeStyle: "",
    fillStyle: "",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    setTransform(...values: number[]) {
      activeTransform = values;
    },
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
    bezierCurveTo(_cp1x: number, _cp1y: number, _cp2x: number, _cp2y: number, x: number, y: number) {
      commands.push({ kind: "lineTo", values: [x, y] });
    },
    closePath() {
      commands.push({ kind: "closePath", values: [] });
    },
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
      commands.push({ kind: "arc", values: [x, y, radius, startAngle, endAngle] });
    },
    fill() {
      events.push(`fill:${String(this.fillStyle)}`);
    },
    stroke() {
      strokes.push({
        color: String(this.strokeStyle),
        alpha: this.globalAlpha,
        width: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        commands: commands.map((command) => ({ ...command, values: [...command.values] }) as PathCommand),
        ...(activeDash.length > 0 ? { dash: [...activeDash] } : {}),
      });
      events.push(`stroke:${String(this.strokeStyle)}`);
    },
    save() {
      savedStates.push({ alpha: this.globalAlpha, transform: [...activeTransform], dash: [...activeDash] });
    },
    translate() {},
    rotate() {},
    setLineDash(values: number[]) {
      activeDash = [...values];
    },
    transform(...values: number[]) {
      activeTransform = values;
    },
    restore() {
      const saved = savedStates.pop();
      if (!saved) return;
      this.globalAlpha = saved.alpha;
      activeTransform = saved.transform;
      activeDash = saved.dash;
    },
    drawImage(image: CanvasImageSource) {
      images.push({ image, alpha: this.globalAlpha, transform: [...activeTransform] });
      events.push("image");
    },
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, strokes, images, events };
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

test("draws input, segment, and racing-line overlays together", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const { canvas, strokes } = createDrawingHarness();
    const frame = (throttle: number) => ({ values: { "inputs.throttle": throttle, "inputs.brake": 0 }, states: {}, freshness: {} });
    drawStaticTrack({
      canvas,
      bufferCanvas: canvas,
      telemetry: [frame(0.25), frame(0.5), frame(1)],
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

test("renders deep zoom as viewport-sized vectors with constant stroke widths", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const harness = createDrawingHarness();
    const result = drawStaticTrack({
      canvas: harness.canvas,
      bufferCanvas: harness.canvas,
      telemetry: [],
      resolvedPositions: [],
      outline: outlineFixture,
      boundaries: null,
      sectors: null,
      segments: null,
      showTrace: false,
      rotateWithCar: false,
      zoom: 32,
      viewportCamera: { panX: 50, panY: -25 },
    });

    expect(result.transform?.offW).toBe(800);
    expect(result.transform?.offH).toBe(600);
    expect(harness.canvas.width).toBe(800);
    expect(harness.canvas.height).toBe(600);
    expect(harness.strokes.find((stroke) => stroke.color === "var(--track-outline)")?.width).toBe(4);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("draws opaque venue base before transparent layout layers", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const harness = createDrawingHarness();
    const base = {} as CanvasImageSource;
    const roadCourse = {} as CanvasImageSource;
    drawStaticTrack({
      canvas: harness.canvas,
      bufferCanvas: harness.canvas,
      telemetry: [],
      resolvedPositions: [],
      outline: outlineFixture,
      imagery: {
        imageToTrack: [100, 0, 0, 80, -50, -40],
        textures: [
          { image: base, opacity: 1 },
          { image: roadCourse, opacity: 0.65 },
        ],
        base: {
          width: 100,
          height: 80,
          tileSize: 100,
          tiles: [],
        },
      },
      boundaries: null,
      sectors: null,
      segments: null,
      showTrace: false,
      rotateWithCar: false,
      zoom: 1,
    });

    expect(harness.images.map(({ image, alpha }) => ({ image, alpha }))).toEqual([
      { image: base, alpha: 1 },
      { image: roadCourse, alpha: 0.65 },
    ]);
    expect(harness.strokes.find((stroke) => stroke.color === "var(--track-outline)")?.alpha).toBe(1);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("draws optional geometry layers in deterministic order with arbitrary native sectors", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const outline = Array.from({ length: 21 }, (_, index) => ({ x: index, z: Math.sin(index / 3) * 2 }));
    const telemetry = outline.map((point, index) => ({
      values: { "motion.position-x": point.x, "motion.position-z": point.z + 0.2, "inputs.throttle": 0, "inputs.brake": 0 },
      states: {},
      freshness: {},
    }));
    const boundaries = boundaryFixture([
      { x: 1, z: 0.5 },
      { x: 10, z: 1 },
      { x: 19, z: 0.5 },
    ]);
    boundaries.pitLane = [
      { x: 2, z: -0.5 },
      { x: 5, z: -0.5 },
    ];
    const baseline = createDrawingHarness();
    const baselineResult = drawStaticTrack({
      canvas: baseline.canvas,
      bufferCanvas: baseline.canvas,
      telemetry,
      resolvedPositions: outline.map((point) => ({ ...point, z: point.z + 0.2 })),
      outline,
      boundaries,
      sectors: null,
      segments: null,
      showOutline: true,
      showTrace: true,
      rotateWithCar: false,
      zoom: 1,
    });
    const harness = createDrawingHarness();
    const texture = {} as CanvasImageSource;
    const result = drawStaticTrack({
      canvas: harness.canvas,
      bufferCanvas: harness.canvas,
      telemetry,
      resolvedPositions: outline.map((point) => ({ ...point, z: point.z + 0.2 })),
      outline,
      boundaries,
      pitLines: [
        {
          kind: "merge-line",
          points: [
            { x: 1, z: -1 },
            { x: 4, z: -1 },
          ],
        },
      ],
      imagery: {
        imageToTrack: [20, 0, 0, 5, 0, -2.5],
        base: { width: 100, height: 100, tileSize: 100, tiles: [] },
        textures: [{ image: texture, opacity: 0.5 }],
      },
      sectors: { sectorStarts: [0, 0.2, 0.5, 0.8], sectorCount: 4 },
      segments: [{ type: "corner", name: "", startFrac: 0.25, endFrac: 0.4 }],
      curbs: [{ side: "left", points: [{ x: 10_000, z: 10_000 }] }],
      highlights: [{ startFrac: 0.6, endFrac: 0.7, color: "warning", label: "Brake" }],
      showOutline: true,
      showRaceLine: true,
      showTrace: true,
      rotateWithCar: false,
      zoom: 1,
    });

    expect(result.transform?.scale).toBe(baselineResult.transform?.scale);
    expect(result.transform?.maxX).toBe(baselineResult.transform?.maxX);
    expect(result.transform?.minZ).toBe(baselineResult.transform?.minZ);
    expect(harness.strokes.find((stroke) => stroke.color === "var(--track-pit-exit)")?.dash).toBeUndefined();
    expect(harness.strokes.find((stroke) => stroke.color === "var(--track-pit-lane)")?.dash).toEqual([6, 4]);
    for (const color of ["var(--sector-1)", "var(--sector-2)", "var(--sector-3)", "var(--sector-4)"]) {
      expect(harness.strokes.some((stroke) => stroke.color === color)).toBe(true);
    }

    const imageIndex = harness.events.indexOf("image");
    const pitIndex = harness.events.indexOf("stroke:var(--track-pit-exit)");
    const outlineIndex = harness.events.indexOf("stroke:var(--track-outline)");
    const racingLineIndex = harness.events.indexOf("stroke:var(--track-racing-line)");
    const sectorIndex = harness.events.indexOf("stroke:var(--sector-1)");
    const segmentIndex = harness.events.indexOf("stroke:var(--track-corner-marker)");
    const curbIndex = harness.events.indexOf("fill:var(--track-curb-left)");
    const traceIndex = harness.events.lastIndexOf("stroke:var(--track-outline)");
    const highlightIndex = harness.events.findIndex((event) => event.startsWith("stroke:color-mix(in srgb, var(--severity-caution)"));
    const startIndex = harness.events.indexOf("fill:var(--track-start)");
    expect([imageIndex, pitIndex, outlineIndex, racingLineIndex, sectorIndex, segmentIndex, curbIndex, traceIndex, highlightIndex, startIndex].every((index) => index >= 0)).toBe(true);
    expect(imageIndex).toBeLessThan(pitIndex);
    expect(pitIndex).toBeLessThan(outlineIndex);
    expect(outlineIndex).toBeLessThan(racingLineIndex);
    expect(racingLineIndex).toBeLessThan(sectorIndex);
    expect(sectorIndex).toBeLessThan(segmentIndex);
    expect(segmentIndex).toBeLessThan(curbIndex);
    expect(curbIndex).toBeLessThan(traceIndex);
    expect(traceIndex).toBeLessThan(highlightIndex);
    expect(highlightIndex).toBeLessThan(startIndex);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

test("keeps telemetry trace separate from hidden outline", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  try {
    const harness = createDrawingHarness();
    const telemetry = Array.from({ length: 12 }, (_, index) => ({
      values: { "motion.position-x": index, "motion.position-z": 0 },
      states: {},
      freshness: {},
    }));
    drawStaticTrack({
      canvas: harness.canvas,
      bufferCanvas: harness.canvas,
      telemetry,
      resolvedPositions: Array.from({ length: 12 }, (_, index) => ({ x: index, z: 0 })),
      outline: Array.from({ length: 12 }, (_, index) => ({ x: index, z: 1 })),
      boundaries: null,
      sectors: null,
      segments: null,
      curbs: [{ side: "right", points: [{ x: 5, z: 0 }] }],
      showOutline: false,
      showTrace: true,
      rotateWithCar: false,
      zoom: 1,
    });

    expect(harness.events.filter((event) => event === "stroke:var(--track-outline)")).toHaveLength(1);
    expect(harness.events.indexOf("fill:var(--track-curb-right)")).toBeLessThan(harness.events.indexOf("stroke:var(--track-outline)"));
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getIRacingTrack } from "../../../shared/iracing-track-data";
import { USER_TRACKS_DIR } from "../../../shared/resolve-data";

export interface IRacingMapPoint {
  x: number;
  z: number;
}

export interface IRacingMapLabel extends IRacingMapPoint {
  text: string;
}

export interface IRacingSvgTrackMap {
  points: IRacingMapPoint[];
  labels: IRacingMapLabel[];
}

interface SvgPoint {
  x: number;
  y: number;
}

interface ParsedPath {
  contours: SvgPoint[][];
}

interface CachedMapFile extends IRacingSvgTrackMap {
  version: 1;
  mapUrl: string;
}

const MAP_CACHE_VERSION = 1;
const SAMPLE_COUNT = 512;
const FETCH_TIMEOUT_MS = 4_000;
const PUBLIC_MAP_PREFIX =
  "https://members-assets.iracing.com/public/track-maps/";
const memoryCache = new Map<number, Promise<IRacingSvgTrackMap | null>>();

function numberTokens(value: string): number[] {
  return (
    value
      .match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)
      ?.map(Number)
      .filter(Number.isFinite) ?? []
  );
}

function pointEquals(a: SvgPoint, b: SvgPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function cubicPoint(
  start: SvgPoint,
  control1: SvgPoint,
  control2: SvgPoint,
  end: SvgPoint,
  amount: number,
): SvgPoint {
  const inverse = 1 - amount;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * amount * control1.x +
      3 * inverse * amount ** 2 * control2.x +
      amount ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * amount * control1.y +
      3 * inverse * amount ** 2 * control2.y +
      amount ** 3 * end.y,
  };
}

function quadraticPoint(
  start: SvgPoint,
  control: SvgPoint,
  end: SvgPoint,
  amount: number,
): SvgPoint {
  const inverse = 1 - amount;
  return {
    x:
      inverse ** 2 * start.x +
      2 * inverse * amount * control.x +
      amount ** 2 * end.x,
    y:
      inverse ** 2 * start.y +
      2 * inverse * amount * control.y +
      amount ** 2 * end.y,
  };
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const denominator = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!(denominator > 0)) return 0;
  const ratio = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator));
  const angle = Math.acos(ratio);
  return ux * vy - uy * vx < 0 ? -angle : angle;
}

/** Flatten one SVG elliptical arc using the endpoint-to-center algorithm. */
function arcPoints(
  start: SvgPoint,
  rxValue: number,
  ryValue: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  end: SvgPoint,
): SvgPoint[] {
  if (
    pointEquals(start, end) ||
    !(Math.abs(rxValue) > 0) ||
    !(Math.abs(ryValue) > 0)
  ) {
    return [end];
  }

  let rx = Math.abs(rxValue);
  let ry = Math.abs(ryValue);
  const phi = (rotationDegrees * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;

  const scale =
    xPrime ** 2 / rx ** 2 +
    yPrime ** 2 / ry ** 2;
  if (scale > 1) {
    const factor = Math.sqrt(scale);
    rx *= factor;
    ry *= factor;
  }

  const numerator = Math.max(
    0,
    rx ** 2 * ry ** 2 -
      rx ** 2 * yPrime ** 2 -
      ry ** 2 * xPrime ** 2,
  );
  const denominator =
    rx ** 2 * yPrime ** 2 +
    ry ** 2 * xPrime ** 2;
  const sign = largeArc === sweep ? -1 : 1;
  const coefficient =
    denominator > 0 ? sign * Math.sqrt(numerator / denominator) : 0;
  const cxPrime = coefficient * ((rx * yPrime) / ry);
  const cyPrime = coefficient * (-(ry * xPrime) / rx);
  const centerX =
    cosPhi * cxPrime -
    sinPhi * cyPrime +
    (start.x + end.x) / 2;
  const centerY =
    sinPhi * cxPrime +
    cosPhi * cyPrime +
    (start.y + end.y) / 2;

  const startVector = {
    x: (xPrime - cxPrime) / rx,
    y: (yPrime - cyPrime) / ry,
  };
  const endVector = {
    x: (-xPrime - cxPrime) / rx,
    y: (-yPrime - cyPrime) / ry,
  };
  const startAngle = vectorAngle(1, 0, startVector.x, startVector.y);
  let deltaAngle = vectorAngle(
    startVector.x,
    startVector.y,
    endVector.x,
    endVector.y,
  );
  if (!sweep && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweep && deltaAngle < 0) deltaAngle += Math.PI * 2;

  const steps = Math.max(4, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 12)));
  const result: SvgPoint[] = [];
  for (let index = 1; index <= steps; index++) {
    const angle = startAngle + (deltaAngle * index) / steps;
    result.push({
      x:
        centerX +
        cosPhi * rx * Math.cos(angle) -
        sinPhi * ry * Math.sin(angle),
      y:
        centerY +
        sinPhi * rx * Math.cos(angle) +
        cosPhi * ry * Math.sin(angle),
    });
  }
  return result;
}

/**
 * Parse and flatten the commands used by iRacing's Illustrator-exported map
 * layers. Keeping this server-side turns the filled active-layer ribbon into
 * ordered points that every existing RaceIQ canvas can consume.
 */
function parsePathData(pathData: string): ParsedPath {
  const tokens =
    pathData.match(
      /[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi,
    ) ?? [];
  const contours: SvgPoint[][] = [];
  let contour: SvgPoint[] | null = null;
  let index = 0;
  let command = "";
  let current = { x: 0, y: 0 };
  let contourStart = { x: 0, y: 0 };
  let lastCubicControl: SvgPoint | null = null;
  let lastQuadraticControl: SvgPoint | null = null;

  const isCommand = (token: string | undefined) =>
    token != null && /^[a-zA-Z]$/.test(token);
  const hasNumbers = (count: number) =>
    index + count <= tokens.length &&
    !tokens.slice(index, index + count).some(isCommand);
  const take = () => Number(tokens[index++]);
  const absolutePoint = (
    x: number,
    y: number,
    relative: boolean,
  ): SvgPoint =>
    relative
      ? { x: current.x + x, y: current.y + y }
      : { x, y };
  const append = (point: SvgPoint) => {
    if (!contour) {
      contour = [current];
      contours.push(contour);
    }
    contour.push(point);
    current = point;
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) break;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    if (upper === "Z") {
      if (contour && !pointEquals(contour.at(-1)!, contourStart)) {
        contour.push({ ...contourStart });
      }
      current = { ...contourStart };
      contour = null;
      lastCubicControl = null;
      lastQuadraticControl = null;
      command = "";
      continue;
    }

    if (upper === "M") {
      if (!hasNumbers(2)) break;
      const next = absolutePoint(take(), take(), relative);
      current = next;
      contourStart = { ...next };
      contour = [next];
      contours.push(contour);
      lastCubicControl = null;
      lastQuadraticControl = null;
      command = relative ? "l" : "L";
      continue;
    }

    if (upper === "L" && hasNumbers(2)) {
      append(absolutePoint(take(), take(), relative));
    } else if (upper === "H" && hasNumbers(1)) {
      const x = take();
      append({ x: relative ? current.x + x : x, y: current.y });
    } else if (upper === "V" && hasNumbers(1)) {
      const y = take();
      append({ x: current.x, y: relative ? current.y + y : y });
    } else if (upper === "C" && hasNumbers(6)) {
      const start = current;
      const control1 = absolutePoint(take(), take(), relative);
      const control2 = absolutePoint(take(), take(), relative);
      const end = absolutePoint(take(), take(), relative);
      for (let step = 1; step <= 10; step++) {
        append(cubicPoint(start, control1, control2, end, step / 10));
      }
      lastCubicControl = control2;
      lastQuadraticControl = null;
    } else if (upper === "S" && hasNumbers(4)) {
      const start = current;
      const control1 = lastCubicControl
        ? {
            x: start.x * 2 - lastCubicControl.x,
            y: start.y * 2 - lastCubicControl.y,
          }
        : start;
      const control2 = absolutePoint(take(), take(), relative);
      const end = absolutePoint(take(), take(), relative);
      for (let step = 1; step <= 10; step++) {
        append(cubicPoint(start, control1, control2, end, step / 10));
      }
      lastCubicControl = control2;
      lastQuadraticControl = null;
    } else if (upper === "Q" && hasNumbers(4)) {
      const start = current;
      const control = absolutePoint(take(), take(), relative);
      const end = absolutePoint(take(), take(), relative);
      for (let step = 1; step <= 10; step++) {
        append(quadraticPoint(start, control, end, step / 10));
      }
      lastQuadraticControl = control;
      lastCubicControl = null;
    } else if (upper === "T" && hasNumbers(2)) {
      const start = current;
      const control: SvgPoint = lastQuadraticControl
        ? {
            x: start.x * 2 - lastQuadraticControl.x,
            y: start.y * 2 - lastQuadraticControl.y,
          }
        : start;
      const end = absolutePoint(take(), take(), relative);
      for (let step = 1; step <= 10; step++) {
        append(quadraticPoint(start, control, end, step / 10));
      }
      lastQuadraticControl = control;
      lastCubicControl = null;
    } else if (upper === "A" && hasNumbers(7)) {
      const start = current;
      const rx = take();
      const ry = take();
      const rotation = take();
      const largeArc = take() !== 0;
      const sweep = take() !== 0;
      const end = absolutePoint(take(), take(), relative);
      for (const point of arcPoints(
        start,
        rx,
        ry,
        rotation,
        largeArc,
        sweep,
        end,
      )) {
        append(point);
      }
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else {
      // A malformed or unsupported command must not spin forever.
      break;
    }

    if (upper !== "C" && upper !== "S") lastCubicControl = null;
    if (upper !== "Q" && upper !== "T") lastQuadraticControl = null;
  }

  return {
    contours: contours.filter((points) => points.length >= 2),
  };
}

function extractPathData(svg: string): string[] {
  const result: string[] = [];
  for (const match of svg.matchAll(/<path\b[^>]*\sd=(["'])([\s\S]*?)\1/gi)) {
    result.push(match[2]);
  }
  return result;
}

function allContours(svg: string): SvgPoint[][] {
  return extractPathData(svg).flatMap(
    (pathData) => parsePathData(pathData).contours,
  );
}

function closedPerimeter(points: readonly SvgPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    total += Math.hypot(
      next.x - points[index].x,
      next.y - points[index].y,
    );
  }
  return total;
}

function resampleClosed(
  pointsValue: readonly SvgPoint[],
  count: number,
): SvgPoint[] {
  const points =
    pointsValue.length > 1 &&
    pointEquals(pointsValue[0], pointsValue.at(-1)!)
      ? pointsValue.slice(0, -1)
      : [...pointsValue];
  if (points.length < 2) return [];

  const cumulative = [0];
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    cumulative.push(
      cumulative[index] +
        Math.hypot(next.x - points[index].x, next.y - points[index].y),
    );
  }
  const total = cumulative.at(-1)!;
  if (!(total > 0)) return [];

  const sampled: SvgPoint[] = [];
  let segment = 0;
  for (let index = 0; index < count; index++) {
    const target = (index / count) * total;
    while (
      segment + 1 < cumulative.length - 1 &&
      cumulative[segment + 1] < target
    ) {
      segment++;
    }
    const start = points[segment % points.length];
    const end = points[(segment + 1) % points.length];
    const length = cumulative[segment + 1] - cumulative[segment];
    const amount =
      length > 0 ? (target - cumulative[segment]) / length : 0;
    sampled.push({
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    });
  }
  return sampled;
}

function alignmentCost(
  first: readonly SvgPoint[],
  second: readonly SvgPoint[],
  shift: number,
): number {
  let total = 0;
  const stride = 4;
  for (let index = 0; index < first.length; index += stride) {
    const candidate = second[(index + shift) % second.length];
    const dx = first[index].x - candidate.x;
    const dy = first[index].y - candidate.y;
    total += dx * dx + dy * dy;
  }
  return total;
}

function alignBoundary(
  first: readonly SvgPoint[],
  secondValue: readonly SvgPoint[],
): SvgPoint[] {
  const variants = [
    [...secondValue],
    [...secondValue].reverse(),
  ];
  let best = variants[0];
  let bestShift = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const variant of variants) {
    for (let shift = 0; shift < variant.length; shift++) {
      const cost = alignmentCost(first, variant, shift);
      if (cost < bestCost) {
        bestCost = cost;
        best = variant;
        bestShift = shift;
      }
    }
  }
  return best.map((_, index) => best[(index + bestShift) % best.length]);
}

function nearestPointIndex(
  points: readonly SvgPoint[],
  targets: readonly SvgPoint[],
): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index++) {
    for (const target of targets) {
      const dx = points[index].x - target.x;
      const dy = points[index].y - target.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  }
  return bestIndex;
}

function rotateToIndex<T>(values: readonly T[], index: number): T[] {
  return [...values.slice(index), ...values.slice(0, index)];
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

export function parseIRacingTurnLabels(svg: string): IRacingMapLabel[] {
  const labels: IRacingMapLabel[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = match[1];
    const text = decodeXmlText(match[2].replace(/<[^>]+>/g, ""));
    if (!text) continue;

    const transform = attributes.match(
      /\btransform=(["'])matrix\(([^)]+)\)\1/i,
    );
    const matrix = transform ? numberTokens(transform[2]) : [];
    const xMatch = attributes.match(/\bx=(["'])(.*?)\1/i);
    const yMatch = attributes.match(/\by=(["'])(.*?)\1/i);
    const x = matrix.length >= 6
      ? matrix[4]
      : xMatch
        ? numberTokens(xMatch[2])[0]
        : Number.NaN;
    const y = matrix.length >= 6
      ? matrix[5]
      : yMatch
        ? numberTokens(yMatch[2])[0]
        : Number.NaN;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      labels.push({ text, x: -x, z: y });
    }
  }
  return labels;
}

/**
 * Convert iRacing's filled SVG track ribbon into a centerline. The two longest
 * closed contours are the ribbon edges; sampling and averaging them produces
 * a stable line suitable for LapDistPct projection.
 */
export function parseIRacingActiveSvg(
  activeSvg: string,
  startFinishSvg?: string | null,
  turnsSvg?: string | null,
): IRacingSvgTrackMap | null {
  const contours = allContours(activeSvg)
    .filter((points) => points.length >= 4)
    .sort((a, b) => closedPerimeter(b) - closedPerimeter(a));
  if (contours.length === 0) return null;

  const first = resampleClosed(contours[0], SAMPLE_COUNT);
  if (first.length !== SAMPLE_COUNT) return null;
  let centerline = first;
  if (contours.length >= 2) {
    const second = resampleClosed(contours[1], SAMPLE_COUNT);
    if (second.length === SAMPLE_COUNT) {
      const aligned = alignBoundary(first, second);
      centerline = first.map((point, index) => ({
        x: (point.x + aligned[index].x) / 2,
        y: (point.y + aligned[index].y) / 2,
      }));
    }
  }

  if (startFinishSvg) {
    const markerPoints = allContours(startFinishSvg).flat();
    if (markerPoints.length > 0) {
      centerline = rotateToIndex(
        centerline,
        nearestPointIndex(centerline, markerPoints),
      );
    }
  }

  const rawLabels = turnsSvg ? parseIRacingTurnLabels(turnsSvg) : [];
  const numericLabels = rawLabels
    .filter((label) => /^\d+$/.test(label.text))
    .sort((a, b) => Number(a.text) - Number(b.text))
    .slice(0, 2)
    .map((label) => ({ x: -label.x, y: label.z }));
  if (
    numericLabels.length === 2 &&
    nearestPointIndex(centerline, [numericLabels[0]]) >
      nearestPointIndex(centerline, [numericLabels[1]])
  ) {
    centerline = [centerline[0], ...centerline.slice(1).reverse()];
  }

  return {
    // RaceIQ's canvases mirror X when converting world coordinates to screen
    // pixels. Negating SVG X here preserves iRacing's published orientation.
    points: centerline.map((point) => ({ x: -point.x, z: point.y })),
    labels: rawLabels,
  };
}

function cachePath(ordinal: number): string {
  return resolve(
    USER_TRACKS_DIR,
    "iracing",
    "official-svg",
    `${ordinal}.json`,
  );
}

function readCachedMap(
  ordinal: number,
  mapUrl: string,
): IRacingSvgTrackMap | null {
  const path = cachePath(ordinal);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedMapFile;
    return parsed.version === MAP_CACHE_VERSION &&
      parsed.mapUrl === mapUrl &&
      Array.isArray(parsed.points) &&
      parsed.points.length >= 20
      ? { points: parsed.points, labels: parsed.labels ?? [] }
      : null;
  } catch {
    return null;
  }
}

function writeCachedMap(
  ordinal: number,
  mapUrl: string,
  map: IRacingSvgTrackMap,
): void {
  const path = cachePath(ordinal);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: MAP_CACHE_VERSION,
        mapUrl,
        ...map,
      } satisfies CachedMapFile),
    );
  } catch (error) {
    console.warn(
      `[iRacing Map] Could not cache track ${ordinal}:`,
      error,
    );
  }
}

async function fetchSvg(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "RaceIQ iRacing track map" },
      signal: controller.signal,
    });
    return response.ok ? response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadMap(ordinal: number): Promise<IRacingSvgTrackMap | null> {
  const track = getIRacingTrack(ordinal);
  const mapUrl = track?.mapUrl ?? "";
  if (!mapUrl.startsWith(PUBLIC_MAP_PREFIX)) return null;

  const cached = readCachedMap(ordinal, mapUrl);
  if (cached) return cached;

  const layerUrl = (name: string) =>
    new URL(name, mapUrl).href;
  const [activeSvg, startFinishSvg, turnsSvg] = await Promise.all([
    fetchSvg(mapUrl),
    fetchSvg(layerUrl("start-finish.svg")),
    fetchSvg(layerUrl("turns.svg")),
  ]);
  if (!activeSvg) return null;
  const map = parseIRacingActiveSvg(
    activeSvg,
    startFinishSvg,
    turnsSvg,
  );
  if (map) writeCachedMap(ordinal, mapUrl, map);
  return map;
}

/** Resolve and memoize one exact iRacing layout's official SVG map. */
export function getIRacingSvgTrackMap(
  ordinal: number,
): Promise<IRacingSvgTrackMap | null> {
  const existing = memoryCache.get(ordinal);
  if (existing) return existing;
  const pending = loadMap(ordinal);
  memoryCache.set(ordinal, pending);
  pending.then((map) => {
    // Do not pin transient network failures for the lifetime of the server.
    if (!map) memoryCache.delete(ordinal);
  });
  return pending;
}

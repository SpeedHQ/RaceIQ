import type { NamedSegment } from "../../../shared/racing/tracks/named-segments";

export interface IRacingMapPoint {
  x: number;
  z: number;
}

export interface IRacingMapLabel extends IRacingMapPoint {
  text: string;
}
export type IRacingPitLineKind = "pit-road" | "merge-line";

export interface IRacingPitLine {
  kind: IRacingPitLineKind;
  points: IRacingMapPoint[];
}

export interface IRacingSvgTrackMap {
  points: IRacingMapPoint[];
  labels: IRacingMapLabel[];
  /** Solid centerlines reconstructed from iRacing's official pitroad.svg markers. */
  pitLines: IRacingPitLine[];
}

export interface IRacingTurnAnchor {
  number: number;
  fraction: number;
}

/** Project official numbered labels onto lap fractions along the parsed centerline. */
export function projectIRacingTurnAnchors(points: readonly IRacingMapPoint[], labels: readonly IRacingMapLabel[]): IRacingTurnAnchor[] {
  if (points.length < 2 || labels.length === 0) return [];

  const cumulativeDistance = new Float64Array(points.length);
  for (let index = 1; index < points.length; index++) {
    cumulativeDistance[index] = cumulativeDistance[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
  }
  const totalDistance = cumulativeDistance[points.length - 1];
  if (!(totalDistance > 0)) return [];

  const anchors: IRacingTurnAnchor[] = [];
  for (const label of labels) {
    const match = label.text.match(/^(?:T)?(\d+)$/i);
    if (!match) continue;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index++) {
      const distance = (points[index].x - label.x) ** 2 + (points[index].z - label.z) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    anchors.push({
      number: Number(match[1]),
      fraction: cumulativeDistance[nearestIndex] / totalDistance,
    });
  }
  anchors.sort((left, right) => left.fraction - right.fraction);
  return anchors;
}

/**
 * Official iRacing maps label every numbered turn, while curvature detection
 * can merge adjacent turns into one corner region. Split those regions at the
 * midpoint between official labels so segment lists and map labels agree.
 */
export function alignIRacingAutoSegmentsToTurnLabels(segments: NamedSegment[], points: readonly IRacingMapPoint[], labels: readonly IRacingMapLabel[]): NamedSegment[] {
  if (segments.length === 0) return segments;
  const anchors = projectIRacingTurnAnchors(points, labels);
  if (anchors.length === 0) return segments;

  const aligned: NamedSegment[] = [];
  for (const segment of segments) {
    if (segment.type !== "corner") {
      aligned.push(segment);
      continue;
    }
    const contained = anchors.filter((anchor) => anchor.fraction >= segment.startFrac && anchor.fraction <= segment.endFrac);
    if (contained.length === 0) {
      aligned.push(segment);
      continue;
    }
    for (let index = 0; index < contained.length; index++) {
      const anchor = contained[index];
      aligned.push({
        ...segment,
        name: `T${anchor.number}`,
        number: anchor.number,
        startFrac: index === 0 ? segment.startFrac : (contained[index - 1].fraction + anchor.fraction) / 2,
        endFrac: index === contained.length - 1 ? segment.endFrac : (anchor.fraction + contained[index + 1].fraction) / 2,
      });
    }
  }
  return aligned;
}

interface SvgPoint {
  x: number;
  y: number;
}

interface ParsedPath {
  contours: SvgPoint[][];
}

const SAMPLE_COUNT = 512;

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

function cubicPoint(start: SvgPoint, control1: SvgPoint, control2: SvgPoint, end: SvgPoint, amount: number): SvgPoint {
  const inverse = 1 - amount;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * amount * control1.x + 3 * inverse * amount ** 2 * control2.x + amount ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * amount * control1.y + 3 * inverse * amount ** 2 * control2.y + amount ** 3 * end.y,
  };
}

function quadraticPoint(start: SvgPoint, control: SvgPoint, end: SvgPoint, amount: number): SvgPoint {
  const inverse = 1 - amount;
  return {
    x: inverse ** 2 * start.x + 2 * inverse * amount * control.x + amount ** 2 * end.x,
    y: inverse ** 2 * start.y + 2 * inverse * amount * control.y + amount ** 2 * end.y,
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
function arcPoints(start: SvgPoint, rxValue: number, ryValue: number, rotationDegrees: number, largeArc: boolean, sweep: boolean, end: SvgPoint): SvgPoint[] {
  if (pointEquals(start, end) || !(Math.abs(rxValue) > 0) || !(Math.abs(ryValue) > 0)) {
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

  const scale = xPrime ** 2 / rx ** 2 + yPrime ** 2 / ry ** 2;
  if (scale > 1) {
    const factor = Math.sqrt(scale);
    rx *= factor;
    ry *= factor;
  }

  const numerator = Math.max(0, rx ** 2 * ry ** 2 - rx ** 2 * yPrime ** 2 - ry ** 2 * xPrime ** 2);
  const denominator = rx ** 2 * yPrime ** 2 + ry ** 2 * xPrime ** 2;
  const sign = largeArc === sweep ? -1 : 1;
  const coefficient = denominator > 0 ? sign * Math.sqrt(numerator / denominator) : 0;
  const cxPrime = coefficient * ((rx * yPrime) / ry);
  const cyPrime = coefficient * (-(ry * xPrime) / rx);
  const centerX = cosPhi * cxPrime - sinPhi * cyPrime + (start.x + end.x) / 2;
  const centerY = sinPhi * cxPrime + cosPhi * cyPrime + (start.y + end.y) / 2;

  const startVector = {
    x: (xPrime - cxPrime) / rx,
    y: (yPrime - cyPrime) / ry,
  };
  const endVector = {
    x: (-xPrime - cxPrime) / rx,
    y: (-yPrime - cyPrime) / ry,
  };
  const startAngle = vectorAngle(1, 0, startVector.x, startVector.y);
  let deltaAngle = vectorAngle(startVector.x, startVector.y, endVector.x, endVector.y);
  if (!sweep && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweep && deltaAngle < 0) deltaAngle += Math.PI * 2;

  const steps = Math.max(4, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 12)));
  const result: SvgPoint[] = [];
  for (let index = 1; index <= steps; index++) {
    const angle = startAngle + (deltaAngle * index) / steps;
    result.push({
      x: centerX + cosPhi * rx * Math.cos(angle) - sinPhi * ry * Math.sin(angle),
      y: centerY + sinPhi * rx * Math.cos(angle) + cosPhi * ry * Math.sin(angle),
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
  const tokens = pathData.match(/[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const contours: SvgPoint[][] = [];
  let contour: SvgPoint[] | null = null;
  let index = 0;
  let command = "";
  let current = { x: 0, y: 0 };
  let contourStart = { x: 0, y: 0 };
  let lastCubicControl: SvgPoint | null = null;
  let lastQuadraticControl: SvgPoint | null = null;

  const isCommand = (token: string | undefined) => token != null && /^[a-zA-Z]$/.test(token);
  const hasNumbers = (count: number) => index + count <= tokens.length && !tokens.slice(index, index + count).some(isCommand);
  const take = () => Number(tokens[index++]);
  const absolutePoint = (x: number, y: number, relative: boolean): SvgPoint => (relative ? { x: current.x + x, y: current.y + y } : { x, y });
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
      for (const point of arcPoints(start, rx, ry, rotation, largeArc, sweep, end)) {
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
  return extractPathData(svg).flatMap((pathData) => parsePathData(pathData).contours);
}

type PitPathHint = IRacingPitLineKind | "ignore" | null;

function svgAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}=(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function pitPathHintFromName(value: string | null): PitPathHint {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, "");
  if (normalized.includes("joker")) return "ignore";
  if (normalized.includes("merge")) return "merge-line";
  if (normalized.includes("pit")) return "pit-road";
  return null;
}

function pitPathHintFromColor(value: string | null): PitPathHint {
  switch (value?.toLowerCase()) {
    case "#016699":
    case "#0089ba":
      return "merge-line";
    case "#d82520":
    case "#d32222":
      return "pit-road";
    case "#ff9100":
      return "ignore";
    default:
      return null;
  }
}

function pitPathContours(svg: string): Record<IRacingPitLineKind, SvgPoint[][]> {
  const classFills = new Map<string, string>();
  for (const match of svg.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/gi)) {
    const fill = match[2].match(/\bfill\s*:\s*(#[\da-f]{6})/i)?.[1];
    if (fill) classFills.set(match[1], fill);
  }

  const contours: Record<IRacingPitLineKind, SvgPoint[][]> = {
    "pit-road": [],
    "merge-line": [],
  };
  const groupHints: PitPathHint[] = [];
  for (const match of svg.matchAll(/<\/?g\b[^>]*>|<path\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^<\/g/i.test(tag)) {
      groupHints.pop();
      continue;
    }
    if (/^<g\b/i.test(tag)) {
      const ownHint = pitPathHintFromName(svgAttribute(tag, "id"));
      groupHints.push(ownHint ?? groupHints.at(-1) ?? null);
      continue;
    }

    const pathData = svgAttribute(tag, "d");
    if (!pathData) continue;
    const ownHint = pitPathHintFromName(svgAttribute(tag, "id"));
    const groupHint = groupHints.at(-1) ?? null;
    const directFill = svgAttribute(tag, "fill") ?? svgAttribute(tag, "style")?.match(/\bfill\s*:\s*(#[\da-f]{6})/i)?.[1] ?? null;
    const classHint =
      (svgAttribute(tag, "class") ?? "")
        .split(/\s+/)
        .map((className) => pitPathHintFromColor(classFills.get(className) ?? null))
        .find((hint) => hint !== null) ?? null;
    const hint = ownHint ?? groupHint ?? pitPathHintFromColor(directFill) ?? classHint ?? "pit-road";
    if (hint === "ignore") continue;
    contours[hint].push(...parsePathData(pathData).contours.filter((points) => points.length >= 3 && closedPerimeter(points) > 0));
  }
  return contours;
}

interface PitMarker {
  center: SvgPoint;
  diagonal: number;
  elongation: number;
}

function pitMarker(contour: readonly SvgPoint[]): PitMarker {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of contour) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of contour) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const discriminant = Math.hypot(xx - yy, 2 * xy);
  const major = Math.max(0, (xx + yy + discriminant) / 2);
  const minor = Math.max(0, (xx + yy - discriminant) / 2);
  return {
    center,
    diagonal: Math.hypot(maxX - minX, maxY - minY),
    elongation: minor > 0 ? Math.sqrt(major / minor) : Number.POSITIVE_INFINITY,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function connectPitMarkers(markersValue: readonly PitMarker[]): SvgPoint[][] {
  if (markersValue.length < 2) return [];
  const medianDiagonal = median(markersValue.map((marker) => marker.diagonal));
  const markers = markersValue.filter((marker) => markersValue.length < 4 || marker.elongation >= 2 || marker.diagonal <= medianDiagonal * 1.3);
  if (markers.length < 2) return [];

  const nearestDistances = markers.map((marker, index) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (let other = 0; other < markers.length; other++) {
      if (other === index) continue;
      nearest = Math.min(nearest, Math.hypot(marker.center.x - markers[other].center.x, marker.center.y - markers[other].center.y));
    }
    return nearest;
  });
  const maxGap = median(nearestDistances) * 2.5;
  const remaining = new Set(markers.map((_, index) => index));
  const lines: SvgPoint[][] = [];

  while (remaining.size > 0) {
    let seed = -1;
    let seedNeighbors = Number.POSITIVE_INFINITY;
    for (const candidate of remaining) {
      let neighbors = 0;
      for (const index of remaining) {
        if (index !== candidate && Math.hypot(markers[candidate].center.x - markers[index].center.x, markers[candidate].center.y - markers[index].center.y) <= maxGap) {
          neighbors++;
        }
      }
      if (
        neighbors < seedNeighbors ||
        (neighbors === seedNeighbors &&
          (seed < 0 || markers[candidate].center.x < markers[seed].center.x || (markers[candidate].center.x === markers[seed].center.x && markers[candidate].center.y < markers[seed].center.y)))
      ) {
        seed = candidate;
        seedNeighbors = neighbors;
      }
    }
    remaining.delete(seed);
    const line = [markers[seed].center];

    while (remaining.size > 0) {
      let bestIndex = -1;
      let bestAtStart = false;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const index of remaining) {
        const toStart = Math.hypot(line[0].x - markers[index].center.x, line[0].y - markers[index].center.y);
        const toEnd = Math.hypot(line.at(-1)!.x - markers[index].center.x, line.at(-1)!.y - markers[index].center.y);
        const distance = Math.min(toStart, toEnd);
        if (distance < bestDistance) {
          bestIndex = index;
          bestAtStart = toStart < toEnd;
          bestDistance = distance;
        }
      }
      if (bestIndex < 0 || bestDistance > maxGap) break;
      remaining.delete(bestIndex);
      if (bestAtStart) line.unshift(markers[bestIndex].center);
      else line.push(markers[bestIndex].center);
    }
    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

/** Reconstruct solid, arrowless centerlines from iRacing's dashed pit markers. */
export function parseIRacingPitRoadSvg(svg: string): IRacingPitLine[] {
  const contours = pitPathContours(svg);
  return (["pit-road", "merge-line"] as const).flatMap((kind) =>
    connectPitMarkers(contours[kind].map(pitMarker)).map((points) => ({
      kind,
      points: points.map((point) => ({ x: -point.x, z: point.y })),
    })),
  );
}

function closedPerimeter(points: readonly SvgPoint[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    total += Math.hypot(next.x - points[index].x, next.y - points[index].y);
  }
  return total;
}

function resampleClosed(pointsValue: readonly SvgPoint[], count: number): SvgPoint[] {
  const points = pointsValue.length > 1 && pointEquals(pointsValue[0], pointsValue.at(-1)!) ? pointsValue.slice(0, -1) : [...pointsValue];
  if (points.length < 2) return [];

  const cumulative = [0];
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    cumulative.push(cumulative[index] + Math.hypot(next.x - points[index].x, next.y - points[index].y));
  }
  const total = cumulative.at(-1)!;
  if (!(total > 0)) return [];

  const sampled: SvgPoint[] = [];
  let segment = 0;
  for (let index = 0; index < count; index++) {
    const target = (index / count) * total;
    while (segment + 1 < cumulative.length - 1 && cumulative[segment + 1] < target) {
      segment++;
    }
    const start = points[segment % points.length];
    const end = points[(segment + 1) % points.length];
    const length = cumulative[segment + 1] - cumulative[segment];
    const amount = length > 0 ? (target - cumulative[segment]) / length : 0;
    sampled.push({
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    });
  }
  return sampled;
}

function alignmentCost(first: readonly SvgPoint[], second: readonly SvgPoint[], shift: number): number {
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

function alignBoundary(first: readonly SvgPoint[], secondValue: readonly SvgPoint[]): SvgPoint[] {
  const variants = [[...secondValue], [...secondValue].reverse()];
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

function nearestPointIndex(points: readonly SvgPoint[], targets: readonly SvgPoint[]): number {
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
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").trim();
}

export function parseIRacingTurnLabels(svg: string): IRacingMapLabel[] {
  const labels: IRacingMapLabel[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = match[1];
    const text = decodeXmlText(match[2].replace(/<[^>]+>/g, ""));
    if (!text) continue;

    const matrixTransform = attributes.match(/\btransform=(["'])matrix\(([^)]+)\)\1/i);
    const translateTransform = attributes.match(/\btransform=(["'])translate\(([^)]+)\)\1/i);
    const matrix = matrixTransform ? numberTokens(matrixTransform[2]) : [];
    const translation = translateTransform ? numberTokens(translateTransform[2]) : [];
    const xMatch = attributes.match(/\bx=(["'])(.*?)\1/i);
    const yMatch = attributes.match(/\by=(["'])(.*?)\1/i);
    const x = matrix.length >= 6 ? matrix[4] : translation.length >= 2 ? translation[0] : xMatch ? numberTokens(xMatch[2])[0] : Number.NaN;
    const y = matrix.length >= 6 ? matrix[5] : translation.length >= 2 ? translation[1] : yMatch ? numberTokens(yMatch[2])[0] : Number.NaN;
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
export function parseIRacingActiveSvg(activeSvg: string, startFinishSvg?: string | null, turnsSvg?: string | null, pitRoadSvg?: string | null): IRacingSvgTrackMap | null {
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
      centerline = rotateToIndex(centerline, nearestPointIndex(centerline, markerPoints));
    }
  }

  const rawLabels = turnsSvg ? parseIRacingTurnLabels(turnsSvg) : [];
  const numericLabels = rawLabels
    .filter((label) => /^\d+$/.test(label.text))
    .sort((a, b) => Number(a.text) - Number(b.text))
    .slice(0, 2)
    .map((label) => ({ x: -label.x, y: label.z }));
  if (numericLabels.length === 2 && nearestPointIndex(centerline, [numericLabels[0]]) > nearestPointIndex(centerline, [numericLabels[1]])) {
    centerline = [centerline[0], ...centerline.slice(1).reverse()];
  }

  return {
    // RaceIQ's canvases mirror X when converting world coordinates to screen
    // pixels. Negating SVG X here preserves iRacing's published orientation.
    points: centerline.map((point) => ({ x: -point.x, z: point.y })),
    labels: rawLabels,
    pitLines: pitRoadSvg ? parseIRacingPitRoadSvg(pitRoadSvg) : [],
  };
}

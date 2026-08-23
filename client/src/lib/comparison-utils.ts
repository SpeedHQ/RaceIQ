import type { SemanticTelemetrySample } from "@shared/racing/comparison/types";
import { COMPARISON_COLOR_VARS } from "@/lib/colors";
const v = (p: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): any => p.values[id];
const num = (p: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): number | undefined => {
  const x = v(p, id);
  return typeof x === "number" ? x : undefined;
};

export const COLOR_A = "var(--comparison-lap-a)";
export const COLOR_B = "var(--comparison-lap-b)";

export const MAX_COMPARISON_LAPS = COMPARISON_COLOR_VARS.length - 1;

export interface ComparisonLapIdentity {
  label: string;
  color: string;
}

export function comparisonLapIdentity(selectedLapIds: readonly number[], lapId: number): ComparisonLapIdentity | null {
  const selectionIndex = selectedLapIds.indexOf(lapId);
  if (selectionIndex < 0 || selectionIndex >= MAX_COMPARISON_LAPS) return null;
  return {
    label: String.fromCharCode(66 + selectionIndex),
    color: COMPARISON_COLOR_VARS[selectionIndex + 1],
  };
}

export function normalizeComparisonLapIds(lapIds: readonly number[], referenceLapId: number | null = null): number[] {
  const uniqueLapIds: number[] = [];
  for (const lapId of lapIds) {
    if (lapId === referenceLapId || uniqueLapIds.includes(lapId)) continue;
    uniqueLapIds.push(lapId);
    if (uniqueLapIds.length === MAX_COMPARISON_LAPS) break;
  }
  return uniqueLapIds;
}

export function toggleComparisonLapSelection(selectedLapIds: readonly number[], lapId: number): number[] {
  if (selectedLapIds.includes(lapId)) return selectedLapIds.filter((selectedLapId) => selectedLapId !== lapId);
  if (selectedLapIds.length >= MAX_COMPARISON_LAPS) return [...selectedLapIds];
  return [...selectedLapIds, lapId];
}

export interface ComparisonRequestPlan {
  requestLapIds: number[];
  abortLapIds: number[];
}

export function planComparisonRequests(
  selectedLapIds: readonly number[],
  loadedLapIds: ReadonlySet<number>,
  failedLapIds: ReadonlySet<number>,
  inFlightLapIds: ReadonlySet<number>,
): ComparisonRequestPlan {
  const selectedLapIdSet = new Set(selectedLapIds);
  return {
    requestLapIds: selectedLapIds.filter((lapId) => !loadedLapIds.has(lapId) && !failedLapIds.has(lapId) && !inFlightLapIds.has(lapId)),
    abortLapIds: [...inFlightLapIds].filter((lapId) => !selectedLapIdSet.has(lapId)),
  };
}

export function selectComparisonEntries<T extends { lapId: number }>(entries: readonly T[], selectedLapIds: readonly number[]): T[] {
  const entryByLapId = new Map(entries.map((entry) => [entry.lapId, entry]));
  return selectedLapIds.flatMap((lapId) => {
    const entry = entryByLapId.get(lapId);
    return entry ? [entry] : [];
  });
}

export interface Point {
  x: number;
  z: number;
}
/** Use telemetry-indexed track geometry when Compare lacks a dense world-position trace. */
export function resolveComparisonImageryLocalPositions(telemetry: readonly SemanticTelemetrySample[], outline: readonly Point[]): readonly Point[] | undefined {
  let usable = 0;
  for (const sample of telemetry) {
    const x = num(sample, "motion.position-x") ?? 0;
    const z = num(sample, "motion.position-z") ?? 0;
    if (x !== 0 || z !== 0) usable++;
  }
  if (usable >= 3 && usable / Math.max(1, telemetry.length) >= 0.8) return undefined;
  if (telemetry.length <= 1 || outline.length <= 1) return outline;

  return Array.from({ length: telemetry.length }, (_, index) => {
    const position = (index * (outline.length - 1)) / (telemetry.length - 1);
    const before = Math.floor(position);
    const after = Math.min(outline.length - 1, before + 1);
    const fraction = position - before;
    return {
      x: outline[before]!.x + (outline[after]!.x - outline[before]!.x) * fraction,
      z: outline[before]!.z + (outline[after]!.z - outline[before]!.z) * fraction,
    };
  });
}

export interface BoundaryData {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}

/** Find the telemetry index closest to a given distance value */
export function findTelemetryAtDistance(telemetry: SemanticTelemetrySample[], distance: number): number {
  const distStart = num(telemetry[0]!, "timing.distance-traveled") ?? 0;
  let closest = 0;
  let closestDelta = Infinity;
  for (let i = 0; i < telemetry.length; i++) {
    const d = Math.abs((num(telemetry[i], "timing.distance-traveled") ?? 0) - distStart - distance);
    if (d < closestDelta) {
      closestDelta = d;
      closest = i;
    }
  }
  return closest;
}

export function resolveAlignedCursor<TA, TB>(
  telemetryA: readonly TA[],
  telemetryB: readonly TB[],
  distances: readonly number[],
  sourceIndicesA: readonly number[],
  sourceIndicesB: readonly number[],
  distance: number | null,
): { gridIndex: number; packetA: TA | null; packetB: TB | null } | null {
  if (distance == null || distances.length === 0) return null;
  let low = 0;
  let high = distances.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (distances[middle] < distance) low = middle + 1;
    else high = middle;
  }
  const previous = Math.max(0, low - 1);
  const gridIndex = Math.abs(distances[previous] - distance) <= Math.abs(distances[low] - distance) ? previous : low;
  const indexA = sourceIndicesA[gridIndex];
  const indexB = sourceIndicesB[gridIndex];
  return {
    gridIndex,
    packetA: Number.isInteger(indexA) && indexA >= 0 && indexA < telemetryA.length ? telemetryA[indexA] : null,
    packetB: Number.isInteger(indexB) && indexB >= 0 && indexB < telemetryB.length ? telemetryB[indexB] : null,
  };
}

function findMapPosition(
  telemetry: SemanticTelemetrySample[],
  distance: number,
  outline: Point[],
  telX: (x: number) => number,
  sourceIndex?: number,
): { x: number; z: number; packet: SemanticTelemetrySample } | null {
  if (telemetry.length < 2) return null;

  const packet = sourceIndex == null ? telemetry[findTelemetryAtDistance(telemetry, distance)] : telemetry[sourceIndex];
  if (!packet) return null;
  if ((num(packet, "motion.position-x") ?? 0) !== 0 || (num(packet, "motion.position-z") ?? 0) !== 0) {
    return { x: telX(num(packet, "motion.position-x") ?? 0), z: num(packet, "motion.position-z") ?? 0, packet };
  }

  if (outline.length < 2) return null;
  const lapDistance = (num(telemetry[telemetry.length - 1], "timing.distance-traveled") ?? 0) - (num(telemetry[0], "timing.distance-traveled") ?? 0);
  if (!(lapDistance > 0)) return null;

  const fraction = Math.max(0, Math.min(distance / lapDistance, 1));
  const point = outline[Math.round(fraction * (outline.length - 1))];
  return point ? { x: point.x, z: point.z, packet } : null;
}

export interface ComparisonOverlaySeries {
  telemetry: SemanticTelemetrySample[];
  color: string;
  cursorIndex?: number;
}

export interface MultiComparisonWorldOverlayOptions {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  toCanvas: (x: number, z: number) => [number, number];
  outline: Point[];
  series: ComparisonOverlaySeries[];
  hoveredDistance: number | null;
  zoomed: boolean;
  showRacingLines?: boolean;
  segmentPoints?: Array<{ x: number; z: number; type: "corner" | "straight"; label: string }>;
}

export interface ComparisonWorldOverlayOptions {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  toCanvas: (x: number, z: number) => [number, number];
  outline: Point[];
  telemetryA: SemanticTelemetrySample[];
  telemetryB: SemanticTelemetrySample[];
  hoveredDistance: number | null;
  zoomed: boolean;
  showRacingLines?: boolean;
  segmentPoints?: Array<{ x: number; z: number; type: "corner" | "straight"; label: string }>;
  cursorIndexA?: number;
  cursorIndexB?: number;
}

/** Draw any number of racing lines and aligned cursor markers over TrackMapCanvas. */
export function drawMultiComparisonWorldOverlay({ context, toCanvas, outline, series, hoveredDistance, zoomed, showRacingLines = true, segmentPoints }: MultiComparisonWorldOverlayOptions): void {
  const drawRacingLine = (telemetry: SemanticTelemetrySample[], color: string) => {
    if (telemetry.length < 2) return;
    context.lineWidth = zoomed ? 3 : 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.globalAlpha = 0.8;
    context.beginPath();
    context.strokeStyle = color;
    let moved = false;
    for (const sample of telemetry) {
      const x = num(sample, "motion.position-x") ?? 0;
      const z = num(sample, "motion.position-z") ?? 0;
      if (x === 0 && z === 0) continue;
      const [canvasX, canvasY] = toCanvas(x, z);
      if (!moved) {
        context.moveTo(canvasX, canvasY);
        moved = true;
      } else {
        context.lineTo(canvasX, canvasY);
      }
    }
    if (moved) context.stroke();
    context.globalAlpha = 1;
  };

  if (showRacingLines) {
    for (const entry of series) drawRacingLine(entry.telemetry, entry.color);
  }

  if (hoveredDistance != null) {
    const dotSize = zoomed ? 7 : 5;
    const glowSize = zoomed ? 14 : 10;
    const positions = series.map((entry) => findMapPosition(entry.telemetry, hoveredDistance, outline, (x) => x, entry.cursorIndex));
    const canvasPositions = positions.map((position) => (position ? toCanvas(position.x, position.z) : null));
    const clustered = canvasPositions.some(
      (position, index) =>
        position != null && canvasPositions.some((other, otherIndex) => otherIndex > index && other != null && Math.hypot(position[0] - other[0], position[1] - other[1]) < dotSize * 2),
    );

    const drawDot = (position: { x: number; z: number; packet: SemanticTelemetrySample } | null, color: string, offsetX: number, offsetY: number) => {
      if (!position) return;
      const [baseX, baseY] = toCanvas(position.x, position.z);
      const centerX = baseX + offsetX;
      const centerY = baseY + offsetY;
      context.beginPath();
      context.arc(centerX, centerY, glowSize, 0, Math.PI * 2);
      context.save();
      context.globalAlpha = 0.2;
      context.fillStyle = color;
      context.fill();
      context.restore();
      context.beginPath();
      context.arc(centerX, centerY, dotSize, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.strokeStyle = "var(--track-label-background)";
      context.lineWidth = 1.5;
      context.stroke();
      const yaw = num(position.packet, "motion.yaw");
      if (zoomed && yaw !== undefined) {
        const lineLength = 22;
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.lineTo(centerX - Math.sin(yaw) * lineLength, centerY + Math.cos(yaw) * lineLength);
        context.strokeStyle = "var(--app-text)";
        context.lineWidth = 2.5;
        context.lineCap = "round";
        context.stroke();
      }
    };

    positions.forEach((position, index) => {
      const angle = (index / Math.max(1, positions.length)) * Math.PI * 2;
      const offset = clustered ? dotSize : 0;
      drawDot(position, series[index]!.color, Math.cos(angle) * offset, Math.sin(angle) * offset);
    });
  }

  if (segmentPoints && !zoomed) {
    for (const segment of segmentPoints) {
      const [x, y] = toCanvas(segment.x, segment.z);
      context.beginPath();
      context.arc(x, y, 3.5, 0, Math.PI * 2);
      context.fillStyle = segment.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)";
      context.fill();
      context.strokeStyle = "var(--track-label-background)";
      context.lineWidth = 1;
      context.stroke();
    }
  }
}

/** Pair-compatible wrapper retained for pair-level comparison utilities and tests. */
export function drawComparisonWorldOverlay(options: ComparisonWorldOverlayOptions): void {
  drawMultiComparisonWorldOverlay({
    ...options,
    series: [
      { telemetry: options.telemetryA, color: COLOR_A, cursorIndex: options.cursorIndexA },
      { telemetry: options.telemetryB, color: COLOR_B, cursorIndex: options.cursorIndexB },
    ],
  });
}

/**
 * Draw combined input HUD for both laps:
 * Layout: [Brake A][Brake B] — [Wheel A / Gear] — [Wheel B / Gear] — [Throttle A][Throttle B]
 */
export function drawInputsHUD(ctx: CanvasRenderingContext2D, w: number, h: number, pA: SemanticTelemetrySample | null, pB: SemanticTelemetrySample | null) {
  const barW = 14;
  const barH = 80;
  const wheelR = 28;
  const barGap = 4;
  const sectionGap = 16;
  const hudH = barH + 20; // total height with labels
  const y0 = h - hudH - 10;

  // Semi-transparent backdrop
  const totalW = (barW * 2 + barGap) * 2 + wheelR * 2 * 2 + sectionGap * 4;
  const bx0 = (w - totalW) / 2;
  ctx.fillStyle = "color-mix(in srgb, var(--track-label-background) 75%, transparent)";
  ctx.beginPath();
  ctx.roundRect(bx0 - 8, y0 - 14, totalW + 16, hudH + 18, 8);
  ctx.fill();

  let cx = bx0;

  // --- Brake bars for laps A and B ---
  const drawBar = (x: number, frac: number, color: string, borderColor: string) => {
    ctx.fillStyle = "var(--app-surface-alt)";
    ctx.fillRect(x, y0, barW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(x, y0 + barH * (1 - frac), barW, barH * frac);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y0, barW, barH);
  };

  const brakeA = num(pA!, "inputs.brake") ?? 0;
  const brakeB = num(pB!, "inputs.brake") ?? 0;
  drawBar(cx, brakeA, "var(--ch-brake)", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, brakeB, "var(--ch-brake)", COLOR_B);
  cx += barW + sectionGap;

  // Label
  ctx.font = "var(--text-app-caption) var(--font-mono)";
  ctx.fillStyle = "var(--app-text-dim)";
  ctx.textAlign = "center";
  ctx.fillText("Brake", bx0 + barW + barGap / 2, y0 + barH + 14);

  // --- Steering wheel A ---
  const drawWheel = (wcx: number, wcy: number, steer: number, gear: number, color: string) => {
    // Outer ring
    ctx.beginPath();
    ctx.arc(wcx, wcy, wheelR, 0, Math.PI * 2);
    ctx.strokeStyle = "var(--app-border)";
    ctx.lineWidth = 4;
    ctx.stroke();

    // Colored arc showing steer amount
    const steerAngle = steer * Math.PI * 0.75;
    if (Math.abs(steerAngle) > 0.02) {
      ctx.beginPath();
      ctx.arc(wcx, wcy, wheelR, -Math.PI / 2, -Math.PI / 2 + steerAngle, steerAngle < 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // Indicator line
    const angle = -Math.PI / 2 + steerAngle;
    ctx.beginPath();
    ctx.moveTo(wcx + Math.cos(angle) * 6, wcy + Math.sin(angle) * 6);
    ctx.lineTo(wcx + Math.cos(angle) * (wheelR - 3), wcy + Math.sin(angle) * (wheelR - 3));
    ctx.strokeStyle = "var(--app-text)";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Gear number in center
    ctx.font = "var(--font-weight-bold) var(--text-xl) var(--font-mono)";
    ctx.fillStyle = "var(--app-text)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gear > 0 ? String(gear) : gear === 0 ? "N" : "R", wcx, wcy);
    ctx.textBaseline = "alphabetic";
  };

  const steerA = num(pA!, "inputs.steering") ?? 0;
  const gearA = num(pA!, "inputs.gear") ?? 0;
  const wheelAcx = cx + wheelR;
  const wheelAcy = y0 + barH / 2 - 6;
  drawWheel(wheelAcx, wheelAcy, steerA, gearA, COLOR_A);
  cx += wheelR * 2 + sectionGap;

  // --- Steering wheel B ---
  const steerB = num(pB!, "inputs.steering") ?? 0;
  const gearB = num(pB!, "inputs.gear") ?? 0;
  const wheelBcx = cx + wheelR;
  const wheelBcy = y0 + barH / 2 - 6;
  drawWheel(wheelBcx, wheelBcy, steerB, gearB, COLOR_B);
  cx += wheelR * 2 + sectionGap;

  // Center label
  ctx.font = "var(--text-app-caption) var(--font-mono)";
  ctx.fillStyle = "var(--app-text-dim)";
  ctx.textAlign = "center";
  ctx.fillText("Steering / Gear", (wheelAcx + wheelBcx) / 2, y0 + barH + 14);

  // --- Throttle bars for laps A and B ---
  const throttleA = num(pA!, "inputs.throttle") ?? 0;
  const throttleB = num(pB!, "inputs.throttle") ?? 0;
  drawBar(cx, throttleA, "var(--ch-throttle)", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, throttleB, "var(--ch-throttle)", COLOR_B);

  ctx.font = "var(--text-app-caption) var(--font-mono)";
  ctx.fillStyle = "var(--app-text-dim)";
  ctx.textAlign = "center";
  ctx.fillText("Throttle", cx - barGap / 2, y0 + barH + 14);
}

/** Compute zoom view containing every compared car position. */
export function computeMultiComparisonZoom(
  series: Array<{ telemetry: SemanticTelemetrySample[]; sourceIndex?: number }>,
  hoveredDistance: number,
  trackRange: number,
  telX: (x: number) => number = (x) => x,
  outline: Point[] = [],
): { centerX: number; centerZ: number; range: number } | null {
  const positions = series
    .map((entry) => findMapPosition(entry.telemetry, hoveredDistance, outline, telX, entry.sourceIndex))
    .filter((position): position is NonNullable<typeof position> => position != null);
  if (positions.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const position of positions) {
    minX = Math.min(minX, position.x);
    maxX = Math.max(maxX, position.x);
    minZ = Math.min(minZ, position.z);
    maxZ = Math.max(maxZ, position.z);
  }
  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    range: Math.max(trackRange * 0.02, (maxX - minX) * 2.5, (maxZ - minZ) * 2.5),
  };
}

/** Pair-compatible zoom helper. */
export function computeZoom(
  telemetryA: SemanticTelemetrySample[],
  telemetryB: SemanticTelemetrySample[],
  hoveredDistance: number,
  trackRange: number,
  telX: (x: number) => number = (x) => x,
  outline: Point[] = [],
  sourceIndexA?: number,
  sourceIndexB?: number,
): { centerX: number; centerZ: number; range: number } | null {
  return computeMultiComparisonZoom(
    [
      { telemetry: telemetryA, sourceIndex: sourceIndexA },
      { telemetry: telemetryB, sourceIndex: sourceIndexB },
    ],
    hoveredDistance,
    trackRange,
    telX,
    outline,
  );
}

export function formatSectionTime(seconds: number): string {
  if (seconds <= 0) return "-";
  return seconds.toFixed(3);
}

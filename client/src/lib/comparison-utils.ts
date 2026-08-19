import type { SemanticTelemetrySample } from "@shared/racing/comparison/types";
const v = (p: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): any => p.values[id]
const num = (p: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): number | undefined => { const x=v(p,id); return typeof x === "number" ? x : undefined; }

export const COLOR_A = "var(--comparison-lap-a)";
export const COLOR_B = "var(--comparison-lap-b)";

export interface Point {
  x: number;
  z: number;
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

function findMapPosition(telemetry: SemanticTelemetrySample[], distance: number, outline: Point[], telX: (x: number) => number): { x: number; z: number; packet: SemanticTelemetrySample } | null {
  if (telemetry.length < 2) return null;

  const packet = telemetry[findTelemetryAtDistance(telemetry, distance)];
  if (!packet) return null;
  if ((num(packet, "motion.position-x") ?? 0) !== 0 || (num(packet, "motion.position-z") ?? 0) !== 0) {
    return { x: telX((num(packet, "motion.position-x") ?? 0)), z: (num(packet, "motion.position-z") ?? 0), packet };
  }

  if (outline.length < 2) return null;
  const lapDistance = (num(telemetry[telemetry.length - 1], "timing.distance-traveled") ?? 0) - (num(telemetry[0], "timing.distance-traveled") ?? 0);
  if (!(lapDistance > 0)) return null;

  const fraction = Math.max(0, Math.min(distance / lapDistance, 1));
  const point = outline[Math.round(fraction * (outline.length - 1))];
  return point ? { x: point.x, z: point.z, packet } : null;
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
  segmentPoints?: Array<{ x: number; z: number; type: "corner" | "straight"; label: string }>;
}

/** Draw comparison-only racing lines, cursor markers, and segment anchors over TrackMapCanvas. */
export function drawComparisonWorldOverlay({
  context,
  toCanvas,
  outline,
  telemetryA,
  telemetryB,
  hoveredDistance,
  zoomed,
  segmentPoints,
}: ComparisonWorldOverlayOptions): void {
  const drawRacingLine = (telemetry: SemanticTelemetrySample[], color: string) => {
    if (telemetry.length < 2) return;
    const hasPosition = telemetry.some((sample) => (num(sample, "motion.position-x") ?? 0) !== 0 || (num(sample, "motion.position-z") ?? 0) !== 0);
    if (!hasPosition) return;
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
    context.stroke();
    context.globalAlpha = 1;
  };

  drawRacingLine(telemetryA, COLOR_A);
  drawRacingLine(telemetryB, COLOR_B);

  if (hoveredDistance != null) {
    const dotSize = zoomed ? 7 : 5;
    const glowSize = zoomed ? 14 : 10;
    const positionA = findMapPosition(telemetryA, hoveredDistance, outline, (x) => x);
    const positionB = findMapPosition(telemetryB, hoveredDistance, outline, (x) => x);
    const canvasA = positionA ? toCanvas(positionA.x, positionA.z) : null;
    const canvasB = positionB ? toCanvas(positionB.x, positionB.z) : null;
    const overlaps = canvasA !== null && canvasB !== null && Math.hypot(canvasA[0] - canvasB[0], canvasA[1] - canvasB[1]) < dotSize * 2;
    const overlapOffset = overlaps ? dotSize : 0;

    const drawDot = (position: { x: number; z: number; packet: SemanticTelemetrySample } | null, color: string, offsetX: number) => {
      if (!position) return;
      const [baseX, centerY] = toCanvas(position.x, position.z);
      const centerX = baseX + offsetX;
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

    drawDot(positionA, COLOR_A, -overlapOffset);
    drawDot(positionB, COLOR_B, overlapOffset);
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
    const steerAngle = (steer / 127) * Math.PI * 0.75;
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

  const steerA = num(pA!, "inputs.steer") ?? 0;
  const gearA = num(pA!, "inputs.gear") ?? 0;
  const wheelAcx = cx + wheelR;
  const wheelAcy = y0 + barH / 2 - 6;
  drawWheel(wheelAcx, wheelAcy, steerA, gearA, COLOR_A);
  cx += wheelR * 2 + sectionGap;

  // --- Steering wheel B ---
  const steerB = num(pB!, "inputs.steer") ?? 0;
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
  const throttleA = num(pA!, "inputs.accel") ?? 0;
  const throttleB = num(pB!, "inputs.accel") ?? 0;
  drawBar(cx, throttleA, "var(--ch-throttle)", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, throttleB, "var(--ch-throttle)", COLOR_B);

  ctx.font = "var(--text-app-caption) var(--font-mono)";
  ctx.fillStyle = "var(--app-text-dim)";
  ctx.textAlign = "center";
  ctx.fillText("Throttle", cx - barGap / 2, y0 + barH + 14);
}

/** Compute zoom view centered on both car positions */
export function computeZoom(
  telemetryA: SemanticTelemetrySample[],
  telemetryB: SemanticTelemetrySample[],
  hoveredDistance: number,
  trackRange: number,
  telX: (x: number) => number = (x) => x,
  outline: Point[] = [],
): { centerX: number; centerZ: number; range: number } | null {
  const posA = findMapPosition(telemetryA, hoveredDistance, outline, telX);
  const posB = findMapPosition(telemetryB, hoveredDistance, outline, telX);

  if (!posA && !posB) return null;

  let cx: number, cz: number;
  if (posA && posB) {
    cx = (posA.x + posB.x) / 2;
    cz = (posA.z + posB.z) / 2;
  } else if (posA) {
    cx = posA.x;
    cz = posA.z;
  } else {
    cx = posB!.x;
    cz = posB!.z;
  }

  const zoomRange = trackRange * 0.02;
  let needed = zoomRange;
  if (posA && posB) {
    const spanX = Math.abs(posA.x - posB.x);
    const spanZ = Math.abs(posA.z - posB.z);
    needed = Math.max(zoomRange, spanX * 2.5, spanZ * 2.5);
  }

  return { centerX: cx, centerZ: cz, range: needed };
}

export function formatSectionTime(seconds: number): string {
  if (seconds <= 0) return "-";
  return seconds.toFixed(3);
}

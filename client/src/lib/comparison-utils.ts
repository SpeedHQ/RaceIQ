import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
const value = (sample: SemanticTelemetrySample, id: keyof SemanticTelemetrySample["values"]): unknown => sample.values[id];
const numberValue = (sample: SemanticTelemetrySample | null | undefined, id: keyof SemanticTelemetrySample["values"]): number | undefined => {
  if (!sample) return undefined;
  const resolved = value(sample, id);
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : undefined;
};

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
  let firstIndex = -1;
  let distanceStart = 0;
  for (let index = 0; index < telemetry.length; index++) {
    const sampleDistance = numberValue(telemetry[index], "timing.distance-traveled");
    if (sampleDistance === undefined) continue;
    firstIndex = index;
    distanceStart = sampleDistance;
    break;
  }
  if (firstIndex < 0) return -1;

  let closest = firstIndex;
  let closestDelta = Number.POSITIVE_INFINITY;
  for (let index = firstIndex; index < telemetry.length; index++) {
    const sampleDistance = numberValue(telemetry[index], "timing.distance-traveled");
    if (sampleDistance === undefined) continue;
    const delta = Math.abs(sampleDistance - distanceStart - distance);
    if (delta < closestDelta) {
      closestDelta = delta;
      closest = index;
    }
  }
  return closest;
}
export interface AlignedCursor<TA, TB> {
  gridIndex: number;
  packetA: TA | null;
  packetB: TB | null;
}

/** Resolve aligned-grid cursor to each lap's original source sample. */
export function resolveAlignedCursor<TA, TB>(
  telemetryA: readonly TA[],
  telemetryB: readonly TB[],
  distances: readonly number[],
  sourceIndicesA: readonly number[],
  sourceIndicesB: readonly number[],
  hoveredDistance: number | null,
): AlignedCursor<TA, TB> | null {
  if (hoveredDistance === null || distances.length === 0) return null;
  let gridIndex = -1;
  let closestDelta = Number.POSITIVE_INFINITY;
  for (let index = 0; index < distances.length; index++) {
    const distance = distances[index];
    if (!Number.isFinite(distance)) continue;
    const delta = Math.abs(distance - hoveredDistance);
    if (delta < closestDelta) {
      closestDelta = delta;
      gridIndex = index;
    }
  }
  if (gridIndex < 0) return null;
  const indexA = sourceIndicesA[gridIndex];
  const indexB = sourceIndicesB[gridIndex];
  return {
    gridIndex,
    packetA: Number.isInteger(indexA) && indexA >= 0 && indexA < telemetryA.length ? telemetryA[indexA] : null,
    packetB: Number.isInteger(indexB) && indexB >= 0 && indexB < telemetryB.length ? telemetryB[indexB] : null,
  };
}

function findMapPosition(telemetry: SemanticTelemetrySample[], distance: number, outline: Point[], telX: (x: number) => number): { x: number; z: number; packet: SemanticTelemetrySample } | null {
  if (telemetry.length < 2) return null;

  const telemetryIndex = findTelemetryAtDistance(telemetry, distance);
  if (telemetryIndex < 0) return null;
  const packet = telemetry[telemetryIndex];
  const positionX = numberValue(packet, "motion.position-x");
  const positionZ = numberValue(packet, "motion.position-z");
  if (positionX !== undefined && positionZ !== undefined && (positionX !== 0 || positionZ !== 0)) {
    return { x: telX(positionX), z: positionZ, packet };
  }

  if (outline.length < 2) return null;
  let firstDistance: number | undefined;
  let lastDistance: number | undefined;
  for (const sample of telemetry) {
    const sampleDistance = numberValue(sample, "timing.distance-traveled");
    if (sampleDistance === undefined) continue;
    firstDistance ??= sampleDistance;
    lastDistance = sampleDistance;
  }
  if (firstDistance === undefined || lastDistance === undefined) return null;
  const lapDistance = lastDistance - firstDistance;
  if (!(lapDistance > 0)) return null;

  const fraction = Math.max(0, Math.min(distance / lapDistance, 1));
  const point = outline[Math.round(fraction * (outline.length - 1))];
  return point ? { x: point.x, z: point.z, packet } : null;
}

/** Shared drawing logic for track outline + racing lines + position dots */
export function drawTrackCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  outline: Point[],
  telemetryA: SemanticTelemetrySample[],
  telemetryB: SemanticTelemetrySample[],
  hoveredDistance: number | null,
  zoom: { centerX: number; centerZ: number; range: number } | null,
  segmentPoints?: Array<{ x: number; z: number; type: "corner" | "straight"; label: string }>,
  followCar?: boolean,
  boundaries?: BoundaryData | null,
  telX?: (x: number) => number,
  hideOutline?: boolean,
) {
  if (!telX) telX = (x) => x;
  ctx.clearRect(0, 0, w, h);

  // Bounding box of outline (include boundary edges if available)
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const allBoundSets: Point[][] = [outline];
  if (boundaries && (boundaries.coordSystem === "forza" || boundaries.coordSystem === "f1-2025" || boundaries.coordSystem === "acc")) {
    allBoundSets.push(boundaries.leftEdge, boundaries.rightEdge);
  }
  for (const pts of allBoundSets) {
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }

  const trackRangeX = maxX - minX || 1;
  const trackRangeZ = maxZ - minZ || 1;
  const padding = 24;

  let viewCenterX: number, viewCenterZ: number, viewRangeX: number, viewRangeZ: number;
  if (zoom) {
    viewCenterX = zoom.centerX;
    viewCenterZ = zoom.centerZ;
    viewRangeX = zoom.range;
    viewRangeZ = zoom.range;
  } else {
    viewCenterX = (minX + maxX) / 2;
    viewCenterZ = (minZ + maxZ) / 2;
    viewRangeX = trackRangeX;
    viewRangeZ = trackRangeZ;
  }

  const scaleX = (w - padding * 2) / viewRangeX;
  const scaleZ = (h - padding * 2) / viewRangeZ;
  const sc = Math.min(scaleX, scaleZ);

  const toCanvas = (x: number, z: number): [number, number] => [w / 2 + (viewCenterX - x) * sc, h / 2 + (z - viewCenterZ) * sc];

  // Car view: rotate map so car A always points up
  let needsRestore = false;
  if (followCar && zoom && hoveredDistance != null && telemetryA.length >= 2) {
    const telemetryIndex = findTelemetryAtDistance(telemetryA, hoveredDistance);
    const pA = telemetryIndex < 0 ? undefined : telemetryA[telemetryIndex];
    const yaw = pA ? numberValue(pA, "motion.yaw") : undefined;
    const positionX = pA ? numberValue(pA, "motion.position-x") : undefined;
    const positionZ = pA ? numberValue(pA, "motion.position-z") : undefined;
    if (positionX !== undefined && positionZ !== undefined && (positionX !== 0 || positionZ !== 0) && yaw !== undefined) {
      const [carCx, carCy] = toCanvas(telX(positionX), positionZ);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(Math.PI - yaw);
      ctx.translate(-carCx, -carCy);
      needsRestore = true;
    }
  }

  // Draw track boundary edges (track limits)
  if (boundaries && (boundaries.coordSystem === "forza" || boundaries.coordSystem === "f1-2025" || boundaries.coordSystem === "acc")) {
    const left = boundaries.leftEdge;
    const right = boundaries.rightEdge;

    // Filled track surface
    if (left.length > 1 && right.length > 1) {
      ctx.beginPath();
      const [lx0, ly0] = toCanvas(left[0].x, left[0].z);
      ctx.moveTo(lx0, ly0);
      for (let i = 1; i < left.length; i++) {
        const [lx, ly] = toCanvas(left[i].x, left[i].z);
        ctx.lineTo(lx, ly);
      }
      for (let i = right.length - 1; i >= 0; i--) {
        const [rx, ry] = toCanvas(right[i].x, right[i].z);
        ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.fillStyle = "color-mix(in srgb, var(--track-surface) 18%, transparent)";
      ctx.fill();
    }

    // Edge lines
    const drawEdge = (edge: Point[]) => {
      if (edge.length < 2) return;
      ctx.beginPath();
      const [ex, ey] = toCanvas(edge[0].x, edge[0].z);
      ctx.moveTo(ex, ey);
      for (let i = 1; i < edge.length; i++) {
        const [px, py] = toCanvas(edge[i].x, edge[i].z);
        ctx.lineTo(px, py);
      }
      ctx.strokeStyle = "color-mix(in srgb, var(--track-edge) 30%, transparent)";
      ctx.lineWidth = zoom ? 1.5 : 1;
      ctx.stroke();
    };
    drawEdge(left);
    drawEdge(right);
  }

  // Jump detection for outline
  const worldDists: number[] = [];
  for (let i = 1; i < outline.length; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    worldDists.push(Math.sqrt(dx * dx + dz * dz));
  }
  const sortedDists = [...worldDists].sort((a, b) => a - b);
  const p90 = sortedDists[Math.floor(sortedDists.length * 0.9)] || 1;
  const jumpThreshold = Math.max(p90 * 3, 50);

  const drawOutlinePath = () => {
    const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < outline.length; i++) {
      const [px, py] = toCanvas(outline[i].x, outline[i].z);
      if (worldDists[i - 1] > jumpThreshold) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineTo(sx, sy);
  };

  if (!hideOutline) {
    // Outline thick
    ctx.beginPath();
    ctx.strokeStyle = "var(--track-outline)";
    ctx.lineWidth = zoom ? 6 : 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawOutlinePath();
    ctx.stroke();

    // Outline thin
    ctx.beginPath();
    ctx.strokeStyle = "var(--track-outline-strong)";
    ctx.lineWidth = zoom ? 3 : 2;
    drawOutlinePath();
    ctx.stroke();

    // Start/finish marker
    const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
    ctx.beginPath();
    ctx.arc(sx, sy, zoom ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = "var(--track-start)";
    ctx.fill();
    ctx.strokeStyle = "var(--track-label-background)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Racing lines
  const drawRacingLine = (telemetry: SemanticTelemetrySample[], color: string) => {
    if (telemetry.length < 2) return;
    ctx.lineWidth = zoom ? 3 : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.strokeStyle = color;
    let moved = false;
    for (const sample of telemetry) {
      const positionX = numberValue(sample, "motion.position-x");
      const positionZ = numberValue(sample, "motion.position-z");
      if (positionX === undefined || positionZ === undefined || (positionX === 0 && positionZ === 0)) continue;
      const [cx, cy] = toCanvas(telX!(positionX), positionZ);
      if (!moved) {
        ctx.moveTo(cx, cy);
        moved = true;
      } else {
        ctx.lineTo(cx, cy);
      }
    }
    if (moved) ctx.stroke();
    ctx.globalAlpha = 1;
  };

  drawRacingLine(telemetryA, COLOR_A);
  drawRacingLine(telemetryB, COLOR_B);

  // Position dots. Games without world coordinates (notably iRacing) project
  // lap-distance progress onto the recorded track outline.
  if (hoveredDistance != null) {
    const dotSize = zoom ? 7 : 5;
    const glowSize = zoom ? 14 : 10;
    const positionA = findMapPosition(telemetryA, hoveredDistance, outline, telX);
    const positionB = findMapPosition(telemetryB, hoveredDistance, outline, telX);
    const canvasA = positionA ? toCanvas(positionA.x, positionA.z) : null;
    const canvasB = positionB ? toCanvas(positionB.x, positionB.z) : null;
    const overlaps = canvasA !== null && canvasB !== null && Math.hypot(canvasA[0] - canvasB[0], canvasA[1] - canvasB[1]) < dotSize * 2;
    const overlapOffset = overlaps ? dotSize : 0;

    const drawDot = (position: { x: number; z: number; packet: SemanticTelemetrySample } | null, color: string, offsetX: number) => {
      if (!position) return;
      const [baseX, cy] = toCanvas(position.x, position.z);
      const cx = baseX + offsetX;
      ctx.beginPath();
      ctx.arc(cx, cy, glowSize, 0, Math.PI * 2);
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, dotSize, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Direction line from Yaw (heading)
      const yaw = numberValue(position.packet, "motion.yaw");
      if (zoom && yaw !== undefined) {
        const lineLen = 22;
        // Yaw: 0 = +Z, positive = clockwise from above
        // Canvas: X is flipped (viewCenterX - x), Z is normal (z - viewCenterZ)
        const dx = -Math.sin(yaw) * lineLen;
        const dy = Math.cos(yaw) * lineLen;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + dx, cy + dy);
        ctx.strokeStyle = "var(--app-text)";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    };
    drawDot(positionA, COLOR_A, -overlapOffset);
    drawDot(positionB, COLOR_B, overlapOffset);
  }

  // Segment boundary markers (overview only)
  if (segmentPoints && !zoom) {
    for (const sp of segmentPoints) {
      const [px, py] = toCanvas(sp.x, sp.z);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = sp.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)";
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  if (needsRestore) ctx.restore();
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
  const drawBar = (x: number, frac: number | undefined, color: string, borderColor: string) => {
    ctx.fillStyle = "var(--app-surface-alt)";
    ctx.fillRect(x, y0, barW, barH);
    ctx.strokeStyle = frac === undefined ? "var(--status-unavailable)" : borderColor;
    ctx.lineWidth = 1.5;
    if (frac === undefined) ctx.setLineDash([3, 2]);
    ctx.strokeRect(x, y0, barW, barH);
    ctx.setLineDash([]);
    if (frac === undefined) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, y0 + barH * (1 - frac), barW, barH * frac);
  };
  const controlFraction = (value: number | undefined) => (value === undefined ? undefined : Math.max(0, Math.min(1, value / 255)));

  const brakeA = numberValue(pA, "inputs.brake");
  const brakeB = numberValue(pB, "inputs.brake");
  drawBar(cx, controlFraction(brakeA), "var(--ch-brake)", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, controlFraction(brakeB), "var(--ch-brake)", COLOR_B);
  cx += barW + sectionGap;

  // Label
  ctx.font = "var(--text-app-caption) var(--font-mono)";
  ctx.fillStyle = "var(--app-text-dim)";
  ctx.textAlign = "center";
  ctx.fillText("Brake", bx0 + barW + barGap / 2, y0 + barH + 14);

  // --- Steering wheel A ---
  const drawWheel = (wcx: number, wcy: number, steer: number | undefined, gear: number | undefined, color: string) => {
    // Outer ring
    ctx.beginPath();
    ctx.arc(wcx, wcy, wheelR, 0, Math.PI * 2);
    ctx.strokeStyle = "var(--app-border)";
    ctx.lineWidth = 4;
    ctx.stroke();

    if (steer === undefined || gear === undefined) {
      ctx.font = "var(--font-weight-bold) var(--text-xl) var(--font-mono)";
      ctx.fillStyle = "var(--status-unavailable)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("—", wcx, wcy);
      ctx.textBaseline = "alphabetic";
      return;
    }

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

  const steerA = numberValue(pA, "inputs.steer");
  const gearA = numberValue(pA, "inputs.gear");
  const wheelAcx = cx + wheelR;
  const wheelAcy = y0 + barH / 2 - 6;
  drawWheel(wheelAcx, wheelAcy, steerA, gearA, COLOR_A);
  cx += wheelR * 2 + sectionGap;

  // --- Steering wheel B ---
  const steerB = numberValue(pB, "inputs.steer");
  const gearB = numberValue(pB, "inputs.gear");
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
  const throttleA = numberValue(pA, "inputs.accel");
  const throttleB = numberValue(pB, "inputs.accel");
  drawBar(cx, controlFraction(throttleA), "var(--ch-throttle)", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, controlFraction(throttleB), "var(--ch-throttle)", COLOR_B);

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

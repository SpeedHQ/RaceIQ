import type { TelemetryPacket } from "@shared/types";

export const COLOR_A = "#f97316"; // orange
export const COLOR_B = "#3b82f6"; // blue

export interface Point { x: number; z: number }

export interface BoundaryData {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}

/** Find the telemetry index closest to a given distance value */
export function findTelemetryAtDistance(telemetry: TelemetryPacket[], distance: number): number {
  const distStart = telemetry[0]?.DistanceTraveled ?? 0;
  let closest = 0;
  let closestDelta = Infinity;
  for (let i = 0; i < telemetry.length; i++) {
    const d = Math.abs((telemetry[i].DistanceTraveled - distStart) - distance);
    if (d < closestDelta) { closestDelta = d; closest = i; }
  }
  return closest;
}

/** Shared drawing logic for track outline + racing lines + position dots */
export function drawTrackCanvas(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  outline: Point[],
  telemetryA: TelemetryPacket[],
  telemetryB: TelemetryPacket[],
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
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const allBoundSets: Point[][] = [outline];
  if (boundaries && (boundaries.coordSystem === "forza" || boundaries.coordSystem === "f1-2025" || boundaries.coordSystem === "acc")) {
    allBoundSets.push(boundaries.leftEdge, boundaries.rightEdge);
  }
  for (const pts of allBoundSets) {
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }

  const trackRangeX = (maxX - minX) || 1;
  const trackRangeZ = (maxZ - minZ) || 1;
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

  const toCanvas = (x: number, z: number): [number, number] => [
    w / 2 + (viewCenterX - x) * sc,
    h / 2 + (z - viewCenterZ) * sc,
  ];

  // Car view: rotate map so car A always points up
  let needsRestore = false;
  if (followCar && zoom && hoveredDistance != null && telemetryA.length >= 2) {
    const pA = telemetryA[findTelemetryAtDistance(telemetryA, hoveredDistance)];
    if (pA && (pA.PositionX !== 0 || pA.PositionZ !== 0) && pA.Yaw !== undefined) {
      const [carCx, carCy] = toCanvas(telX(pA.PositionX), pA.PositionZ);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(Math.PI - pA.Yaw);
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
      ctx.fillStyle = "rgba(51, 65, 85, 0.18)";
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
      ctx.strokeStyle = "rgba(100, 116, 139, 0.3)";
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
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = zoom ? 6 : 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawOutlinePath();
    ctx.stroke();

    // Outline thin
    ctx.beginPath();
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = zoom ? 3 : 2;
    drawOutlinePath();
    ctx.stroke();

    // Start/finish marker
    const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
    ctx.beginPath();
    ctx.arc(sx, sy, zoom ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = "#10b981";
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Racing lines
  const drawRacingLine = (telemetry: TelemetryPacket[], color: string) => {
    if (telemetry.length < 2) return;
    const hasPos = telemetry.some(p => p.PositionX !== 0 || p.PositionZ !== 0);
    if (!hasPos) return;
    ctx.lineWidth = zoom ? 3 : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.strokeStyle = color;
    let moved = false;
    for (let i = 0; i < telemetry.length; i++) {
      const p = telemetry[i];
      if (p.PositionX === 0 && p.PositionZ === 0) continue;
      const [cx, cy] = toCanvas(telX!(p.PositionX), p.PositionZ);
      if (!moved) { ctx.moveTo(cx, cy); moved = true; }
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  drawRacingLine(telemetryA, COLOR_A);
  drawRacingLine(telemetryB, COLOR_B);

  // Position dots
  if (hoveredDistance != null) {
    const dotSize = zoom ? 7 : 5;
    const glowSize = zoom ? 14 : 10;
    const drawDot = (telemetry: TelemetryPacket[], color: string) => {
      if (telemetry.length < 2) return;
      const idx = findTelemetryAtDistance(telemetry, hoveredDistance);
      const p = telemetry[idx];
      if (!p || (p.PositionX === 0 && p.PositionZ === 0)) return;
      const [cx, cy] = toCanvas(telX!(p.PositionX), p.PositionZ);
      ctx.beginPath();
      ctx.arc(cx, cy, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = color + "33";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, dotSize, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Direction line from Yaw (heading)
      if (zoom && p.Yaw !== undefined) {
        const lineLen = 22;
        // Yaw: 0 = +Z, positive = clockwise from above
        // Canvas: X is flipped (viewCenterX - x), Z is normal (z - viewCenterZ)
        const dx = -Math.sin(p.Yaw) * lineLen;
        const dy = Math.cos(p.Yaw) * lineLen;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + dx, cy + dy);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    };
    drawDot(telemetryA, COLOR_A);
    drawDot(telemetryB, COLOR_B);
  }

  // Segment boundary markers (overview only)
  if (segmentPoints && !zoom) {
    for (const sp of segmentPoints) {
      const [px, py] = toCanvas(sp.x, sp.z);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = sp.type === "corner" ? "#fbbf24" : "#94a3b8";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
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
export function drawInputsHUD(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  pA: TelemetryPacket | null,
  pB: TelemetryPacket | null,
) {
  const barW = 14;
  const barH = 80;
  const wheelR = 28;
  const barGap = 4;
  const sectionGap = 16;
  const hudH = barH + 20; // total height with labels
  const y0 = h - hudH - 10;

  // Semi-transparent backdrop
  const totalW = (barW * 2 + barGap) * 2 + (wheelR * 2) * 2 + sectionGap * 4;
  const bx0 = (w - totalW) / 2;
  ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
  ctx.beginPath();
  ctx.roundRect(bx0 - 8, y0 - 14, totalW + 16, hudH + 18, 8);
  ctx.fill();

  let cx = bx0;

  // --- Brake bars (A orange, B blue) ---
  const drawBar = (x: number, frac: number, color: string, borderColor: string) => {
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(x, y0, barW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(x, y0 + barH * (1 - frac), barW, barH * frac);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y0, barW, barH);
  };

  const brakeA = pA ? pA.Brake / 255 : 0;
  const brakeB = pB ? pB.Brake / 255 : 0;
  drawBar(cx, brakeA, "#ef4444", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, brakeB, "#ef4444", COLOR_B);
  cx += barW + sectionGap;

  // Label
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.fillText("Brake", bx0 + barW + barGap / 2, y0 + barH + 14);

  // --- Steering wheel A ---
  const drawWheel = (wcx: number, wcy: number, steer: number, gear: number, color: string) => {
    // Outer ring
    ctx.beginPath();
    ctx.arc(wcx, wcy, wheelR, 0, Math.PI * 2);
    ctx.strokeStyle = "#334155";
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
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Gear number in center
    ctx.font = "bold 20px ui-monospace, monospace";
    ctx.fillStyle = "#e2e8f0";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gear > 0 ? String(gear) : gear === 0 ? "N" : "R", wcx, wcy);
    ctx.textBaseline = "alphabetic";
  };

  const steerA = pA ? pA.Steer : 0;
  const gearA = pA ? pA.Gear : 0;
  const wheelAcx = cx + wheelR;
  const wheelAcy = y0 + barH / 2 - 6;
  drawWheel(wheelAcx, wheelAcy, steerA, gearA, COLOR_A);
  cx += wheelR * 2 + sectionGap;

  // --- Steering wheel B ---
  const steerB = pB ? pB.Steer : 0;
  const gearB = pB ? pB.Gear : 0;
  const wheelBcx = cx + wheelR;
  const wheelBcy = y0 + barH / 2 - 6;
  drawWheel(wheelBcx, wheelBcy, steerB, gearB, COLOR_B);
  cx += wheelR * 2 + sectionGap;

  // Center label
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.fillText("Steering / Gear", (wheelAcx + wheelBcx) / 2, y0 + barH + 14);

  // --- Throttle bars (A orange, B blue) ---
  const throttleA = pA ? pA.Accel / 255 : 0;
  const throttleB = pB ? pB.Accel / 255 : 0;
  drawBar(cx, throttleA, "#22c55e", COLOR_A);
  cx += barW + barGap;
  drawBar(cx, throttleB, "#22c55e", COLOR_B);

  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "center";
  ctx.fillText("Throttle", cx - barGap / 2, y0 + barH + 14);
}

/** Compute zoom view centered on both car positions */
export function computeZoom(
  telemetryA: TelemetryPacket[],
  telemetryB: TelemetryPacket[],
  hoveredDistance: number,
  trackRange: number,
  telX: (x: number) => number = (x) => x,
): { centerX: number; centerZ: number; range: number } | null {
  const posA = telemetryA.length >= 2 ? telemetryA[findTelemetryAtDistance(telemetryA, hoveredDistance)] : null;
  const posB = telemetryB.length >= 2 ? telemetryB[findTelemetryAtDistance(telemetryB, hoveredDistance)] : null;
  const validA = posA && (posA.PositionX !== 0 || posA.PositionZ !== 0);
  const validB = posB && (posB.PositionX !== 0 || posB.PositionZ !== 0);

  if (!validA && !validB) return null;

  let cx: number, cz: number;
  if (validA && validB) {
    cx = (telX(posA.PositionX) + telX(posB.PositionX)) / 2;
    cz = (posA.PositionZ + posB.PositionZ) / 2;
  } else if (validA) {
    cx = telX(posA.PositionX); cz = posA.PositionZ;
  } else {
    cx = telX(posB!.PositionX); cz = posB!.PositionZ;
  }

  const zoomRange = trackRange * 0.02;
  let needed = zoomRange;
  if (validA && validB) {
    const spanX = Math.abs(telX(posA.PositionX) - telX(posB.PositionX));
    const spanZ = Math.abs(posA.PositionZ - posB.PositionZ);
    needed = Math.max(zoomRange, spanX * 2.5, spanZ * 2.5);
  }

  return { centerX: cx, centerZ: cz, range: needed };
}

export function formatSectionTime(seconds: number): string {
  if (seconds <= 0) return "-";
  return seconds.toFixed(3);
}

export function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

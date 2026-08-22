import type { AlignedTrace } from "@shared/racing/comparison/types";

export const COLOR_A = "var(--comparison-lap-a)";
export const COLOR_B = "var(--comparison-lap-b)";

export interface Point { x: number; z: number; }
export interface BoundaryData {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}

export function findTraceIndexAtDistance(distances: readonly number[], distance: number): number {
  if (distances.length === 0) return -1;
  if (distance <= distances[0]) return 0;
  const last = distances.length - 1;
  if (distance >= distances[last]) return last;
  let low = 0;
  let high = last;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = distances[mid];
    if (value === distance) {
      let first = mid;
      while (first > 0 && distances[first - 1] === distance) first--;
      return first;
    }
    if (value < distance) low = mid + 1;
    else high = mid - 1;
  }
  const right = Math.min(last, low);
  const left = Math.max(0, right - 1);
  return distance - distances[left] <= distances[right] - distance ? left : right;
}

function mapPosition(traces: AlignedTrace, index: number, outline: Point[], telX: (x: number) => number): Point | null {
  if (index < 0 || index >= traces.distance.length) return null;
  const x = traces.positionXA[index];
  const z = traces.positionZA[index];
  if (Number.isFinite(x) && Number.isFinite(z) && (x !== 0 || z !== 0)) return { x: telX(x), z };
  if (outline.length < 2) return null;
  const fraction = traces.distance.length > 1 ? index / (traces.distance.length - 1) : 0;
  return outline[Math.round(fraction * (outline.length - 1))] ?? null;
}

export function drawTrackCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  outline: Point[],
  traces: AlignedTrace,
  hoveredDistance: number | null,
  zoom: { centerX: number; centerZ: number; range: number } | null,
  segmentPoints?: Array<{ x: number; z: number; type: "corner" | "straight"; label: string }>,
  followCar = false,
  boundaries?: BoundaryData | null,
  telX: (x: number) => number = (x) => x,
  hideOutline = false,
) {
  ctx.clearRect(0, 0, w, h);
  const bounds = [...outline, ...(boundaries ? [boundaries.leftEdge, boundaries.rightEdge].flat() : [])];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of bounds) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const rangeX = maxX - minX || 1;
  const rangeZ = maxZ - minZ || 1;
  const centerX = zoom?.centerX ?? (minX + maxX) / 2;
  const centerZ = zoom?.centerZ ?? (minZ + maxZ) / 2;
  const range = zoom?.range ?? Math.max(rangeX, rangeZ);
  const scale = Math.min((w - 48) / range, (h - 48) / range);
  const toCanvas = (x: number, z: number): [number, number] => [w / 2 + (centerX - x) * scale, h / 2 + (z - centerZ) * scale];
  let restore = false;
  if (followCar && zoom && hoveredDistance != null) {
    const index = findTraceIndexAtDistance(traces.distance, hoveredDistance);
    const x = traces.positionXA[index], z = traces.positionZA[index], yaw = traces.yawA[index];
    if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(yaw) && (x !== 0 || z !== 0)) {
      const [cx, cy] = toCanvas(telX(x), z);
      ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(Math.PI - yaw); ctx.translate(-cx, -cy); restore = true;
    }
  }
  const drawPath = (points: Point[], color: string, width: number, close = false) => {
    if (points.length < 2) return;
    ctx.beginPath(); const [x, y] = toCanvas(points[0].x, points[0].z); ctx.moveTo(x, y);
    for (let i = 1; i < points.length; i++) { const [px, py] = toCanvas(points[i].x, points[i].z); ctx.lineTo(px, py); }
    if (close) ctx.closePath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };
  if (boundaries && boundaries.leftEdge.length > 1 && boundaries.rightEdge.length > 1) {
    const surface = [...boundaries.leftEdge, ...boundaries.rightEdge.slice().reverse()];
    ctx.beginPath(); const [sx, sy] = toCanvas(surface[0].x, surface[0].z); ctx.moveTo(sx, sy);
    for (const p of surface.slice(1)) { const [x, y] = toCanvas(p.x, p.z); ctx.lineTo(x, y); }
    ctx.closePath(); ctx.fillStyle = "color-mix(in srgb, var(--track-surface) 18%, transparent)"; ctx.fill();
    drawPath(boundaries.leftEdge, "color-mix(in srgb, var(--track-edge) 30%, transparent)", zoom ? 1.5 : 1);
    drawPath(boundaries.rightEdge, "color-mix(in srgb, var(--track-edge) 30%, transparent)", zoom ? 1.5 : 1);
  }
  if (!hideOutline) {
    drawPath(outline, "var(--track-outline)", zoom ? 6 : 5, true);
    drawPath(outline, "var(--track-outline-strong)", zoom ? 3 : 2, true);
    if (outline[0]) { const [x, y] = toCanvas(outline[0].x, outline[0].z); ctx.beginPath(); ctx.arc(x, y, zoom ? 5 : 4, 0, Math.PI * 2); ctx.fillStyle = "var(--track-start)"; ctx.fill(); }
  }
  const drawLine = (xs: number[], zs: number[], color: string) => {
    if (xs.length < 2 || !xs.some((x, i) => x !== 0 || zs[i] !== 0)) return;
    ctx.beginPath(); let moved = false;
    for (let i = 0; i < xs.length; i++) {
      if (!Number.isFinite(xs[i]) || !Number.isFinite(zs[i]) || (xs[i] === 0 && zs[i] === 0)) continue;
      const [x, y] = toCanvas(telX(xs[i]), zs[i]); if (!moved) { ctx.moveTo(x, y); moved = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = zoom ? 3 : 2; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;
  };
  drawLine(traces.positionXA, traces.positionZA, COLOR_A);
  drawLine(traces.positionXB, traces.positionZB, COLOR_B);
  if (hoveredDistance != null) {
    const index = findTraceIndexAtDistance(traces.distance, hoveredDistance);
    const a = mapPosition(traces, index, outline, telX);
    const b = mapPosition({ ...traces, positionXA: traces.positionXB, positionZA: traces.positionZB }, index, outline, telX);
    const ca = a ? toCanvas(a.x, a.z) : null, cb = b ? toCanvas(b.x, b.z) : null;
    const overlap = ca && cb && Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < 14;
    const dot = (p: Point | null, color: string, offset: number, yaw?: number) => {
      if (!p) return; const [x, y] = toCanvas(p.x, p.z); ctx.beginPath(); ctx.arc(x + offset, y, zoom ? 7 : 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      if (zoom && yaw != null) { ctx.beginPath(); ctx.moveTo(x + offset, y); ctx.lineTo(x + offset - Math.sin(yaw) * 22, y + Math.cos(yaw) * 22); ctx.strokeStyle = "var(--app-text)"; ctx.lineWidth = 2.5; ctx.stroke(); }
    };
    dot(a, COLOR_A, overlap ? -6 : 0, traces.yawA[index]); dot(b, COLOR_B, overlap ? 6 : 0, traces.yawB[index]);
  }
  if (segmentPoints && !zoom) for (const point of segmentPoints) { const [x, y] = toCanvas(point.x, point.z); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = point.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)"; ctx.fill(); }
  if (restore) ctx.restore();
}

export function drawInputsHUD(ctx: CanvasRenderingContext2D, w: number, h: number, traces: AlignedTrace, index: number) {
  if (index < 0) return;
  const barW = 14, barH = 80, wheelR = 28, gap = 16, y = h - barH - 30, total = 2 * (barW * 2 + 4) + wheelR * 4 + gap * 4;
  let x = (w - total) / 2;
  const bar = (value: number, color: string, border: string) => { ctx.fillStyle = "var(--app-surface-alt)"; ctx.fillRect(x, y, barW, barH); ctx.fillStyle = color; ctx.fillRect(x, y + barH * (1 - value), barW, barH * value); ctx.strokeStyle = border; ctx.strokeRect(x, y, barW, barH); x += barW + 4; };
  bar(traces.brakeA[index] ?? 0, "var(--ch-brake)", COLOR_A); bar(traces.brakeB[index] ?? 0, "var(--ch-brake)", COLOR_B); x += gap;
  const wheel = (steer: number, gear: number, color: string) => { const cx = x + wheelR, cy = y + barH / 2; ctx.beginPath(); ctx.arc(cx, cy, wheelR, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(steer / 127) * wheelR, cy - Math.cos(steer / 127) * wheelR); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = "var(--app-text)"; ctx.font = "bold 20px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(gear > 0 ? String(gear) : gear === 0 ? "N" : "R", cx, cy); ctx.textBaseline = "alphabetic"; x += wheelR * 2 + gap; };
  wheel(traces.steerA[index] ?? 0, traces.gearA[index] ?? 0, COLOR_A); wheel(traces.steerB[index] ?? 0, traces.gearB[index] ?? 0, COLOR_B); x += gap;
  bar(traces.throttleA[index] ?? 0, "var(--ch-throttle)", COLOR_A); bar(traces.throttleB[index] ?? 0, "var(--ch-throttle)", COLOR_B);
}

export function computeZoom(traces: AlignedTrace, hoveredDistance: number, trackRange: number, telX: (x: number) => number = (x) => x, outline: Point[] = []) {
  const index = findTraceIndexAtDistance(traces.distance, hoveredDistance);
  const a = mapPosition(traces, index, outline, telX);
  const b = mapPosition({ ...traces, positionXA: traces.positionXB, positionZA: traces.positionZB }, index, outline, telX);
  if (!a && !b) return null;
  const centerX = a && b ? (a.x + b.x) / 2 : (a ?? b)!.x;
  const centerZ = a && b ? (a.z + b.z) / 2 : (a ?? b)!.z;
  return { centerX, centerZ, range: Math.max(trackRange * 0.02, a && b ? Math.max(Math.abs(a.x - b.x) * 2.5, Math.abs(a.z - b.z) * 2.5) : 0) };
}

export function formatSectionTime(seconds: number): string { return seconds <= 0 ? "-" : seconds.toFixed(3); }

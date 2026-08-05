import { SECTOR_COLOR_VARS } from "@/lib/colors";
import { drawPitRoadLayer } from "@/lib/canvas/draw-track";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import { semanticNumber, type Point, type SemanticAnalysisFrame, type SectorBoundaries, type TrackHighlight, type TrackMapBoundaries, type TrackMapLabel, type TrackTransform } from "./types";

const HIGHLIGHT_COLORS: Record<TrackHighlight["color"], { stroke: string; width: number }> = {
  good: { stroke: "color-mix(in srgb, var(--severity-nominal) 70%, transparent)", width: 6 },
  warning: { stroke: "color-mix(in srgb, var(--severity-caution) 70%, transparent)", width: 6 },
  critical: { stroke: "color-mix(in srgb, var(--severity-critical) 70%, transparent)", width: 6 },
};

export interface StaticTrackOptions {
  canvas: HTMLCanvasElement;
  bufferCanvas: HTMLCanvasElement | null;
  telemetry: SemanticAnalysisFrame[];
  gameId?: import("../../../../../shared/games/ids").GameId;
  resolvedPositions: Point[];
  outline: Point[] | null;
  mapLabels?: TrackMapLabel[] | null;
  pitRoad?: Point[][] | null;
  sectors: SectorBoundaries | null;
  boundaries: TrackMapBoundaries | null;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  highlights?: TrackHighlight[] | null;
  showInputs?: boolean;
  showTrace: boolean;
  rotateWithCar: boolean;
  zoom: number;
}
export function drawStaticTrack(options: StaticTrackOptions): { bufferCanvas: HTMLCanvasElement | null; transform: TrackTransform | null } {
  const { canvas, telemetry, gameId, resolvedPositions, outline, mapLabels, pitRoad, boundaries, sectors, segments, highlights, showInputs, showTrace, rotateWithCar, zoom } = options;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { bufferCanvas: options.bufferCanvas, transform: null };
  const w = rect.width;
  const h = rect.height;
  syncCanvasSize(canvas, w, h, window.devicePixelRatio || 1, false);

  const telemetryPointsWithIdx = resolvedPositions.map((point, idx) => ({ ...point, idx })).filter((point, index) => index === 0 || point.x !== 0 || point.z !== 0);
  const telemetryPoints = telemetryPointsWithIdx as Point[];
  const displayOutline: Point[] = !showTrace ? (outline ?? (telemetryPoints.length > 2 ? telemetryPoints : [])) : telemetryPoints.length > 2 ? telemetryPoints : (outline ?? []);
  if (displayOutline.length < 2) return { bufferCanvas: null, transform: null };
  const flip = needsTrackFlip(gameId);
  const flippedLeft = flip && boundaries?.leftEdge ? flipPoints(boundaries.leftEdge) : boundaries?.leftEdge;
  const flippedRight = flip && boundaries?.rightEdge ? flipPoints(boundaries.rightEdge) : boundaries?.rightEdge;
  const flippedPitRoad = flip && pitRoad ? pitRoad.map((contour) => flipPoints(contour)) : pitRoad;
  const hasBounds = !!(boundaries?.coordSystem && flippedLeft && flippedLeft.length > 2);
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  const allBoundsPts: Point[][] = [displayOutline];
  if (hasBounds) allBoundsPts.push(flippedLeft!, flippedRight!);
  if (mapLabels?.length) allBoundsPts.push(mapLabels);
  if (flippedPitRoad?.length) allBoundsPts.push(...flippedPitRoad);
  for (const pts of allBoundsPts)
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  const rangeX = maxX - minX || 1;
  const rangeZ = maxZ - minZ || 1;
  const padding = 40;
  const baseScale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
  const scale = baseScale * zoom * (rotateWithCar ? 3 : 1);
  const trackW = rangeX * scale + padding * 2;
  const trackH = rangeZ * scale + padding * 2;
  const offW = Math.max(w, trackW);
  const offH = Math.max(h, trackH);
  const offsetX = (offW - rangeX * scale) / 2;
  const offsetZ = (offH - rangeZ * scale) / 2;
  const transform: TrackTransform = { w, h, offsetX, offsetZ, scale, maxX, minZ, displayOutline, offW, offH };
  const toCanvas = (x: number, z: number): [number, number] => [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];

  const bufferCanvas = options.bufferCanvas ?? document.createElement("canvas");
  syncCanvasSize(bufferCanvas, offW, offH, window.devicePixelRatio || 1, false);
  const ctx = getSemanticCanvasContext(bufferCanvas)!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bufferCanvas.width, bufferCanvas.height);
  ctx.setTransform(bufferCanvas.width / offW, 0, 0, bufferCanvas.height / offH, 0, 0);

  drawPitRoadLayer(ctx, flippedPitRoad, toCanvas);
  if (hasBounds) {
    const left = flippedLeft!;
    const right = flippedRight!;
    ctx.beginPath();
    ctx.moveTo(...toCanvas(left[0].x, left[0].z));
    for (let i = 1; i < left.length; i++) ctx.lineTo(...toCanvas(left[i].x, left[i].z));
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(...toCanvas(right[i].x, right[i].z));
    ctx.closePath();
    ctx.fillStyle = "color-mix(in srgb, var(--track-surface) 25%, transparent)";
    ctx.fill();
    ctx.strokeStyle = "color-mix(in srgb, var(--track-edge) 35%, transparent)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(...toCanvas(left[0].x, left[0].z));
    for (let i = 1; i < left.length; i++) ctx.lineTo(...toCanvas(left[i].x, left[i].z));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...toCanvas(right[0].x, right[0].z));
    for (let i = 1; i < right.length; i++) ctx.lineTo(...toCanvas(right[i].x, right[i].z));
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.strokeStyle = showInputs ? "var(--track-outline-strong)" : "var(--track-outline)";
  ctx.lineWidth = showInputs ? 0.75 : 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [sx, sy] = toCanvas(displayOutline[0].x, displayOutline[0].z);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < displayOutline.length; i++) ctx.lineTo(...toCanvas(displayOutline[i].x, displayOutline[i].z));
  if (outline) ctx.lineTo(sx, sy);
  ctx.stroke();

  const n = displayOutline.length;
  const cumDist = [0];
  for (let i = 1; i < n; i++) cumDist.push(cumDist[i - 1] + Math.hypot(displayOutline[i].x - displayOutline[i - 1].x, displayOutline[i].z - displayOutline[i - 1].z));
  const totalDist = cumDist[n - 1] || 1;
  const fracToIdx = (frac: number) => {
    const targetDist = frac * totalDist;
    let lo = 0,
      hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] < targetDist) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const drawRange = (startFrac: number, endFrac: number, strokeStyle: string, lineWidth: number) => {
    const startIdx = fracToIdx(startFrac),
      endIdx = fracToIdx(endFrac);
    if (startIdx >= endIdx) return;
    ctx.beginPath();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.moveTo(...toCanvas(displayOutline[startIdx].x, displayOutline[startIdx].z));
    for (let i = startIdx + 1; i <= endIdx && i < n; i++) ctx.lineTo(...toCanvas(displayOutline[i].x, displayOutline[i].z));
    ctx.stroke();
  };

  if (sectors && displayOutline.length > 10 && !showInputs) {
    const bounds = [...sectors.sectorStarts, 1];
    for (let si = 0; si < sectors.sectorCount; si++) drawRange(bounds[si], bounds[si + 1], SECTOR_COLOR_VARS[si % SECTOR_COLOR_VARS.length], 2.5);
  } else if (segments?.length && !showInputs) {
    const labelCandidates: { text: string; x: number; y: number; priority: number }[] = [];
    const labelledNames = new Set<string>();
    for (const seg of segments) {
      const startIdx = fracToIdx(seg.startFrac),
        endIdx = fracToIdx(seg.endFrac);
      if (startIdx >= endIdx) continue;
      drawRange(seg.startFrac, seg.endFrac, seg.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)", 2.5);
      if (!mapLabels?.length && seg.name && !labelledNames.has(seg.name)) {
        labelledNames.add(seg.name);
        const midIdx = Math.round((startIdx + endIdx) / 2);
        const point = displayOutline[Math.min(midIdx, n - 1)];
        const previous = displayOutline[Math.max(0, midIdx - 2)],
          next = displayOutline[Math.min(n - 1, midIdx + 2)];
        const dx = next.x - previous.x,
          dz = next.z - previous.z,
          length = Math.hypot(dx, dz) || 1;
        const [labelX, labelY] = toCanvas(point.x, point.z);
        labelCandidates.push({ text: seg.name, x: labelX + (-dz / length) * 14, y: labelY + (dx / length) * 14, priority: seg.type === "corner" ? 1 : 0 });
      }
    }
    ctx.font = "var(--font-weight-bold) var(--text-app-micro) var(--font-mono)";
    ctx.textAlign = "center";
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    for (const label of labelCandidates.sort((a, b) => b.priority - a.priority)) {
      const width = ctx.measureText(label.text).width + 8;
      const rect = { x: label.x - width / 2, y: label.y - 10, w: width, h: 14 };
      if (
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.w > offW ||
        rect.y + rect.h > offH ||
        occupied.some((other) => rect.x < other.x + other.w && rect.x + rect.w > other.x && rect.y < other.y + other.h && rect.y + rect.h > other.y)
      )
        continue;
      occupied.push(rect);
      ctx.fillStyle = "color-mix(in srgb, var(--track-label-background) 88%, transparent)";
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 3);
      ctx.fill();
      ctx.fillStyle = "var(--track-label-text)";
      ctx.fillText(label.text, label.x, label.y);
    }
  } else {
    ctx.beginPath();
    ctx.strokeStyle = "var(--track-edge)";
    ctx.lineWidth = 2;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) ctx.lineTo(...toCanvas(displayOutline[i].x, displayOutline[i].z));
    if (outline) ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  if (mapLabels?.length && !showInputs) {
    ctx.font = "var(--font-weight-bold) var(--text-app-micro) var(--font-mono)";
    ctx.textAlign = "center";
    for (const label of mapLabels) {
      const [labelX, labelY] = toCanvas(label.x, label.z);
      const width = ctx.measureText(label.text).width + 6;
      ctx.fillStyle = "color-mix(in srgb, var(--track-label-background) 82%, transparent)";
      ctx.beginPath();
      ctx.roundRect(labelX - width / 2, labelY - 10, width, 13, 3);
      ctx.fill();
      ctx.fillStyle = "var(--track-label-text)";
      ctx.fillText(label.text, labelX, labelY);
    }
  }
  if (highlights?.length)
    for (const hl of highlights) {
      const style = HIGHLIGHT_COLORS[hl.color];
      drawRange(hl.startFrac, hl.endFrac, style.stroke, style.width);
    }

  if (outline) {
    const [sfCx, sfCy] = toCanvas(displayOutline[0].x, displayOutline[0].z);
    ctx.beginPath();
    ctx.arc(sfCx, sfCy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "var(--track-start)";
    ctx.fill();
    ctx.strokeStyle = "var(--track-label-background)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (sectors && displayOutline.length > 10) {
    for (let si = 0; si < sectors.sectorStarts.slice(1).length; si++) {
      const pt = displayOutline[fracToIdx(sectors.sectorStarts.slice(1)[si])];
      if (!pt) continue;
      const [mx, my] = toCanvas(pt.x, pt.z);
      const prev = displayOutline[Math.max(0, fracToIdx(sectors.sectorStarts.slice(1)[si]) - 3)],
        next = displayOutline[Math.min(displayOutline.length - 1, fracToIdx(sectors.sectorStarts.slice(1)[si]) + 3)];
      const dx = next.x - prev.x,
        dz = next.z - prev.z,
        len = Math.hypot(dx, dz);
      if (len > 0) {
        const nx = dz / len,
          nz = -dx / len;
        ctx.beginPath();
        ctx.moveTo(mx - nx * 8, my + nz * 8);
        ctx.lineTo(mx + nx * 8, my - nz * 8);
        ctx.strokeStyle = SECTOR_COLOR_VARS[si % SECTOR_COLOR_VARS.length];
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fillStyle = SECTOR_COLOR_VARS[si % SECTOR_COLOR_VARS.length];
      ctx.fill();
      ctx.strokeStyle = "var(--track-label-background)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  if (showInputs && telemetryPoints.length > 2) {
    for (let i = 1; i < telemetryPoints.length; i++) {
      const [x0, y0] = toCanvas(telemetryPoints[i - 1].x, telemetryPoints[i - 1].z),
        [x1, y1] = toCanvas(telemetryPoints[i].x, telemetryPoints[i].z);
      const dx = x1 - x0,
        dy = y1 - y0,
        len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const nx = -dy / len,
        ny = dx / len,
        frame = telemetry[telemetryPointsWithIdx[i].idx];
      if (!frame) continue;
      const throttle = (semanticNumber(frame, "inputs.accel") ?? 0) / 255;
      const brake = (semanticNumber(frame, "inputs.brake") ?? 0) / 255;
      if (throttle > 0) {
        ctx.beginPath();
        ctx.moveTo(x0 + nx * 1.5, y0 + ny * 1.5);
        ctx.lineTo(x1 + nx * 1.5, y1 + ny * 1.5);
        ctx.globalAlpha = 0.35 + throttle * 0.65;
        ctx.strokeStyle = "var(--ch-throttle)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (brake > 0) {
        ctx.beginPath();
        ctx.moveTo(x0 - nx * 1.5, y0 - ny * 1.5);
        ctx.lineTo(x1 - nx * 1.5, y1 - ny * 1.5);
        ctx.globalAlpha = brake;
        ctx.strokeStyle = "var(--ch-brake)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
  if (!rotateWithCar) {
    const mainCtx = getSemanticCanvasContext(canvas);
    if (mainCtx) {
      mainCtx.save();
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);
      mainCtx.clearRect(0, 0, canvas.width, canvas.height);
      mainCtx.restore();
      mainCtx.save();
      mainCtx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
      mainCtx.drawImage(bufferCanvas, 0, 0, w, h);
      mainCtx.restore();
    }
  }
  return { bufferCanvas, transform };
}

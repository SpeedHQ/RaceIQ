import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { resolveFrameDirection } from "./path";
import type { Point, SemanticAnalysisFrame, TrackTransform } from "./types";

export interface OverlayOptions {
  canvas: HTMLCanvasElement;
  carCanvas: HTMLCanvasElement;
  bufferCanvas: HTMLCanvasElement | null;
  telemetry: SemanticAnalysisFrame[];
  resolvedPositions: Point[];
  resolvedDirections: ([number, number] | null)[];
  transform: TrackTransform | null;
}

const direction = (frame: SemanticAnalysisFrame, path: [number, number] | null): [number, number] | null => resolveFrameDirection(frame, path);

export function compositeTrack(options: OverlayOptions, idx: number): void {
  const { canvas, telemetry, resolvedPositions, resolvedDirections, transform: t, bufferCanvas } = options;
  if (!bufferCanvas || !t) return;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(canvas.width / t.w, 0, 0, canvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const frame = telemetry[idx], position = resolvedPositions[idx], path = resolvedDirections[idx];
  if (frame && position) {
    const resolvedDirection = direction(frame, path);
    const heading = resolvedDirection ? Math.atan2(resolvedDirection[0], resolvedDirection[1]) : 0;
    const cx = t.offsetX + (t.maxX - position.x) * t.scale, cy = t.offsetZ + (position.z - t.minZ) * t.scale;
    ctx.translate(t.w / 2, t.h / 2);
    ctx.rotate(Math.PI - heading);
    ctx.translate(-cx, -cy);
  }
  ctx.drawImage(bufferCanvas, 0, 0, t.offW, t.offH);
  if (frame && position) {
    const cx = t.offsetX + (t.maxX - position.x) * t.scale, cy = t.offsetZ + (position.z - t.minZ) * t.scale;
    const resolvedDirection = direction(frame, path);
    if (!resolvedDirection) {
      ctx.restore();
      return;
    }
    const [dx, dz] = resolvedDirection, fx = t.offsetX + (t.maxX - (position.x + dx)) * t.scale, fy = t.offsetZ + (position.z + dz - t.minZ) * t.scale;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(fy - cy, fx - cx));
    ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4.8, -4.8); ctx.lineTo(-4.8, 4.8); ctx.closePath();
    ctx.fillStyle = "var(--app-accent)"; ctx.fill(); ctx.strokeStyle = "var(--track-label-background)"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  }
  ctx.restore();
}

export function drawCarOverlay(options: OverlayOptions, idx: number): { x: number; y: number; w: number; h: number; angle?: number } | null {
  const { carCanvas, telemetry, resolvedPositions, resolvedDirections, transform: t } = options;
  if (!t) return null;
  syncCanvasSize(carCanvas, t.w, t.h, window.devicePixelRatio || 1, false);
  const ctx = getSemanticCanvasContext(carCanvas); if (!ctx) return null;
  ctx.setTransform(carCanvas.width / t.w, 0, 0, carCanvas.height / t.h, 0, 0); ctx.clearRect(0, 0, t.w, t.h);
  const frame = telemetry[idx], position = resolvedPositions[idx]; if (!frame || !position) return null;
  const sx = t.w / t.offW, sy = t.h / t.offH, toCanvas = (x: number, z: number): [number, number] => [(t.offsetX + (t.maxX - x) * t.scale) * sx, (t.offsetZ + (z - t.minZ) * t.scale) * sy];
  const resolvedDirection = direction(frame, resolvedDirections[idx]);
  if (!resolvedDirection) return null;
  const [cx, cy] = toCanvas(position.x, position.z), [dx, dz] = resolvedDirection, [fx, fy] = toCanvas(position.x + dx, position.z + dz), angle = Math.atan2(fy - cy, fx - cx);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4.8, -4.8); ctx.lineTo(-4.8, 4.8); ctx.closePath(); ctx.fillStyle = "var(--app-accent)"; ctx.fill(); ctx.strokeStyle = "var(--track-label-background)"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  return { x: cx, y: cy, w: t.w, h: t.h, angle };
}

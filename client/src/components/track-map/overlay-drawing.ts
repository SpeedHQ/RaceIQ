import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { semanticNumber, type Point, type SemanticAnalysisFrame, type TrackMapViewportCamera, type TrackTransform } from "./types";

export interface OverlayOptions {
  canvas: HTMLCanvasElement;
  carCanvas: HTMLCanvasElement;
  bufferCanvas: HTMLCanvasElement | null;
  telemetry: SemanticAnalysisFrame[];
  resolvedPositions: Point[];
  resolvedDirections: ([number, number] | null)[];
  transform: TrackTransform | null;
  panX: number;
  panY: number;
  showCar?: boolean;
}

export interface CarOverlayPosition {
  x: number;
  y: number;
  w: number;
  h: number;
  angle?: number;
}
export function applyTrackMapOverlayCamera(
  context: CanvasRenderingContext2D,
  transform: TrackTransform,
  pan: Readonly<{ x: number; y: number }>,
  viewport: TrackMapViewportCamera | null | undefined,
  directVectorRender: boolean,
): void {
  if (viewport) {
    context.translate(transform.w / 2 + pan.x, transform.h / 2 + pan.y);
    context.rotate(viewport.rotation ?? 0);
    context.translate(-transform.w / 2, -transform.h / 2);
  } else if (directVectorRender) {
    context.translate(pan.x, pan.y);
  } else {
    context.translate((transform.w - transform.offW) / 2 + pan.x, (transform.h - transform.offH) / 2 + pan.y);
  }
}

export function drawCarPulse(context: CanvasRenderingContext2D, position: CarOverlayPosition, nowMs: number): void {
  const cycle = nowMs % 2500;
  if (cycle > 1000) return;
  const progress = cycle / 1000;
  const eased = 1 - (1 - progress) ** 3;
  const size = 10 + eased * 6;
  context.save();
  context.translate(position.x, position.y);
  if (position.angle !== undefined) context.rotate(position.angle);
  context.beginPath();
  context.moveTo(size, 0);
  context.lineTo(-size * 0.6, -size * 0.6);
  context.lineTo(-size * 0.6, size * 0.6);
  context.closePath();
  context.globalAlpha = 0.8 * (1 - progress);
  context.strokeStyle = "var(--app-accent)";
  context.lineWidth = 2;
  context.stroke();
  context.restore();
}

const direction = (frame: SemanticAnalysisFrame, path: [number, number] | null): [number, number] =>
  path ?? [Math.sin(semanticNumber(frame, "motion.yaw") ?? 0), Math.cos(semanticNumber(frame, "motion.yaw") ?? 0)];
export function compositeFixedTrack(options: OverlayOptions): void {
  const { canvas, bufferCanvas, transform: t, panX, panY } = options;
  if (!bufferCanvas || !t) return;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(canvas.width / t.w, 0, 0, canvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, t.w, t.h);
  ctx.drawImage(bufferCanvas, (t.w - t.offW) / 2 + panX, (t.h - t.offH) / 2 + panY, t.offW, t.offH);
  ctx.restore();
}

export function compositeTrack(options: OverlayOptions, idx: number): void {
  const { canvas, telemetry, resolvedPositions, resolvedDirections, transform: t, bufferCanvas, panX, panY, showCar = true } = options;
  if (!bufferCanvas || !t) return;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(canvas.width / t.w, 0, 0, canvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const frame = telemetry[idx],
    position = resolvedPositions[idx],
    path = resolvedDirections[idx];
  if (showCar && frame && position) {
    const cx = t.offsetX + (t.maxX - position.x) * t.scale,
      cy = t.offsetZ + (position.z - t.minZ) * t.scale;
    ctx.translate(t.w / 2 + panX, t.h / 2 + panY);
    ctx.rotate(path ? -Math.PI / 2 - Math.atan2(path[1], -path[0]) : Math.PI - (semanticNumber(frame, "motion.yaw") ?? 0));
    ctx.translate(-cx, -cy);
  }
  ctx.drawImage(bufferCanvas, 0, 0, t.offW, t.offH);
  if (showCar && frame && position) {
    const cx = t.offsetX + (t.maxX - position.x) * t.scale,
      cy = t.offsetZ + (position.z - t.minZ) * t.scale;
    const [dx, dz] = direction(frame, path),
      fx = t.offsetX + (t.maxX - (position.x + dx)) * t.scale,
      fy = t.offsetZ + (position.z + dz - t.minZ) * t.scale;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(fy - cy, fx - cx));
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-4.8, -4.8);
    ctx.lineTo(-4.8, 4.8);
    ctx.closePath();
    ctx.fillStyle = "var(--app-accent)";
    ctx.fill();
    ctx.strokeStyle = "var(--track-label-background)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
export function drawCarOverlay(options: OverlayOptions, idx: number): CarOverlayPosition | null {
  const { carCanvas, telemetry, resolvedPositions, resolvedDirections, transform: t, panX, panY, showCar = true } = options;
  if (!t) return null;
  syncCanvasSize(carCanvas, t.w, t.h, window.devicePixelRatio || 1, false);
  const ctx = getSemanticCanvasContext(carCanvas);
  if (!ctx) return null;
  ctx.setTransform(carCanvas.width / t.w, 0, 0, carCanvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, t.w, t.h);
  if (!showCar) return null;
  const frame = telemetry[idx],
    position = resolvedPositions[idx];
  if (!frame || !position) return null;
  const offsetX = (t.w - t.offW) / 2 + panX,
    offsetY = (t.h - t.offH) / 2 + panY,
    toCanvas = (x: number, z: number): [number, number] => [offsetX + t.offsetX + (t.maxX - x) * t.scale, offsetY + t.offsetZ + (z - t.minZ) * t.scale];
  const [cx, cy] = toCanvas(position.x, position.z),
    [dx, dz] = direction(frame, resolvedDirections[idx]),
    [fx, fy] = toCanvas(position.x + dx, position.z + dz),
    angle = Math.atan2(fy - cy, fx - cx);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-4.8, -4.8);
  ctx.lineTo(-4.8, 4.8);
  ctx.closePath();
  ctx.fillStyle = "var(--app-accent)";
  ctx.fill();
  ctx.strokeStyle = "var(--track-label-background)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  return { x: cx, y: cy, w: t.w, h: t.h, angle };
}

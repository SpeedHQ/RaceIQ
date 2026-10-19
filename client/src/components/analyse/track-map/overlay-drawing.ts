import type { SceneBuilder } from "./scene";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { interpolateReplayPosition, resolveFrameDirection } from "./path";
import type { Point, SemanticAnalysisFrame, TrackTransform } from "./types";

export interface OverlayOptions {
  canvas: HTMLCanvasElement;
  carCanvas: HTMLCanvasElement;
  scene: SceneBuilder | null;
  telemetry: SemanticAnalysisFrame[];
  resolvedPositions: Point[];
  resolvedDirections: ([number, number] | null)[];
  transform: TrackTransform | null;
}


const direction = (frame: SemanticAnalysisFrame, path: [number, number] | null): [number, number] | null => resolveFrameDirection(frame, path);

function interpolatedDirection(options: OverlayOptions, cursorIndex: number): [number, number] | null {
  const { telemetry, resolvedDirections } = options;
  if (telemetry.length === 0 || !Number.isFinite(cursorIndex)) return null;
  const index = Math.max(0, Math.min(telemetry.length - 1, cursorIndex));
  const lower = Math.floor(index);
  const fraction = index - lower;
  const first = direction(telemetry[lower]!, resolvedDirections[lower] ?? null);
  if (fraction === 0 || lower + 1 >= telemetry.length) return first;
  const second = direction(telemetry[lower + 1]!, resolvedDirections[lower + 1] ?? null);
  if (!first || !second) return first ?? second;
  const firstAngle = Math.atan2(first[0], first[1]);
  const secondAngle = Math.atan2(second[0], second[1]);
  let angleDelta = secondAngle - firstAngle;
  if (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
  else if (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
  const angle = firstAngle + angleDelta * fraction;
  return [Math.sin(angle), Math.cos(angle)];
}

function cursorState(options: OverlayOptions, cursorIndex: number) {
  const { telemetry, resolvedPositions } = options;
  if (telemetry.length === 0 || !Number.isFinite(cursorIndex)) return null;
  const index = Math.max(0, Math.min(telemetry.length - 1, cursorIndex));
  const frame = telemetry[Math.floor(index)];
  const position = interpolateReplayPosition(resolvedPositions, index);
  if (!frame || !position) return null;
  return { frame, position, path: interpolatedDirection(options, index) };
}

export function compositeTrack(options: OverlayOptions, cursorIndex: number): void {
  const { canvas, transform: t, scene } = options;
  if (!scene || !t) return;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(canvas.width / t.w, 0, 0, canvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, t.w, t.h);
  const cursor = cursorState(options, cursorIndex);
  const { frame, position, path } = cursor ?? {};
  const validPosition = !!frame && !!position;
  let cx = 0, cy = 0, heading = 0;
  if (frame && position) {
    const resolvedDirection = direction(frame, path ?? null);
    heading = resolvedDirection ? Math.atan2(resolvedDirection[0], resolvedDirection[1]) : 0;
    cx = t.offsetX + (t.maxX - position.x) * t.scale;
    cy = t.offsetZ + (position.z - t.minZ) * t.scale;
    ctx.translate(t.w / 2, t.h / 2);
    ctx.rotate(Math.PI - heading);
    ctx.translate(-cx, -cy);
  }
  const sin = Math.abs(Math.sin(heading)), cos = Math.abs(Math.cos(heading));
  const extentX = (cos * t.w + sin * t.h) / 2;
  const extentY = (sin * t.w + cos * t.h) / 2;
  scene.renderView(
    ctx,
    validPosition ? cx - extentX : 0,
    validPosition ? cy - extentY : 0,
    validPosition ? cx + extentX : t.w,
    validPosition ? cy + extentY : t.h,
  );
  if (validPosition && frame && position) {
    const resolvedDirection = direction(frame, path ?? null);
    if (resolvedDirection) {
      const [dx, dz] = resolvedDirection,
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
  }
  ctx.restore();
}

export function drawCarOverlay(options: OverlayOptions, cursorIndex: number): { x: number; y: number; w: number; h: number; angle?: number } | null {
  const { carCanvas, transform: t } = options;
  if (!t) return null;
  syncCanvasSize(carCanvas, t.w, t.h, window.devicePixelRatio || 1, false);
  const ctx = getSemanticCanvasContext(carCanvas);
  if (!ctx) return null;
  ctx.setTransform(carCanvas.width / t.w, 0, 0, carCanvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, t.w, t.h);
  const cursor = cursorState(options, cursorIndex);
  if (!cursor) return null;
  const { position, path } = cursor;
  const sx = t.w / t.offW,
    sy = t.h / t.offH,
    toCanvas = (x: number, z: number): [number, number] => [(t.offsetX + (t.maxX - x) * t.scale) * sx, (t.offsetZ + (z - t.minZ) * t.scale) * sy];
  const resolvedDirection = direction(cursor.frame, path);
  if (!resolvedDirection) return null;
  const [cx, cy] = toCanvas(position.x, position.z),
    [dx, dz] = resolvedDirection,
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

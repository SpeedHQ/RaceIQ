import { tryGetGame } from "@shared/games/registry";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import type { TelemetryPacket } from "../../../../../shared/telemetry/types";
import type { Point, TrackTransform } from "./types";

export interface OverlayOptions {
  canvas: HTMLCanvasElement;
  carCanvas: HTMLCanvasElement;
  bufferCanvas: HTMLCanvasElement | null;
  telemetry: TelemetryPacket[];
  resolvedPositions: Point[];
  resolvedDirections: ([number, number] | null)[];
  transform: TrackTransform | null;
}

export function compositeTrack(options: OverlayOptions, idx: number): void {
  const { canvas, telemetry, resolvedPositions, resolvedDirections, transform: t, bufferCanvas } = options;
  if (!bufferCanvas || !t) return;
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx) return;
  const scaleX = canvas.width / t.w,
    scaleY = canvas.height / t.h;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  const pkt = telemetry[idx],
    position = resolvedPositions[idx],
    game = pkt ? tryGetGame(pkt.gameId) : undefined;
  const pathDirection = game?.coordSystem === "lap-distance" ? resolvedDirections[idx] : null;
  if (pkt && position) {
    const carCx = t.offsetX + (t.maxX - position.x) * t.scale,
      carCy = t.offsetZ + (position.z - t.minZ) * t.scale;
    ctx.translate(t.w / 2, t.h / 2);
    const rotation = pathDirection ? -Math.PI / 2 - Math.atan2(pathDirection[1], -pathDirection[0]) : (game?.followViewRotation(pkt.Yaw) ?? Math.PI - pkt.Yaw);
    ctx.rotate(rotation);
    ctx.translate(-carCx, -carCy);
  }
  ctx.drawImage(bufferCanvas, 0, 0, t.offW, t.offH);
  const pkt2 = telemetry[idx],
    position2 = resolvedPositions[idx];
  if (pkt2 && position2) {
    const cx = t.offsetX + (t.maxX - position2.x) * t.scale,
      cy = t.offsetZ + (position2.z - t.minZ) * t.scale;
    const [dx, dz] = pathDirection ?? game?.carForwardOffset(pkt2.Yaw) ?? [Math.sin(pkt2.Yaw), Math.cos(pkt2.Yaw)];
    const fx = t.offsetX + (t.maxX - (position2.x + dx)) * t.scale,
      fy = t.offsetZ + (position2.z + dz - t.minZ) * t.scale;
    const angle = Math.atan2(fy - cy, fx - cx),
      triSize = 8;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(triSize, 0);
    ctx.lineTo(-triSize * 0.6, -triSize * 0.6);
    ctx.lineTo(-triSize * 0.6, triSize * 0.6);
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

export function drawCarOverlay(options: OverlayOptions, idx: number): { x: number; y: number; w: number; h: number; angle?: number } | null {
  const { carCanvas, telemetry, resolvedPositions, resolvedDirections, transform: t } = options;
  if (!t) return null;
  syncCanvasSize(carCanvas, t.w, t.h, window.devicePixelRatio || 1, false);
  const ctx = getSemanticCanvasContext(carCanvas);
  if (!ctx) return null;
  ctx.setTransform(carCanvas.width / t.w, 0, 0, carCanvas.height / t.h, 0, 0);
  ctx.clearRect(0, 0, t.w, t.h);
  const pkt = telemetry[idx],
    position = resolvedPositions[idx];
  if (!pkt || !position) return null;
  const scaleX = t.w / t.offW,
    scaleY = t.h / t.offH;
  const toCanvas = (x: number, z: number): [number, number] => [(t.offsetX + (t.maxX - x) * t.scale) * scaleX, (t.offsetZ + (z - t.minZ) * t.scale) * scaleY];
  const [cx, cy] = toCanvas(position.x, position.z);
  const game = tryGetGame(pkt.gameId);
  const pathDirection = game?.coordSystem === "lap-distance" ? resolvedDirections[idx] : null;
  const [dx, dz] = pathDirection ?? game?.carForwardOffset(pkt.Yaw) ?? [Math.sin(pkt.Yaw), Math.cos(pkt.Yaw)];
  const [fx, fy] = toCanvas(position.x + dx, position.z + dz);
  const angle = Math.atan2(fy - cy, fx - cx),
    triSize = 8;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(triSize, 0);
  ctx.lineTo(-triSize * 0.6, -triSize * 0.6);
  ctx.lineTo(-triSize * 0.6, triSize * 0.6);
  ctx.closePath();
  ctx.fillStyle = "var(--app-accent)";
  ctx.fill();
  ctx.strokeStyle = "var(--track-label-background)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  return { x: cx, y: cy, w: t.w, h: t.h, angle };
}

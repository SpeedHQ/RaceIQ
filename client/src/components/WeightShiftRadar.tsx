import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";

const toDeg = 180 / Math.PI;

/**
 * WeightShiftRadar — Canvas-drawn weight transfer visualization.
 * Uses Roll (lateral) and Pitch (longitudinal) to show where
 * weight is shifting. Dot moves toward the loaded corner.
 * Roll right = weight shifts left, braking = weight shifts forward.
 */
export function WeightShiftRadar({ packet }: { packet: TelemetryPacket }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 70;
  const maxAngle = 15; // degrees — clamp range for visualization

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 6;

    // Background: car outline (rounded rect)
    ctx.strokeStyle = "rgba(100,116,139,0.2)";
    ctx.lineWidth = 1;
    const carW = r * 1.2;
    const carH = r * 1.6;
    const carX = cx - carW / 2;
    const carY = cy - carH / 2;
    ctx.beginPath();
    ctx.roundRect(carX, carY, carW, carH, 4);
    ctx.stroke();

    // Corner dots (FL, FR, RL, RR positions)
    const corners = [
      { x: carX + 4, y: carY + 6 },       // FL
      { x: carX + carW - 4, y: carY + 6 }, // FR
      { x: carX + 4, y: carY + carH - 6 },       // RL
      { x: carX + carW - 4, y: carY + carH - 6 }, // RR
    ];
    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(100,116,139,0.25)";
      ctx.fill();
    }

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy);
    ctx.lineTo(cx + r * 0.5, cy);
    ctx.moveTo(cx, cy - r * 0.6);
    ctx.lineTo(cx, cy + r * 0.6);
    ctx.strokeStyle = "rgba(100,116,139,0.1)";
    ctx.stroke();

    // Roll and pitch in degrees
    const roll = packet.Roll * toDeg;
    const pitch = packet.Pitch * toDeg;

    // Clamp for visual range
    const clampRoll = Math.max(-maxAngle, Math.min(maxAngle, roll));
    const clampPitch = Math.max(-maxAngle, Math.min(maxAngle, pitch));

    // Weight shifts opposite to roll/pitch:
    // Roll right (positive) = weight on left side = dot goes left (negative X)
    // Pitch forward (positive, nose down/braking) = weight on front = dot goes up (negative Y)
    const dotX = cx - (clampRoll / maxAngle) * (carW / 2 - 4);
    const dotY = cy - (clampPitch / maxAngle) * (carH / 2 - 6);

    const magnitude = Math.sqrt(clampRoll * clampRoll + clampPitch * clampPitch) / maxAngle;
    const dotColor = magnitude < 0.3 ? "#34d399" : magnitude < 0.6 ? "#facc15" : magnitude < 0.85 ? "#fb923c" : "#ef4444";

    // Weight dot
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();

    // Subtle glow
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fillStyle = dotColor.replace(")", ",0.15)").replace("rgb", "rgba");
    ctx.fill();
  }, [packet]);

  return (
    <div className="flex flex-col items-center">
      <canvas ref={canvasRef} style={{ width: size, height: size }} className="rounded" />
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";

/**
 * WeightShiftRadar — Canvas-drawn weight transfer visualization.
 * Uses the 4 normalized suspension travel values (0-1) to compute
 * where weight is concentrated. More compression = more load on that corner.
 * Dot position is the weighted centroid of the four corners.
 */
export function WeightShiftRadar({ packet }: { packet: TelemetryPacket }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 85;

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
    ctx.strokeStyle = "rgba(148,163,184,0.8)";
    ctx.lineWidth = 1.5;
    const carW = r * 1.2;
    const carH = r * 1.6;
    const carX = cx - carW / 2;
    const carY = cy - carH / 2;
    ctx.beginPath();
    ctx.roundRect(carX, carY, carW, carH, 4);
    ctx.stroke();

    // Corner positions in canvas space: FL, FR, RL, RR
    const corners = [
      { x: carX + 4, y: carY + 6 },             // FL
      { x: carX + carW - 4, y: carY + 6 },       // FR
      { x: carX + 4, y: carY + carH - 6 },       // RL
      { x: carX + carW - 4, y: carY + carH - 6 }, // RR
    ];
    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(148,163,184,0.85)";
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

    // Suspension loads (0-1 normalized, higher = more compressed = more load)
    const loads = [
      packet.NormSuspensionTravelFL,
      packet.NormSuspensionTravelFR,
      packet.NormSuspensionTravelRL,
      packet.NormSuspensionTravelRR,
    ];

    const totalLoad = loads[0] + loads[1] + loads[2] + loads[3];

    // Weighted centroid of the four corners, amplified from center
    const sensitivity = 3;
    let dotX = cx;
    let dotY = cy;
    if (totalLoad > 0.01) {
      let rawX = 0;
      let rawY = 0;
      for (let i = 0; i < 4; i++) {
        rawX += corners[i].x * loads[i];
        rawY += corners[i].y * loads[i];
      }
      rawX /= totalLoad;
      rawY /= totalLoad;
      // Amplify offset from center to increase sensitivity
      dotX = cx + (rawX - cx) * sensitivity;
      dotY = cy + (rawY - cy) * sensitivity;
      // Clamp to car outline bounds
      dotX = Math.max(carX + 4, Math.min(carX + carW - 4, dotX));
      dotY = Math.max(carY + 6, Math.min(carY + carH - 6, dotY));
    }

    // Magnitude: how far from center (0 = even, 1 = fully loaded on one corner)
    const dx = dotX - cx;
    const dy = dotY - cy;
    const maxDist = Math.sqrt((carW / 2) ** 2 + (carH / 2) ** 2);
    const magnitude = Math.min(1, Math.sqrt(dx * dx + dy * dy) / maxDist * 2);
    const dotColor = magnitude < 0.3 ? "#34d399" : magnitude < 0.6 ? "#facc15" : magnitude < 0.85 ? "#fb923c" : "#ef4444";

    // Weight dot
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();

    // Subtle glow
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    const glowColor = dotColor + "26"; // ~15% opacity hex
    ctx.fillStyle = glowColor;
    ctx.fill();
  }, [packet]);

  return (
    <div className="relative flex flex-col items-center">
      <canvas ref={canvasRef} style={{ width: size, height: size }} className="rounded" />
      <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-[9px] font-mono text-app-text-muted text-center leading-tight">Load<br />Distribution</span>
    </div>
  );
}

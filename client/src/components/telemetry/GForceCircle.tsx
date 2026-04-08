import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";

/**
 * GForceCircle — Canvas-drawn G-force plot (friction circle).
 * Lateral G on X-axis, longitudinal G on Y-axis. Concentric rings at 0.83G intervals.
 * Raw acceleration (m/s^2) is divided by 9.81 to convert to G units.
 * Dot color indicates total G magnitude.
 */
export function GForceCircle({ packet }: { packet: TelemetryPacket }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 110;
  const maxG = 2.5;

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
    const r = size / 2 - 8;

    // Background rings
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (r / 3) * i, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(100,116,139,0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.strokeStyle = "rgba(100,116,139,0.1)";
    ctx.stroke();

    // Forza acceleration values are inverted relative to felt G-force:
    // braking produces positive Z, but on a G-meter the dot should go UP (negative canvas Y)
    const latG = -packet.AccelerationX / 9.81;
    const lonG = -packet.AccelerationZ / 9.81;
    const dotX = cx + (latG / maxG) * r;
    const dotY = cy - (lonG / maxG) * r;

    const totalG = Math.sqrt(latG * latG + lonG * lonG);
    const dotColor = totalG < 0.5 ? "#34d399" : totalG < 1.0 ? "#facc15" : totalG < 1.5 ? "#fb923c" : "#ef4444";

    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }, [packet]);

  const latG = -packet.AccelerationX / 9.81;
  const lonG = -packet.AccelerationZ / 9.81;

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0" style={{ width: size }}>
      <div className="text-[8px] font-mono text-app-text-muted uppercase tracking-wider font-semibold">G-Force</div>
      <canvas ref={canvasRef} style={{ width: size, height: size }} className="rounded bg-app-surface/40" />
      <div className="flex gap-2 text-[8px] font-mono text-app-text-secondary tabular-nums">
        <span className="w-6 text-right">{latG >= 0 ? " " : ""}{latG.toFixed(1)}</span>
        <span className="w-6 text-right">{lonG >= 0 ? " " : ""}{lonG.toFixed(1)}</span>
      </div>
    </div>
  );
}

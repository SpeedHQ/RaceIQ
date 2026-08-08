import { useEffect, useRef } from "react";
import { severityRangeColor } from "@/lib/colors";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { m } from "@/paraglide/messages";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";

/**
 * GForceCircle — Canvas-drawn G-force plot (friction circle).
 * Lateral G on X-axis, longitudinal G on Y-axis. Concentric rings at 0.83G intervals.
 * Raw acceleration (m/s^2) is divided by 9.81 to convert to G units.
 * Dot color indicates total G magnitude.
 */
export function GForceCircle({ packet, view }: { packet?: TelemetryPacket; view?: LiveTelemetryView }) {
  const accelerationX = view?.motion.acceleration?.x ?? packet?.AccelerationX ?? 0;
  const accelerationZ = view?.motion.acceleration?.z ?? packet?.AccelerationZ ?? 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = 110;
  const maxG = 2.5;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;

    syncCanvasSize(canvas, size, size, window.devicePixelRatio || 1, false);
    ctx.setTransform(canvas.width / size, 0, 0, canvas.height / size, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 8;

    // Background rings
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (r / 3) * i, 0, Math.PI * 2);
      ctx.strokeStyle = "color-mix(in srgb, var(--app-text-dim) 15%, transparent)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.strokeStyle = "color-mix(in srgb, var(--app-text-dim) 10%, transparent)";
    ctx.stroke();

    // Forza acceleration values are inverted relative to felt G-force:
    // braking produces positive Z, but on a G-meter the dot should go UP (negative canvas Y)
    const latG = -accelerationX / 9.81;
    const lonG = -accelerationZ / 9.81;
    const dotX = cx + (latG / maxG) * r;
    const dotY = cy - (lonG / maxG) * r;

    const totalG = Math.sqrt(latG * latG + lonG * lonG);
    const dotColor = severityRangeColor(totalG, [0.5, 1, 1.5]);

    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }, [accelerationX, accelerationZ]);

  const latG = -accelerationX / 9.81;
  const lonG = -accelerationZ / 9.81;

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0" style={{ width: size }}>
      <div className="text-app-nano font-mono text-app-text-muted uppercase tracking-wider font-semibold">{m.gforce_title()}</div>
      <canvas ref={canvasRef} style={{ width: size, height: size }} className="rounded bg-app-surface/40" />
      <div className="flex gap-2 text-app-nano font-mono text-app-text-secondary tabular-nums">
        <span className="w-6 text-right">
          {latG >= 0 ? " " : ""}
          {latG.toFixed(1)}
        </span>
        <span className="w-6 text-right">
          {lonG >= 0 ? " " : ""}
          {lonG.toFixed(1)}
        </span>
      </div>
    </div>
  );
}

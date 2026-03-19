import { useRef, useEffect, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";

interface Props {
  telemetry: TelemetryPacket[];
  colorBy?: "speed" | "throttle" | "brake";
  highlightDistance?: number;
  lineColor?: string; // optional override color (for overlay mode)
  className?: string;
}

function getSpeedMph(p: TelemetryPacket): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.23694;
}

function integratePositions(packets: TelemetryPacket[]): { x: number[]; z: number[] } {
  const x: number[] = [0];
  const z: number[] = [0];
  for (let i = 1; i < packets.length; i++) {
    const dt = (packets[i].TimestampMS - packets[i - 1].TimestampMS) / 1000;
    if (dt <= 0 || dt > 1) {
      // Skip bad deltas (rewind, large gap)
      x.push(x[x.length - 1]);
      z.push(z[z.length - 1]);
      continue;
    }
    x.push(x[x.length - 1] + packets[i].VelocityX * dt);
    z.push(z[z.length - 1] + packets[i].VelocityZ * dt);
  }
  return { x, z };
}

function speedToColor(speed: number, minSpeed: number, maxSpeed: number): string {
  const t = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0;
  // blue (slow) -> cyan -> green -> yellow -> red (fast)
  const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255);
  const g = Math.round(t < 0.5 ? t * 2 * 255 : (1 - t) * 2 * 255);
  const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0);
  return `rgb(${r},${g},${b})`;
}

function channelToColor(value: number, min: number, max: number): string {
  return speedToColor(value, min, max);
}

export function TrackMap({ telemetry, colorBy = "speed", highlightDistance, lineColor, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || telemetry.length < 2) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Integrate positions
    const { x, z } = integratePositions(telemetry);

    // Compute bounds
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < x.length; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (z[i] < minZ) minZ = z[i];
      if (z[i] > maxZ) maxZ = z[i];
    }

    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const padding = 20;
    const scaleX = (w - padding * 2) / rangeX;
    const scaleZ = (h - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);

    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    const toScreenX = (px: number) => (px - minX) * scale + offsetX;
    const toScreenZ = (pz: number) => (pz - minZ) * scale + offsetZ;

    // Get color channel values
    let values: number[] = [];
    if (!lineColor) {
      if (colorBy === "speed") {
        values = telemetry.map(getSpeedMph);
      } else if (colorBy === "throttle") {
        values = telemetry.map((p) => (p.Accel / 255) * 100);
      } else {
        values = telemetry.map((p) => (p.Brake / 255) * 100);
      }
    }

    const minVal = values.length ? Math.min(...values) : 0;
    const maxVal = values.length ? Math.max(...values) : 1;

    // Draw track line
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < x.length; i++) {
      ctx.beginPath();
      ctx.moveTo(toScreenX(x[i - 1]), toScreenZ(z[i - 1]));
      ctx.lineTo(toScreenX(x[i]), toScreenZ(z[i]));
      ctx.strokeStyle = lineColor || channelToColor(values[i], minVal, maxVal);
      ctx.stroke();
    }

    // Draw highlight dot
    if (highlightDistance !== undefined && telemetry.length > 0) {
      const distStart = telemetry[0].DistanceTraveled;
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < telemetry.length; i++) {
        const d = Math.abs((telemetry[i].DistanceTraveled - distStart) - highlightDistance);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      ctx.beginPath();
      ctx.arc(toScreenX(x[closestIdx]), toScreenZ(z[closestIdx]), 6, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Start/finish indicator
    if (x.length > 0) {
      ctx.beginPath();
      ctx.arc(toScreenX(x[0]), toScreenZ(z[0]), 4, 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.fill();
    }
  }, [telemetry, colorBy, highlightDistance, lineColor]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div ref={containerRef} className={`relative w-full h-full min-h-[200px] ${className ?? ""}`}>
      {telemetry.length < 2 ? (
        <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">
          No position data
        </div>
      ) : (
        <canvas ref={canvasRef} className="absolute inset-0" />
      )}
    </div>
  );
}

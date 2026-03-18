import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";

interface Props {
  packet: TelemetryPacket | null;
}

interface Point {
  x: number;
  z: number;
  speed: number;
}

export function LiveTrackMap({ packet }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<Point[]>([]);
  const lastLapRef = useRef<number>(-1);
  const lastPosRef = useRef<{ x: number; z: number } | null>(null);
  const lastTimestampRef = useRef<number>(0);

  useEffect(() => {
    if (!packet) return;

    // Reset on new lap
    if (packet.LapNumber !== lastLapRef.current) {
      lastLapRef.current = packet.LapNumber;
      pointsRef.current = [];
      lastPosRef.current = null;
      lastTimestampRef.current = 0;
    }

    // Integrate velocity to get position
    const ts = packet.TimestampMS;
    if (lastTimestampRef.current > 0 && ts > lastTimestampRef.current) {
      const dt = (ts - lastTimestampRef.current) / 1000;
      if (dt > 0 && dt < 1) { // skip gaps
        const last = lastPosRef.current ?? { x: 0, z: 0 };
        const x = last.x + packet.VelocityX * dt;
        const z = last.z + packet.VelocityZ * dt;
        const speed = Math.sqrt(packet.VelocityX ** 2 + packet.VelocityY ** 2 + packet.VelocityZ ** 2) * 2.23694;
        lastPosRef.current = { x, z };

        // Downsample: only add point every ~5 samples
        if (pointsRef.current.length === 0 || pointsRef.current.length % 3 === 0) {
          pointsRef.current.push({ x, z, speed });
        } else {
          // Update last point position
          pointsRef.current[pointsRef.current.length - 1] = { x, z, speed };
        }
      }
    } else if (!lastPosRef.current) {
      lastPosRef.current = { x: 0, z: 0 };
      pointsRef.current.push({ x: 0, z: 0, speed: 0 });
    }
    lastTimestampRef.current = ts;

    // Draw
    draw();
  });

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const points = pointsRef.current;
    if (points.length < 2) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    // Find bounds
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let maxSpeed = 0;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      maxSpeed = Math.max(maxSpeed, p.speed);
    }

    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const padding = 20;
    const scaleX = (w - padding * 2) / rangeX;
    const scaleZ = (h - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    function toCanvas(p: Point): [number, number] {
      return [
        offsetX + (p.x - minX) * scale,
        offsetZ + (p.z - minZ) * scale,
      ];
    }

    function speedColor(speed: number): string {
      const t = maxSpeed > 0 ? speed / maxSpeed : 0;
      // Blue (slow) → Green → Yellow → Red (fast)
      if (t < 0.33) {
        const s = t / 0.33;
        return `rgb(${Math.round(s * 50)}, ${Math.round(100 + s * 155)}, ${Math.round(255 - s * 100)})`;
      } else if (t < 0.66) {
        const s = (t - 0.33) / 0.33;
        return `rgb(${Math.round(50 + s * 205)}, ${Math.round(255 - s * 55)}, ${Math.round(155 - s * 155)})`;
      }
      const s = (t - 0.66) / 0.34;
      return `rgb(255, ${Math.round(200 - s * 200)}, 0)`;
    }

    // Draw track line segments colored by speed
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = toCanvas(points[i - 1]);
      const [x2, y2] = toCanvas(points[i]);
      ctx.beginPath();
      ctx.strokeStyle = speedColor(points[i].speed);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Draw current position dot
    if (points.length > 0) {
      const [cx, cy] = toCanvas(points[points.length - 1]);
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#22d3ee";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Start marker
    if (points.length > 1) {
      const [sx, sy] = toCanvas(points[0]);
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#10b981";
      ctx.fill();
    }
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ minHeight: 180 }}
    />
  );
}

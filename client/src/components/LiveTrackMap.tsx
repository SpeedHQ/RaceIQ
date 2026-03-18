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
  const frameCountRef = useRef<number>(0);

  useEffect(() => {
    if (!packet) return;

    // Reset on new lap
    if (packet.LapNumber !== lastLapRef.current) {
      lastLapRef.current = packet.LapNumber;
      pointsRef.current = [];
      frameCountRef.current = 0;
    }

    const x = packet.PositionX;
    const z = packet.PositionZ;
    const speed = packet.Speed * 2.23694;

    // Skip zero positions (car not loaded / in menu)
    if (x === 0 && z === 0) return;

    // Add point every 5th frame to avoid too many points
    frameCountRef.current++;
    if (frameCountRef.current % 5 === 0) {
      pointsRef.current.push({ x, z, speed });
    }

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
    let maxSpeed = 1;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      maxSpeed = Math.max(maxSpeed, p.speed);
    }

    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
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
      const t = Math.min(speed / maxSpeed, 1);
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

    // Draw track segments colored by speed
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

    // Current position dot
    const [cx, cy] = toCanvas(points[points.length - 1]);
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#22d3ee";
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Start marker
    const [sx, sy] = toCanvas(points[0]);
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#10b981";
    ctx.fill();
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ minHeight: 200 }}
    />
  );
}

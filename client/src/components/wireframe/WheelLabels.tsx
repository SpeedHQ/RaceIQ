import { useMemo } from "react";
import * as THREE from "three";
import { brakeTempColor } from "../../lib/wireframe-utils";

export function TempLabel({ displayTemp, color, side }: { displayTemp: string; color: string; side: "left" | "right" }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    ctx.font = "bold 30px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(displayTemp, 64, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [displayTemp, color]);

  return (
    <sprite position={[0, 0.5, side === "left" ? -0.55 : 0.55]} scale={[0.6, 0.22, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

export function WearLabel({ wearRate, side }: { wearRate: number; side: "left" | "right" }) {
  const text = wearRate > 0.0001 ? `-${(wearRate * 100).toFixed(2)}%/s` : "";
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f97316";
    ctx.fillText(text, 64, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text]);

  return (
    <sprite position={[0, 0.22, side === "left" ? -0.55 : 0.55]} scale={[0.6, 0.22, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

export function BrakeTempLabel({ temp, side }: { temp: number; side: "left" | "right" }) {
  const color = brakeTempColor(temp);
  const text = `${temp.toFixed(0)}°C`;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 192, 48);
    // Brake disc icon — rotor with caliper (scaled to match 30px text).
    // ix chosen so icon sits flush against the left edge of the centered text.
    const ix = 44, iy = 20, r = 14;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(ix, iy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ix, iy, 5, 0, Math.PI * 2);
    ctx.stroke();
    for (let a = 0; a < 6; a++) {
      const angle = (a / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(ix + Math.cos(angle) * 6, iy + Math.sin(angle) * 6);
      ctx.lineTo(ix + Math.cos(angle) * 12, iy + Math.sin(angle) * 12);
      ctx.stroke();
    }
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(ix, iy, r + 3, -0.6, 0.6);
    ctx.stroke();
    // Temp text — match TempLabel font size (30px bold mono)
    ctx.font = "bold 30px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 118, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={[0, 0.08, side === "left" ? -0.55 : 0.55]} scale={[0.88, 0.22, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

export function HealthLabel({ wear, side }: { wear: number; side: "left" | "right" }) {
  const health = 1 - wear;
  const pct = (health * 100).toFixed(0);
  const color = health > 0.7 ? "#34d399" : health > 0.4 ? "#fbbf24" : "#ef4444";
  const text = `${pct}%`;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    // Percentage text — shifted right to make room for the heart icon on the left.
    ctx.font = "bold 26px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 78, 24);
    // Heart icon — filled, sits to the left of the %.
    const hx = 22, hy = 24, hs = 11;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(hx, hy + hs * 0.8);
    ctx.bezierCurveTo(hx, hy + hs * 0.3, hx - hs, hy + hs * 0.3, hx - hs, hy - hs * 0.2);
    ctx.bezierCurveTo(hx - hs, hy - hs * 0.8, hx - hs * 0.5, hy - hs, hx, hy - hs * 0.4);
    ctx.bezierCurveTo(hx + hs * 0.5, hy - hs, hx + hs, hy - hs * 0.8, hx + hs, hy - hs * 0.2);
    ctx.bezierCurveTo(hx + hs, hy + hs * 0.3, hx, hy + hs * 0.3, hx, hy + hs * 0.8);
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={[0, 0.36, side === "left" ? -0.55 : 0.55]} scale={[0.5, 0.18, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

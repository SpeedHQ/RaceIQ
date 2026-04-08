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
    canvas.width = 160;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 160, 48);
    // Brake disc icon — rotor with caliper
    const ix = 20, iy = 24, r = 11;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    // Outer disc
    ctx.beginPath();
    ctx.arc(ix, iy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Inner hub
    ctx.beginPath();
    ctx.arc(ix, iy, 4, 0, Math.PI * 2);
    ctx.stroke();
    // Ventilation slots (6 radial lines)
    for (let a = 0; a < 6; a++) {
      const angle = (a / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(ix + Math.cos(angle) * 5, iy + Math.sin(angle) * 5);
      ctx.lineTo(ix + Math.cos(angle) * 9, iy + Math.sin(angle) * 9);
      ctx.stroke();
    }
    // Caliper (thick arc on one side)
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(ix, iy, r + 2, -0.6, 0.6);
    ctx.stroke();
    // Temp text
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 96, 24);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={[0, 0.08, side === "left" ? -0.55 : 0.55]} scale={[0.5, 0.18, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

export function HealthLabel({ wear, side }: { wear: number; side: "left" | "right" }) {
  const health = 1 - wear;
  const pct = (health * 100).toFixed(0);
  const color = health > 0.7 ? "#34d399" : health > 0.4 ? "#fbbf24" : "#ef4444";
  const text = `${pct}% H`;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 48);
    ctx.font = "bold 26px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 64, 24);
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

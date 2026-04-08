import { useMemo } from "react";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { CarModelEnrichment } from "../../data/car-models";

function DimensionLabel({ position, text, color }: { position: [number, number, number]; text: string; color: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "bold 36px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text, color]);

  return (
    <sprite position={position} scale={[1.2, 0.3, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

export function DimensionLines({ carModel }: { carModel: CarModelEnrichment }) {
  const wb = carModel.halfWheelbase;
  const ft = carModel.halfFrontTrack;
  const rt = carModel.halfRearTrack;
  const y = -0.42;

  return (
    <group>
      {/* Front track width */}
      <Line points={[[wb, y, -ft], [wb, y, ft]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[wb, y - 0.05, -ft], [wb, y + 0.05, -ft]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[wb, y - 0.05, ft], [wb, y + 0.05, ft]]} color="#22d3ee" lineWidth={2} />

      {/* Rear track width */}
      <Line points={[[-wb, y, -rt], [-wb, y, rt]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[-wb, y - 0.05, -rt], [-wb, y + 0.05, -rt]]} color="#22d3ee" lineWidth={2} />
      <Line points={[[-wb, y - 0.05, rt], [-wb, y + 0.05, rt]]} color="#22d3ee" lineWidth={2} />

      {/* Wheelbase (left side) */}
      <Line points={[[wb, y, -ft], [-wb, y, -rt]]} color="#a78bfa" lineWidth={2} />
      <Line points={[[wb, y - 0.05, -ft], [wb, y + 0.05, -ft]]} color="#a78bfa" lineWidth={2} />
      <Line points={[[-wb, y - 0.05, -rt], [-wb, y + 0.05, -rt]]} color="#a78bfa" lineWidth={2} />

      {/* Labels using sprite-based text */}
      <DimensionLabel position={[wb, y + 0.15, 0]} text={`${(ft * 2 * 1000).toFixed(0)}mm`} color="#22d3ee" />
      <DimensionLabel position={[-wb, y + 0.15, 0]} text={`${(rt * 2 * 1000).toFixed(0)}mm`} color="#22d3ee" />
      <DimensionLabel position={[0, y + 0.15, -(ft + rt) / 2]} text={`${(wb * 2 * 1000).toFixed(0)}mm`} color="#a78bfa" />
    </group>
  );
}

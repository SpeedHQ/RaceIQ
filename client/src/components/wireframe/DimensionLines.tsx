import { Line } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import type { CarModelEnrichment } from "../../data/car-models";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { THREE_COLORS } from "../../lib/wireframe-utils";

function DimensionLabel({ position, text, color }: { position: [number, number, number]; text: string; color: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = getSemanticCanvasContext(canvas)!;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "var(--font-weight-bold) var(--text-4xl) var(--font-mono)";
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
      <Line
        points={[
          [wb, y, -ft],
          [wb, y, ft],
        ]}
        color={THREE_COLORS.appAccent}
        lineWidth={2}
      />
      <Line
        points={[
          [wb, y - 0.05, -ft],
          [wb, y + 0.05, -ft],
        ]}
        color={THREE_COLORS.appAccent}
        lineWidth={2}
      />
      <Line
        points={[
          [wb, y - 0.05, ft],
          [wb, y + 0.05, ft],
        ]}
        color={THREE_COLORS.appAccent}
        lineWidth={2}
      />

      {/* Rear track width */}
      <Line
        points={[
          [-wb, y, -rt],
          [-wb, y, rt],
        ]}
        color={THREE_COLORS.appAccent}
        lineWidth={2}
      />
      <Line
        points={[
          [-wb, y - 0.05, -rt],
          [-wb, y + 0.05, -rt],
        ]}
        color={THREE_COLORS.appAccent}
        lineWidth={2}
      />
      <Line
        points={[
          [-wb, y - 0.05, rt],
          [-wb, y + 0.05, rt],
        ]}
        color={THREE_COLORS.appAccent}
        lineWidth={2}
      />

      {/* Wheelbase (left side) */}
      <Line
        points={[
          [wb, y, -ft],
          [-wb, y, -rt],
        ]}
        color={THREE_COLORS.dimensionSecondary}
        lineWidth={2}
      />
      <Line
        points={[
          [wb, y - 0.05, -ft],
          [wb, y + 0.05, -ft],
        ]}
        color={THREE_COLORS.dimensionSecondary}
        lineWidth={2}
      />
      <Line
        points={[
          [-wb, y - 0.05, -rt],
          [-wb, y + 0.05, -rt],
        ]}
        color={THREE_COLORS.dimensionSecondary}
        lineWidth={2}
      />

      {/* Labels using sprite-based text */}
      <DimensionLabel position={[wb, y + 0.15, 0]} text={`${(ft * 2 * 1000).toFixed(0)}mm`} color="var(--app-accent)" />
      <DimensionLabel position={[-wb, y + 0.15, 0]} text={`${(rt * 2 * 1000).toFixed(0)}mm`} color="var(--app-accent)" />
      <DimensionLabel position={[0, y + 0.15, -(ft + rt) / 2]} text={`${(wb * 2 * 1000).toFixed(0)}mm`} color="var(--dimension-secondary)" />
    </group>
  );
}

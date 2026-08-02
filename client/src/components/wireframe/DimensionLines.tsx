import { Line } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { CarModelEnrichment } from "../../data/car-models";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";
import { THREE_COLORS } from "../../lib/wireframe-utils";

function DimensionLabel({ position, text, color }: { position: [number, number, number]; text: string; color: string }) {
  const { ctx, texture, material } = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = getSemanticCanvasContext(canvas);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    return { ctx, texture, material };
  }, []);

  useEffect(() => {
    if (!ctx) return;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "var(--font-weight-bold) var(--text-4xl) var(--font-mono)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 32);
    texture.needsUpdate = true;
  }, [color, ctx, text, texture]);

  useEffect(
    () => () => {
      material.dispose();
      texture.dispose();
    },
    [material, texture],
  );

  return <sprite material={material} position={position} scale={[1.2, 0.3, 1]} dispose={null} />;
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

import { useMemo } from "react";
import { Line } from "@react-three/drei";
import { suspHexColor } from "../../lib/wireframe-utils";

export function SuspensionSpring({
  bodyPos,
  wheelPos,
  suspTravel,
  suspThresholds,
}: {
  bodyPos: [number, number, number];
  wheelPos: [number, number, number];
  suspTravel: number;
  suspThresholds: number[];
}) {
  const coilRadius = 0.032;  // ~64mm diameter (GT3 spec)
  const coils = 6;
  const segments = coils * 12;
  const topY = bodyPos[1];   // body mount (drops with body)
  const botY = wheelPos[1];  // wheel mount (stays on ground)
  const height = topY - botY;

  // Generate helix points
  const points = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * coils * Math.PI * 2;
      const y = botY + t * height;
      pts.push([
        bodyPos[0] + Math.cos(angle) * coilRadius,
        y,
        bodyPos[2] + Math.sin(angle) * coilRadius,
      ]);
    }
    return pts;
  }, [botY, height, bodyPos[0], bodyPos[2]]);

  const color = suspHexColor(suspTravel, suspThresholds);

  return (
    <group>
      {/* Coil spring */}
      <Line points={points} color={color} lineWidth={4} depthTest={false} renderOrder={10} transparent />
      {/* Damper rod (thin line through center) */}
      <Line
        points={[[bodyPos[0], topY + 0.05, bodyPos[2]], [bodyPos[0], botY - 0.05, bodyPos[2]]]}
        color="#64748b"
        lineWidth={1}
        depthTest={false}
        renderOrder={10}
        transparent
      />
    </group>
  );
}

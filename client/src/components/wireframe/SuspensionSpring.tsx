import { Line } from "@react-three/drei";
import { useMemo } from "react";
import { makeSuspensionSpringGeometry, suspensionColor, threeColor, THREE_COLORS } from "../../lib/wireframe-utils";

export function SuspensionSpring({
  bodyPos,
  wheelPos,
  suspTravel,
  suspThresholds,
  coilRadius,
  coils,
  damperExtension,
}: {
  bodyPos: [number, number, number];
  wheelPos: [number, number, number];
  suspTravel: number;
  suspThresholds: number[];
  coilRadius: number;
  coils: number;
  damperExtension: number;
}) {
  const { coilPoints, rodPoints } = useMemo(
    () => makeSuspensionSpringGeometry(bodyPos, wheelPos, coilRadius, coils, damperExtension),
    [bodyPos[0], bodyPos[1], bodyPos[2], wheelPos[0], wheelPos[1], wheelPos[2], coilRadius, coils, damperExtension],
  );

  const color = threeColor(suspensionColor(suspTravel, suspThresholds));

  return (
    <group>
      {/* Coil spring */}
      <Line points={coilPoints} color={color} lineWidth={4} depthTest={false} renderOrder={10} transparent />
      {/* Damper rod (thin line through center) */}
      <Line points={rodPoints} color={THREE_COLORS.appTextDim} lineWidth={1} depthTest={false} renderOrder={10} transparent />
    </group>
  );
}

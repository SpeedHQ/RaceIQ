import type { TelemetryPacket } from "@shared/types";
import { useUnits } from "../../hooks/useUnits";
import { GForceCircle } from "./GForceCircle";
import { TireDiagram } from "./TireDiagram";

// Zeroed rest-state packet — lets Vitals2D always render (no live connection
// yet) instead of hiding behind a "waiting for data" gate. Only fields the
// GForceCircle/TireDiagram render path actually reads are set; cast covers
// the rest of TelemetryPacket's ~100 unrelated fields.
const DEFAULT_PACKET = {
  gameId: "acc",
  Gear: 0,
  Speed: 0,
  Steer: 0,
  AccelerationX: 0,
  AccelerationZ: 0,
  TireTempFL: 0,
  TireTempFR: 0,
  TireTempRL: 0,
  TireTempRR: 0,
  TireWearFL: 0,
  TireWearFR: 0,
  TireWearRL: 0,
  TireWearRR: 0,
  TireSlipAngleFL: 0,
  TireSlipAngleFR: 0,
  TireSlipAngleRL: 0,
  TireSlipAngleRR: 0,
  WheelOnRumbleStripFL: 0,
  WheelOnRumbleStripFR: 0,
  WheelOnRumbleStripRL: 0,
  WheelOnRumbleStripRR: 0,
  WheelInPuddleDepthFL: 0,
  WheelInPuddleDepthFR: 0,
  WheelInPuddleDepthRL: 0,
  WheelInPuddleDepthRR: 0,
  BrakeTempFrontLeft: 0,
  BrakeTempFrontRight: 0,
  BrakeTempRearLeft: 0,
  BrakeTempRearRight: 0,
  NormSuspensionTravelFL: 0,
  NormSuspensionTravelFR: 0,
  NormSuspensionTravelRL: 0,
  NormSuspensionTravelRR: 0,
  SuspensionTravelMFL: 0,
  SuspensionTravelMFR: 0,
  SuspensionTravelMRL: 0,
  SuspensionTravelMRR: 0,
} as unknown as TelemetryPacket;

/**
 * Vitals2D — the "2D" telemetry panel: gear/speed readout, G-force radar,
 * and the full tire/brake/suspension/weight-distribution diagram. Extracted
 * from AnalyseVizPanel's 2D branch so live and post-lap views render the
 * identical panel instead of each re-assembling it. `packet` may be null
 * (no live connection yet) — renders the zeroed rest state rather than hiding.
 */
export function Vitals2D({ packet }: { packet: TelemetryPacket | null }) {
  const units = useUnits();
  const p = packet ?? DEFAULT_PACKET;
  return (
    <div className="flex flex-col items-center gap-2 w-full">
      <div className="flex items-center justify-center gap-2">
        <span className="text-lg font-mono font-bold text-app-accent">{p.Gear === 0 ? "R" : p.Gear === 11 ? "N" : p.Gear}</span>
        <span className="text-xl font-mono font-bold tabular-nums text-app-text">
          {units.speed(p.Speed).toFixed(0)} <span className="text-[10px] text-app-text-muted">{units.speedLabel}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <GForceCircle packet={p} />
      </div>
      <TireDiagram packet={p} />
    </div>
  );
}

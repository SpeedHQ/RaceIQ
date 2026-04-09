import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "@/lib/convert-packet";

/**
 * SurfaceConditions — Shows per-wheel curb and puddle status in a compact 2x2 grid.
 * Only renders when at least one wheel is on a curb or in a puddle.
 */
export function SurfaceConditions({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const wheels = [
    { label: "FL", rumble: packet.WheelOnRumbleStripFL !== 0, puddle: packet.WheelInPuddleDepthFL, surfaceRumble: packet.SurfaceRumbleFL },
    { label: "FR", rumble: packet.WheelOnRumbleStripFR !== 0, puddle: packet.WheelInPuddleDepthFR, surfaceRumble: packet.SurfaceRumbleFR },
    { label: "RL", rumble: packet.WheelOnRumbleStripRL !== 0, puddle: packet.WheelInPuddleDepthRL, surfaceRumble: packet.SurfaceRumbleRL },
    { label: "RR", rumble: packet.WheelOnRumbleStripRR !== 0, puddle: packet.WheelInPuddleDepthRR, surfaceRumble: packet.SurfaceRumbleRR },
  ];

  return (
    <div>
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">Surface</div>
      <div className="grid grid-cols-2 gap-1.5 max-w-[200px] mx-auto">
        {wheels.map(w => (
          <div
            key={w.label}
            className={`flex items-center justify-between px-2 py-1 rounded text-[10px] font-mono border ${
              w.rumble
                ? "border-orange-500/50 bg-orange-950/30"
                : w.puddle > 0
                  ? "border-blue-500/50 bg-blue-950/30"
                  : "border-app-border"
            }`}
          >
            <span className="text-app-text-muted font-bold">{w.label}</span>
            <span className={`font-bold ${w.rumble ? "text-orange-400" : w.puddle > 0 ? "text-blue-400" : "text-app-text-dim"}`}>
              {w.rumble ? "CURB" : w.puddle > 0 ? `WET ${(w.puddle * 100).toFixed(0)}%` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

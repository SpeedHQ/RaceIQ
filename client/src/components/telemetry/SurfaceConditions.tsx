import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import type { DisplayPacket } from "@/lib/convert-packet";
import { m } from "@/paraglide/messages";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

/**
 * Per-wheel curb and puddle status. Games whose normalized zeroes are source
 * placeholders omit this widget; supported zeroes remain visible as dashes.
 */
export function SurfaceConditions({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const surface = resolveAnalysisTelemetry(getGame(packet.gameId)).surface;
  if (surface.source === "unavailable" || surface.display === "vehicle") return null;

  const wheels = [
    { label: "FL", rumble: packet.WheelOnRumbleStripFL !== 0, puddle: packet.WheelInPuddleDepthFL },
    { label: "FR", rumble: packet.WheelOnRumbleStripFR !== 0, puddle: packet.WheelInPuddleDepthFR },
    { label: "RL", rumble: packet.WheelOnRumbleStripRL !== 0, puddle: packet.WheelInPuddleDepthRL },
    { label: "RR", rumble: packet.WheelOnRumbleStripRR !== 0, puddle: packet.WheelInPuddleDepthRR },
  ];

  return (
    <div>
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">{m.surface_heading()}</div>
      <div className="grid grid-cols-2 gap-1.5 max-w-[200px] mx-auto">
        {wheels.map((w) => (
          <div
            key={w.label}
            className={`flex items-center justify-between px-2 py-1 rounded text-app-caption font-mono border ${
              w.rumble ? "border-(--surface-curb)/50 bg-(--surface-curb)/10" : w.puddle > 0 ? "border-(--surface-wet)/50 bg-(--surface-wet)/10" : "border-app-border"
            }`}
          >
            <span className="text-app-text-muted font-bold">{w.label}</span>
            <span className={`font-bold ${w.rumble ? "text-(--surface-curb)" : w.puddle > 0 ? "text-(--surface-wet)" : "text-app-text-dim"}`}>
              {w.rumble ? m.surface_curb() : w.puddle > 0 ? `${m.surface_wet()} ${(w.puddle * 100).toFixed(0)}%` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

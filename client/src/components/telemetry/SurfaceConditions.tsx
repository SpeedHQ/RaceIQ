import type { DisplayPacket } from "@/lib/convert-packet";
import { m } from "@/paraglide/messages";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

/**
 * Per-wheel curb and puddle status. Games whose normalized zeroes are source
 * placeholders omit this widget; supported zeroes remain visible as dashes.
 */
export function SurfaceConditions({ packet, view }: { packet?: DisplayPacket | TelemetryPacket; view?: LiveTelemetryView }) {
  if (view && !packet) {
    const wheels = view.tires;
    const values = [
      { label: "FL", rumble: (wheels.onRumbleStrip?.fl ?? 0) !== 0, puddle: wheels.puddleDepth?.fl ?? 0 },
      { label: "FR", rumble: (wheels.onRumbleStrip?.fr ?? 0) !== 0, puddle: wheels.puddleDepth?.fr ?? 0 },
      { label: "RL", rumble: (wheels.onRumbleStrip?.rl ?? 0) !== 0, puddle: wheels.puddleDepth?.rl ?? 0 },
      { label: "RR", rumble: (wheels.onRumbleStrip?.rr ?? 0) !== 0, puddle: wheels.puddleDepth?.rr ?? 0 },
    ];
    return <div><div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">{m.surface_heading()}</div><div className="grid grid-cols-2 gap-1.5 max-w-[200px] mx-auto">{values.map((w) => <div key={w.label} className="flex items-center justify-between px-2 py-1 rounded text-app-caption font-mono border border-app-border"><span className="text-app-text-muted font-bold">{w.label}</span><span>{w.rumble ? m.surface_curb() : w.puddle > 0 ? `${m.surface_wet()} ${(w.puddle * 100).toFixed(0)}%` : "—"}</span></div>)}</div></div>;
  }
  if (!packet) return null;
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

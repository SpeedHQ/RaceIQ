import { m } from "@/paraglide/messages";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";

/**
 * Per-wheel curb and puddle status. Games whose normalized zeroes are source
 * placeholders omit this widget; supported zeroes remain visible as dashes.
 */
export function SurfaceConditions({ view }: { view: LiveTelemetryView }) {
  const wheels = view.tires;
  if (!wheels.onRumbleStrip && !wheels.puddleDepth) return null;
  const values = [
    { label: "FL", rumble: wheels.onRumbleStrip?.fl !== undefined ? wheels.onRumbleStrip.fl !== 0 : false, puddle: wheels.puddleDepth?.fl },
    { label: "FR", rumble: wheels.onRumbleStrip?.fr !== undefined ? wheels.onRumbleStrip.fr !== 0 : false, puddle: wheels.puddleDepth?.fr },
    { label: "RL", rumble: wheels.onRumbleStrip?.rl !== undefined ? wheels.onRumbleStrip.rl !== 0 : false, puddle: wheels.puddleDepth?.rl },
    { label: "RR", rumble: wheels.onRumbleStrip?.rr !== undefined ? wheels.onRumbleStrip.rr !== 0 : false, puddle: wheels.puddleDepth?.rr },
  ];

  return (
    <div>
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">{m.surface_heading()}</div>
      <div className="grid grid-cols-2 gap-1.5 max-w-[200px] mx-auto">
        {values.map((wheel) => (
          <div
            key={wheel.label}
            className={`flex items-center justify-between px-2 py-1 rounded text-app-caption font-mono border ${
              wheel.rumble
                ? "border-(--surface-curb)/50 bg-(--surface-curb)/10"
                : wheel.puddle !== undefined && wheel.puddle > 0
                  ? "border-(--surface-wet)/50 bg-(--surface-wet)/10"
                  : "border-app-border"
            }`}
          >
            <span className="text-app-text-muted font-bold">{wheel.label}</span>
            <span className={`font-bold ${wheel.rumble ? "text-(--surface-curb)" : wheel.puddle !== undefined && wheel.puddle > 0 ? "text-(--surface-wet)" : "text-app-text-dim"}`}>
              {wheel.rumble ? m.surface_curb() : wheel.puddle !== undefined && wheel.puddle > 0 ? `${m.surface_wet()} ${(wheel.puddle * 100).toFixed(0)}%` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

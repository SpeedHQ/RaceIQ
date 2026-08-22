import { m } from "@/paraglide/messages";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";

/**
 * Per-wheel curb and puddle status from canonical semantic values.
 * Missing structured channels keep widget unavailable; supported zeroes remain dashes.
 */
export function SurfaceConditions({ view }: { view?: LiveTelemetryView }) {
  if (!view) return null;
  const wheels = view.tires;
  if (!wheels.onRumbleStrip && !wheels.puddleDepth) return null;
  const values = [
    { label: "FL", rumble: wheels.onRumbleStrip?.fl === true, puddle: wheels.puddleDepth?.fl ?? 0 },
    { label: "FR", rumble: wheels.onRumbleStrip?.fr === true, puddle: wheels.puddleDepth?.fr ?? 0 },
    { label: "RL", rumble: wheels.onRumbleStrip?.rl === true, puddle: wheels.puddleDepth?.rl ?? 0 },
    { label: "RR", rumble: wheels.onRumbleStrip?.rr === true, puddle: wheels.puddleDepth?.rr ?? 0 },
  ];

  return (
    <div>
      <div className="text-xs text-app-text-muted uppercase tracking-wider mb-2">{m.surface_heading()}</div>
      <div className="grid grid-cols-2 gap-1.5 max-w-[200px] mx-auto">
        {values.map((w) => (
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

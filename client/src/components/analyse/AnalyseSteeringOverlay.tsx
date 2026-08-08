import { getSteeringLock } from "@/lib/settings-storage";
import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import { brakeBarColor } from "./AnalyseMetricsPanel";

interface Props {
  frame: SemanticAnalysisFrame;
}

const number = (frame: SemanticAnalysisFrame, id: string) => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};


export function AnalyseSteeringOverlay({ frame }: Props) {
  const steer = number(frame, "inputs.steer");
  const brake = number(frame, "inputs.brake");
  const throttle = number(frame, "inputs.accel");
  const halfLock = getSteeringLock() / 2;
  const steerDeg = steer == null ? null : (steer / 127) * halfLock;
  const steerValue = steer ?? 0;
  return (
    <div className="absolute bottom-2 right-2 flex flex-col items-center gap-1">
      <svg width="44" height="44" viewBox="-22 -22 44 44" style={{ transform: `rotate(${steerDeg}deg)` }}>
        <circle cx="0" cy="0" r="18" fill="none" stroke="var(--app-text-dim)" strokeWidth="3" opacity="0.6" />
        <line x1="-12" y1="0" x2="-6" y2="0" stroke="var(--app-text-muted)" strokeWidth="2" strokeLinecap="round" />
        <line x1="6" y1="0" x2="12" y2="0" stroke="var(--app-text-muted)" strokeWidth="2" strokeLinecap="round" />
        <line x1="0" y1="6" x2="0" y2="12" stroke="var(--app-text-muted)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="0" cy="0" r="3" fill="var(--app-text-dim)" />
        <line x1="0" y1="-18" x2="0" y2="-14" stroke="var(--app-accent)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="relative bg-app-surface-alt/60 rounded-sm" style={{ width: 80, height: 8 }}>
        <div className="absolute left-1/2 top-0 w-px h-full bg-app-text-dim/40" />
        <div
          className="absolute top-1/2 w-2.5 h-2.5 rounded-full border shadow-sm"
          style={{
            backgroundColor: "var(--ch-steer)",
            borderColor: "var(--app-accent-hover)",
            boxShadow: "0 1px 2px color-mix(in srgb, var(--ch-steer) 50%, transparent)",
            left: `${50 + (steerValue / 127) * 50}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>
      <span className="text-app-micro font-mono text-app-text-secondary tabular-nums">
        {steerValue > 0 ? "R" : steerValue < 0 ? "L" : ""} {steerDeg == null ? "—" : `${Math.abs(steerDeg).toFixed(0)}°`}
      </span>
      <div className="flex gap-1 items-end" style={{ height: 60 }}>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-app-micro font-mono font-bold tabular-nums" style={{ color: brakeBarColor(brake ?? 0) }}>
            {brake == null ? "—" : `${brake.toFixed(0)}`}
          </span>
          <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 40 }}>
            <div
              className="absolute bottom-0 w-full rounded-sm transition-all"
              style={{ height: `${brake ?? 0}%`, background: `linear-gradient(to top, var(--brake-warm), ${brakeBarColor(brake ?? 0)})` }}
            />
          </div>
          <span className="text-app-glyph text-app-text-muted">B</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-app-micro font-mono font-bold tabular-nums" style={{ color: "var(--ch-throttle)" }}>
            {throttle == null ? "—" : `${throttle.toFixed(0)}`}
          </span>
          <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 40 }}>
            <div className="absolute bottom-0 w-full rounded-sm transition-all" style={{ backgroundColor: "var(--ch-throttle)", height: `${throttle ?? 0}%` }} />
          </div>
          <span className="text-app-glyph text-app-text-muted">T</span>
        </div>
      </div>
    </div>
  );
}

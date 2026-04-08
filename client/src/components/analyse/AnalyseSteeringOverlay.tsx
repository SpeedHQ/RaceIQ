import type { TelemetryPacket } from "@shared/types";
import { brakeBarColor } from "./AnalyseMetricsPanel";

interface Props {
  packet: TelemetryPacket;
}

export function AnalyseSteeringOverlay({ packet }: Props) {
  return (
    <div className="absolute bottom-2 right-2 flex flex-col items-center gap-1">
      <svg
        width="44" height="44" viewBox="-22 -22 44 44"
        style={{ transform: `rotate(${(packet.Steer / 127) * 180}deg)` }}
      >
        <circle cx="0" cy="0" r="18" fill="none" stroke="#64748b" strokeWidth="3" opacity="0.6" />
        <line x1="-12" y1="0" x2="-6" y2="0" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
        <line x1="6" y1="0" x2="12" y2="0" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
        <line x1="0" y1="6" x2="0" y2="12" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
        <circle cx="0" cy="0" r="3" fill="#475569" />
        <line x1="0" y1="-18" x2="0" y2="-14" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="relative bg-app-surface-alt/60 rounded-sm" style={{ width: 80, height: 8 }}>
        <div className="absolute left-1/2 top-0 w-px h-full bg-app-text-dim/40" />
        <div
          className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-cyan-400 border border-cyan-300 shadow-sm shadow-cyan-400/50"
          style={{
            left: `${50 + (packet.Steer / 127) * 50}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>
      <span className="text-[9px] font-mono text-app-text-secondary tabular-nums">
        {packet.Steer > 0 ? "R" : packet.Steer < 0 ? "L" : ""} {Math.abs(packet.Steer / 127 * 180).toFixed(0)}&deg;
      </span>
      <div className="flex gap-1 items-end" style={{ height: 60 }}>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] font-mono font-bold tabular-nums" style={{ color: brakeBarColor(packet.Brake) }}>{((packet.Brake / 255) * 100).toFixed(0)}</span>
          <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 40 }}>
            <div className="absolute bottom-0 w-full rounded-sm transition-all" style={{ height: `${(packet.Brake / 255) * 100}%`, background: `linear-gradient(to top, #ff9933, ${brakeBarColor(packet.Brake)})` }} />
          </div>
          <span className="text-[7px] text-app-text-muted">B</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] font-mono text-emerald-400 font-bold tabular-nums">{((packet.Accel / 255) * 100).toFixed(0)}</span>
          <div className="w-4 bg-app-surface-alt/60 rounded-sm overflow-hidden relative" style={{ height: 40 }}>
            <div className="absolute bottom-0 w-full bg-emerald-400 rounded-sm transition-all" style={{ height: `${(packet.Accel / 255) * 100}%` }} />
          </div>
          <span className="text-[7px] text-app-text-muted">T</span>
        </div>
      </div>
    </div>
  );
}

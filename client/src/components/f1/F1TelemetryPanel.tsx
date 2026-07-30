import { getGame } from "@shared/games/registry";
import { getFuelDisplay } from "@shared/games/telemetry";
import type { F1ExtendedData, TelemetryPacket } from "@shared/types";
import { m } from "@/paraglide/messages";
import { F1TyreCompound } from "./F1TyreCompound";

function formatSpeed(mps: number, unit: "metric" | "imperial"): string {
  if (unit === "imperial") return `${Math.round(mps * 2.23694)} mph`;
  return `${Math.round(mps * 3.6)} km/h`;
}

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "-:--.---";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

export function F1TelemetryPanel({ packet, f1, unitSystem = "metric" }: { packet: TelemetryPacket; f1: F1ExtendedData; unitSystem?: "metric" | "imperial" }) {
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const gear = packet.Gear <= 0 ? (packet.Gear === 0 ? "N" : "R") : packet.Gear.toString();
  const fuel = getFuelDisplay(
    packet,
    getGame(packet.gameId).telemetry.fuel,
  );

  return (
    <div className="space-y-4">
      {/* Speed + Gear + RPM */}
      <div className="flex items-end gap-4">
        <div>
          <div className="text-4xl font-black text-app-text tabular-nums">{formatSpeed(packet.Speed, unitSystem)}</div>
          <div className="text-xs text-app-text-dim mt-0.5">
            Lap {packet.LapNumber} &middot; P{packet.RacePosition}
          </div>
        </div>
        <div className="text-6xl font-black text-app-text-secondary leading-none">{gear}</div>
        <div className="flex-1">
          <div className="text-xs text-app-text-dim mb-1">{m.f1tele_rpm_label()}</div>
          <div className="h-3 bg-app-surface-alt rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-(--rev-normal) via-(--rev-high) to-(--rev-limit) rounded-full transition-all"
              style={{ width: `${(packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100}%` }}
            />
          </div>
          <div className="text-[10px] text-app-text-dim mt-0.5 tabular-nums">
            {Math.round(packet.CurrentEngineRpm)} / {Math.round(packet.EngineMaxRpm)}
          </div>
        </div>
      </div>

      {/* Throttle + Brake bars */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] text-app-text-dim mb-1">{m.f1tele_throttle()}</div>
          <div className="h-5 bg-app-surface-alt rounded overflow-hidden">
            <div className="h-full bg-(--ch-throttle) rounded transition-all" style={{ width: `${throttlePct}%` }} />
          </div>
        </div>
        <div>
          <div className="text-[10px] text-app-text-dim mb-1">{m.label_braking()}</div>
          <div className="h-5 bg-app-surface-alt rounded overflow-hidden">
            <div className="h-full bg-(--ch-brake) rounded transition-all" style={{ width: `${brakePct}%` }} />
          </div>
        </div>
      </div>

      {/* Lap times */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-app-text-dim">{m.f1tele_lap_current()}</div>
          <div className="text-sm text-app-text tabular-nums">{formatLapTime(packet.CurrentLap)}</div>
        </div>
        <div>
          <div className="text-[10px] text-app-text-dim">{m.f1tele_lap_last()}</div>
          <div className="text-sm text-app-text tabular-nums">{formatLapTime(packet.LastLap)}</div>
        </div>
        <div>
          <div className="text-[10px] text-app-text-dim">{m.label_best()}</div>
          <div className="text-sm text-(--lap-pace-best) tabular-nums">{formatLapTime(packet.BestLap)}</div>
        </div>
      </div>

      {/* Tyre info */}
      <div className="flex items-center justify-between">
        <F1TyreCompound f1={f1} />
        <div className="text-xs text-app-text-dim">
          {m.f1tele_fuel()}: {fuel.amount.toFixed(1)}{fuel.unit}
        </div>
      </div>

      {/* Tyre temps (display in Celsius for F1) */}
      <div>
        <div className="text-[10px] text-app-text-dim mb-1">{m.f1tele_tyre_surface_temps()}</div>
        <div className="grid grid-cols-4 gap-1 text-center">
          {(["FL", "FR", "RL", "RR"] as const).map((pos) => {
            const key = `TireTemp${pos}` as keyof TelemetryPacket;
            const tempC = Math.round(packet[key] as number);
            return (
              <div key={pos} className="bg-app-surface-alt rounded p-1">
                <div className="text-[9px] text-app-text-dim">{pos}</div>
                <div className="text-xs text-app-text-secondary tabular-nums">{tempC}&deg;C</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tyre wear */}
      <div>
        <div className="text-[10px] text-app-text-dim mb-1">{m.f1tele_tyre_wear()}</div>
        <div className="grid grid-cols-4 gap-1">
          {(["FL", "FR", "RL", "RR"] as const).map((pos) => {
            const key = `TireWear${pos}` as keyof TelemetryPacket;
            const wear = packet[key] as number;
            const pct = wear >= 0 ? Math.round(wear * 100) : 0;
            let color = "bg-(--severity-nominal)";
            if (pct < 30) color = "bg-(--severity-critical)";
            else if (pct < 60) color = "bg-(--severity-caution)";
            return (
              <div key={pos} className="bg-app-surface-alt rounded p-1">
                <div className="text-[9px] text-app-text-dim text-center">{pos}</div>
                <div className="h-1.5 bg-app-border-input rounded-full overflow-hidden mt-0.5">
                  <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
                </div>
                <div className="text-[9px] text-app-text-muted text-center tabular-nums">{pct}%</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

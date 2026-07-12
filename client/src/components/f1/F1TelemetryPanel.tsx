import type { TelemetryPacket, F1ExtendedData } from "@shared/types";
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

// Fahrenheit back to Celsius for display (F1 temps were normalized to F in parser)
function fToC(f: number): number {
  return (f - 32) / 1.8;
}

export function F1TelemetryPanel({
  packet,
  f1,
  unitSystem = "metric",
}: {
  packet: TelemetryPacket;
  f1: F1ExtendedData;
  unitSystem?: "metric" | "imperial";
}) {
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const gear = packet.Gear <= 0 ? (packet.Gear === 0 ? "N" : "R") : packet.Gear.toString();

  return (
    <div className="space-y-4">
      {/* Speed + Gear + RPM */}
      <div className="flex items-end gap-4">
        <div>
          <div className="text-4xl font-black text-white tabular-nums">{formatSpeed(packet.Speed, unitSystem)}</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            Lap {packet.LapNumber} &middot; P{packet.RacePosition}
          </div>
        </div>
        <div className="text-6xl font-black text-zinc-300 leading-none">{gear}</div>
        <div className="flex-1">
          <div className="text-xs text-zinc-500 mb-1">RPM</div>
          <div className="h-3 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-green-600 via-yellow-500 to-red-500 rounded-full transition-all"
              style={{ width: `${(packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100}%` }}
            />
          </div>
          <div className="text-[10px] text-zinc-500 mt-0.5 tabular-nums">
            {Math.round(packet.CurrentEngineRpm)} / {Math.round(packet.EngineMaxRpm)}
          </div>
        </div>
      </div>

      {/* Throttle + Brake bars */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] text-zinc-500 mb-1">Throttle</div>
          <div className="h-5 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-green-600 rounded transition-all" style={{ width: `${throttlePct}%` }} />
          </div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-500 mb-1">Brake</div>
          <div className="h-5 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-red-600 rounded transition-all" style={{ width: `${brakePct}%` }} />
          </div>
        </div>
      </div>

      {/* Lap times */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-zinc-500">Current</div>
          <div className="text-sm text-zinc-200 tabular-nums">{formatLapTime(packet.CurrentLap)}</div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-500">Last</div>
          <div className="text-sm text-zinc-200 tabular-nums">{formatLapTime(packet.LastLap)}</div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-500">Best</div>
          <div className="text-sm text-purple-400 tabular-nums">{formatLapTime(packet.BestLap)}</div>
        </div>
      </div>

      {/* Tyre info */}
      <div className="flex items-center justify-between">
        <F1TyreCompound f1={f1} />
        <div className="text-xs text-zinc-500">Fuel: {packet.Fuel.toFixed(1)} laps</div>
      </div>

      {/* Tyre temps (display in Celsius for F1) */}
      <div>
        <div className="text-[10px] text-zinc-500 mb-1">Tyre Surface Temps</div>
        <div className="grid grid-cols-4 gap-1 text-center">
          {(["FL", "FR", "RL", "RR"] as const).map((pos) => {
            const key = `TireTemp${pos}` as keyof TelemetryPacket;
            const tempC = Math.round(fToC(packet[key] as number));
            return (
              <div key={pos} className="bg-zinc-800 rounded p-1">
                <div className="text-[9px] text-zinc-500">{pos}</div>
                <div className="text-xs text-zinc-300 tabular-nums">{tempC}&deg;C</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tyre wear */}
      <div>
        <div className="text-[10px] text-zinc-500 mb-1">Tyre Wear</div>
        <div className="grid grid-cols-4 gap-1">
          {(["FL", "FR", "RL", "RR"] as const).map((pos) => {
            const key = `TireWear${pos}` as keyof TelemetryPacket;
            const wear = packet[key] as number;
            const pct = wear >= 0 ? Math.round(wear * 100) : 0;
            let color = "bg-green-600";
            if (pct < 30) color = "bg-red-500";
            else if (pct < 60) color = "bg-yellow-500";
            return (
              <div key={pos} className="bg-zinc-800 rounded p-1">
                <div className="text-[9px] text-zinc-500 text-center">{pos}</div>
                <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden mt-0.5">
                  <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
                </div>
                <div className="text-[9px] text-zinc-400 text-center tabular-nums">{pct}%</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

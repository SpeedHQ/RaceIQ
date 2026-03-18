import { useEffect, useState, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";

interface Props {
  packet: TelemetryPacket | null;
}

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "--:--.---";
  const mins = Math.floor(seconds);
  const secs = seconds - mins * 60;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function getSpeedMph(p: TelemetryPacket): number {
  const ms = Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2);
  return ms * 2.23694;
}

function GaugeBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function TireTemps({ packet }: { packet: TelemetryPacket }) {
  const temps = [
    { label: "FL", value: packet.TireTempFL },
    { label: "FR", value: packet.TireTempFR },
    { label: "RL", value: packet.TireTempRL },
    { label: "RR", value: packet.TireTempRR },
  ];

  function tempColor(t: number): string {
    if (t < 150) return "text-blue-400";
    if (t < 220) return "text-emerald-400";
    if (t < 280) return "text-amber-400";
    return "text-red-400";
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {temps.map((t) => (
        <div key={t.label} className="flex items-center justify-between bg-slate-800/50 rounded px-2 py-1">
          <span className="text-xs text-slate-500">{t.label}</span>
          <span className={`text-sm font-mono font-medium ${tempColor(t.value)}`}>
            {t.value.toFixed(0)}°
          </span>
        </div>
      ))}
    </div>
  );
}

export function LiveTelemetry({ packet }: Props) {
  const [carName, setCarName] = useState<string>("");
  const lastOrdinalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet || packet.CarOrdinal === 0) {
      setCarName("");
      lastOrdinalRef.current = null;
      return;
    }
    if (packet.CarOrdinal === lastOrdinalRef.current) return;
    lastOrdinalRef.current = packet.CarOrdinal;

    fetch(`/api/car-name/${packet.CarOrdinal}`)
      .then((r) => r.text())
      .then(setCarName)
      .catch(() => setCarName(`Car #${packet.CarOrdinal}`));
  }, [packet?.CarOrdinal]);

  if (!packet) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600">
        Waiting for telemetry data...
      </div>
    );
  }

  const speed = getSpeedMph(packet);
  const throttlePct = (packet.Accel / 255) * 100;
  const brakePct = (packet.Brake / 255) * 100;
  const rpmPct = packet.EngineMaxRpm > 0 ? (packet.CurrentEngineRpm / packet.EngineMaxRpm) * 100 : 0;

  return (
    <div className="grid gap-4 p-4">
      {/* Car Name */}
      {carName && (
        <div className="text-lg font-semibold text-white truncate">{carName}</div>
      )}

      {/* Speed + Gear */}
      <div className="flex items-end gap-4">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">Speed</div>
          <div className="text-5xl font-mono font-bold text-white tabular-nums">
            {speed.toFixed(0)}
          </div>
          <div className="text-xs text-slate-500">mph</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Gear</div>
          <div className="text-5xl font-mono font-bold text-cyan-400 tabular-nums">
            {packet.Gear === 0 ? "R" : packet.Gear === 11 ? "N" : packet.Gear}
          </div>
        </div>
      </div>

      {/* RPM */}
      <div>
        <div className="flex justify-between text-xs text-slate-500 mb-1">
          <span>RPM</span>
          <span className="font-mono">{packet.CurrentEngineRpm.toFixed(0)}</span>
        </div>
        <GaugeBar
          value={packet.CurrentEngineRpm}
          max={packet.EngineMaxRpm}
          color={rpmPct > 90 ? "bg-red-500" : rpmPct > 70 ? "bg-amber-400" : "bg-cyan-400"}
        />
      </div>

      {/* Throttle / Brake */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Throttle</span>
            <span className="font-mono">{throttlePct.toFixed(0)}%</span>
          </div>
          <GaugeBar value={throttlePct} max={100} color="bg-emerald-400" />
        </div>
        <div>
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Brake</span>
            <span className="font-mono">{brakePct.toFixed(0)}%</span>
          </div>
          <GaugeBar value={brakePct} max={100} color="bg-red-500" />
        </div>
      </div>

      {/* Lap Info */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 rounded p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Lap</div>
          <div className="text-2xl font-mono font-semibold text-white tabular-nums">
            {packet.LapNumber}
          </div>
        </div>
        <div className="bg-slate-800/50 rounded p-3">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Lap Time</div>
          <div className="text-2xl font-mono font-semibold text-white tabular-nums">
            {formatLapTime(packet.CurrentLap)}
          </div>
        </div>
      </div>

      {/* Last Lap / Best Lap */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 rounded p-2">
          <div className="text-xs text-slate-500">Last Lap</div>
          <div className="text-sm font-mono text-slate-300 tabular-nums">
            {formatLapTime(packet.LastLap)}
          </div>
        </div>
        <div className="bg-slate-800/50 rounded p-2">
          <div className="text-xs text-slate-500">Best Lap</div>
          <div className="text-sm font-mono text-purple-400 tabular-nums">
            {formatLapTime(packet.BestLap)}
          </div>
        </div>
      </div>

      {/* Tire Temps */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Tire Temps</div>
        <TireTemps packet={packet} />
      </div>
    </div>
  );
}

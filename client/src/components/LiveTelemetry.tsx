import { useEffect, useState, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";
import { CAR_CLASS_NAMES, DRIVETRAIN_NAMES } from "@shared/types";
import { SteeringWheel } from "./SteeringWheel";

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
  return p.Speed * 2.23694; // m/s to mph
}

function GaugeBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function tempColor(t: number): string {
  if (t < 150) return "text-blue-400";
  if (t < 220) return "text-emerald-400";
  if (t < 280) return "text-amber-400";
  return "text-red-400";
}

function tempBg(t: number): string {
  if (t < 150) return "bg-blue-500/20 border-blue-500/40";
  if (t < 220) return "bg-emerald-500/20 border-emerald-500/40";
  if (t < 280) return "bg-amber-500/20 border-amber-500/40";
  return "bg-red-500/20 border-red-500/40";
}

function wearBarColor(w: number): string {
  if (w > 0.75) return "bg-emerald-400";
  if (w > 0.5) return "bg-yellow-400";
  if (w > 0.25) return "bg-orange-400";
  return "bg-red-500";
}

function gripColor(combined: number): string {
  if (combined < 0.5) return "text-emerald-400";
  if (combined < 1.0) return "text-yellow-400";
  if (combined < 2.0) return "text-orange-400";
  return "text-red-400";
}

function gripLabel(combined: number): string {
  if (combined < 0.5) return "GRIP";
  if (combined < 1.0) return "SLIDE";
  if (combined < 2.0) return "SLIP";
  return "LOSS";
}

function gripPulse(combined: number): string {
  if (combined >= 2.0) return "animate-pulse";
  return "";
}

function WheelCard({ label, temp, wear, combined }: {
  label: string;
  temp: number;
  wear: number;
  combined: number;
}) {
  return (
    <div className={`rounded-lg border p-2.5 transition-colors ${tempBg(temp)}`}>
      {/* Header: label + traction badge */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{label}</span>
        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${gripColor(combined)} bg-slate-900/60 ${gripPulse(combined)}`}>
          {gripLabel(combined)}
        </span>
      </div>

      {/* Temp */}
      <div className={`text-2xl font-mono font-bold tabular-nums leading-none mb-1.5 ${tempColor(temp)}`}>
        {temp.toFixed(0)}°
      </div>

      {/* Wear bar */}
      {wear >= 0 ? (
        <div className="flex items-center gap-1.5">
          <div className="flex-1 h-1.5 bg-slate-900/50 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${wearBarColor(wear)}`}
              style={{ width: `${wear * 100}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-slate-400 w-7 text-right">{(wear * 100).toFixed(0)}%</span>
        </div>
      ) : (
        <div className="text-[10px] text-slate-600 italic">wear n/a</div>
      )}
    </div>
  );
}

function TireDiagram({ packet }: { packet: TelemetryPacket }) {
  const wheels = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, combined: Math.abs(packet.TireCombinedSlipFL) },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, combined: Math.abs(packet.TireCombinedSlipFR) },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, combined: Math.abs(packet.TireCombinedSlipRL) },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, combined: Math.abs(packet.TireCombinedSlipRR) },
  ];

  return (
    <div className="relative">
      {/* Car silhouette connector lines */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-12 h-24 border border-slate-700/50 rounded-md" />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {/* Front axle */}
        <WheelCard {...wheels[0]} />
        <WheelCard {...wheels[1]} />

        {/* Axle label */}
        <div className="col-span-2 flex items-center justify-center">
          <div className="h-px w-full bg-slate-700/30" />
        </div>

        {/* Rear axle */}
        <WheelCard {...wheels[2]} />
        <WheelCard {...wheels[3]} />
      </div>
    </div>
  );
}

function SuspensionTravel({ packet }: { packet: TelemetryPacket }) {
  const corners = [
    { label: "FL", norm: packet.NormSuspensionTravelFL, meters: packet.SuspensionTravelMetersFL },
    { label: "FR", norm: packet.NormSuspensionTravelFR, meters: packet.SuspensionTravelMetersFR },
    { label: "RL", norm: packet.NormSuspensionTravelRL, meters: packet.SuspensionTravelMetersRL },
    { label: "RR", norm: packet.NormSuspensionTravelRR, meters: packet.SuspensionTravelMetersRR },
  ];

  function suspColor(norm: number): string {
    if (norm < 0.6) return "bg-cyan-400";
    if (norm < 0.85) return "bg-yellow-400";
    return "bg-red-500";
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {corners.map((c) => (
        <div key={c.label} className="bg-slate-800/50 rounded px-2 py-1.5">
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-500">{c.label}</span>
            <span className="text-slate-400 font-mono">{(c.norm * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${suspColor(c.norm)}`} style={{ width: `${c.norm * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LiveTelemetry({ packet }: Props) {
  const [carName, setCarName] = useState<string>("");
  const lastCarOrdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
    const ord = packet.CarOrdinal;
    if (ord === lastCarOrdRef.current) return;
    lastCarOrdRef.current = ord;

    fetch(`/api/car-name/${ord}`)
      .then((r) => r.text())
      .then((name) => setCarName(name))
      .catch(() => setCarName(`Car #${ord}`));
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
      {/* Car Info */}
      {carName && (
        <div>
          <div className="text-lg font-semibold text-white truncate">{carName}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-cyan-400">
              {CAR_CLASS_NAMES[packet.CarClass] ?? "?"} {packet.CarPerformanceIndex}
            </span>
            <span className="text-xs text-slate-500">
              {DRIVETRAIN_NAMES[packet.DrivetrainType] ?? "?"} &middot; {packet.NumCylinders}cyl
            </span>
          </div>
        </div>
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

      {/* Steering Wheel */}
      <div className="flex justify-center">
        <SteeringWheel steer={packet.Steer} />
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

      {/* Tires — unified 4-wheel display */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Tires</div>
        <TireDiagram packet={packet} />
      </div>

      {/* Suspension */}
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Suspension Travel</div>
        <SuspensionTravel packet={packet} />
      </div>
    </div>
  );
}

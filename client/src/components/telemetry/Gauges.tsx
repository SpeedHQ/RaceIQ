import { useEffect, useRef, useState } from "react";
import type { TelemetryPacket } from "@shared/types";
import { client } from "@/lib/rpc";

/**
 * ArcGauge — 270-degree SVG arc gauge (135deg to 405deg sweep).
 * Used for power, torque, and boost readouts. SVG arc path is computed
 * from polar coordinates converted to Cartesian for the arc endpoints.
 */
export function ArcGauge({ value, max, label, unit, color }: {
  value: number;
  max: number;
  label: string;
  unit: string;
  color: string;
}) {
  const size = 70;
  const cx = size / 2, cy = size / 2;
  const r = 28;
  const startAngle = 135;
  const endAngle = 405;
  const range = endAngle - startAngle;
  const pct = Math.min(Math.max(value / max, 0), 1);
  const valAngle = startAngle + range * pct;

  const toRad = (d: number) => (d * Math.PI) / 180;
  const arcPath = (from: number, to: number) => {
    const x1 = cx + r * Math.cos(toRad(from));
    const y1 = cy + r * Math.sin(toRad(from));
    const x2 = cx + r * Math.cos(toRad(to));
    const y2 = cy + r * Math.sin(toRad(to));
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {/* Background arc */}
        <path d={arcPath(startAngle, endAngle)} fill="none" stroke="rgba(100,116,139,0.15)" strokeWidth={5} strokeLinecap="round" />
        {/* Value arc */}
        {pct > 0.01 && (
          <path d={arcPath(startAngle, valAngle)} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />
        )}
        {/* Value text */}
        <text x={cx} y={cy - 1} textAnchor="middle" fill={color} fontSize={12} fontWeight="bold" fontFamily="monospace">
          {value.toFixed(0)}
        </text>
        {/* Unit */}
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">
          {unit}
        </text>
      </svg>
      <span className="text-[9px] text-app-text-muted -mt-1">{label}</span>
    </div>
  );
}

/**
 * FuelGauge — Tracks fuel consumption per lap to estimate remaining laps.
 * Strategy: records fuel level at each lap start, computes delta on lap boundary,
 * averages last 5 laps for the burn rate estimate. Seeds from server history
 * so estimates survive page refreshes. Filters out impossible values (>100% per lap).
 */
export function FuelGauge({ packet }: { packet: TelemetryPacket }) {
  const fuelRef = useRef<{
    lapStart: number;
    lastLap: number;
    history: number[];  // fuel used per lap (all recorded)
    avgPerLap: number | null;
  }>({
    lapStart: packet.Fuel,
    lastLap: packet.LapNumber,
    history: [],
    avgPerLap: null,
  });
  const fetchedRef = useRef(false);
  const [fuelStats, setFuelStats] = useState<{ avgPerLap: number | null; lapStart: number }>({ avgPerLap: null, lapStart: packet.Fuel });

  // Seed from server fuel history
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["fuel-history"].$get()
      .then((r) => r.json() as Promise<{ fuelUsed: number }[]>)
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const f = fuelRef.current;
          f.history = data.map((d) => d.fuelUsed).filter((v) => v > 0 && v < 1);
          if (f.history.length > 0) {
            const recent = f.history.slice(-5);
            f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
            setFuelStats({ avgPerLap: f.avgPerLap, lapStart: f.lapStart });
          }
        }
      })
      .catch(() => {});
  }, []);

  // Track fuel consumption per lap
  useEffect(() => {
    const f = fuelRef.current;
    if (packet.LapNumber !== f.lastLap && packet.LapNumber > f.lastLap) {
      const used = f.lapStart - packet.Fuel;
      if (used > 0 && used < 1) {
        f.history.push(used);
        if (f.history.length > 50) f.history.shift();
        const recent = f.history.slice(-5);
        f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
      }
      f.lapStart = packet.Fuel;
      setFuelStats({ avgPerLap: f.avgPerLap, lapStart: f.lapStart });
    }
    f.lastLap = packet.LapNumber;
  }, [packet.LapNumber, packet.Fuel]);

  const fuelIsLitres = packet.gameId === "acc" || packet.gameId === "f1-2025";
  const pct = fuelIsLitres ? Math.min(100, packet.Fuel) : packet.Fuel * 100;
  const fuelLabel = fuelIsLitres ? `${packet.Fuel.toFixed(1)}L` : `${pct.toFixed(0)}%`;
  const fuelColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "bg-red-500" : packet.Fuel < 15 ? "bg-amber-400" : "bg-emerald-400")
    : (pct < 20 ? "bg-red-500" : pct < 40 ? "bg-amber-400" : "bg-emerald-400");
  const textColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "text-red-400" : packet.Fuel < 15 ? "text-amber-400" : "text-emerald-400")
    : (pct < 20 ? "text-red-400" : pct < 40 ? "text-amber-400" : "text-emerald-400");
  const avg = fuelStats.avgPerLap;
  const lapsRemaining = avg && avg > 0 ? Math.floor(packet.Fuel / avg) : null;

  // Current lap fuel used so far
  const currentLapPct = (fuelStats.lapStart - packet.Fuel) * 100;

  // Delta vs average: positive = using more than avg, negative = saving
  return (
    <div className="flex-1">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className={`font-mono font-bold ${textColor}`}>Fuel {fuelLabel}</span>
        {lapsRemaining != null && (
          <span className="font-mono text-app-text-secondary">
            ~{lapsRemaining} laps left
          </span>
        )}
      </div>
      <div className="h-2 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${fuelColor} ${pct < 20 ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      {avg != null && (
        <div className="flex justify-between text-[9px] font-mono mt-0.5">
          <span className="text-app-text-muted">
            {(avg * 100).toFixed(1)}%/lap avg
          </span>
          <span className="text-app-text-muted">
            This lap: {currentLapPct.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}

export function PowerTorque({ packet }: { packet: TelemetryPacket }) {
  const hp = packet.Power / 745.7;
  const nm = packet.Torque;
  if (hp <= 0 && nm <= 0) return null;
  const maxHp = 1000;
  const maxNm = 1000;

  return (
    <div className="flex justify-center gap-2">
      <ArcGauge value={hp} max={maxHp} label="Power" unit="hp" color="#fb923c" />
      <ArcGauge value={nm} max={maxNm} label="Torque" unit="Nm" color="#fbbf24" />
    </div>
  );
}

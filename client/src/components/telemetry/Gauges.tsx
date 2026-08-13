import { getGame } from "@shared/games/registry";
import { getFuelAmount, getFuelDisplay, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { useEffect, useRef, useState } from "react";
import { severityColor } from "@/lib/colors";
import { client } from "@/lib/rpc";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

/**
 * Used for power, torque, and boost readouts.
 */
export function ArcGauge({ value, max, label, unit, color }: { value: number; max: number; label: string; unit: string; color: string }) {
  const size = 70;
  const cx = size / 2,
    cy = size / 2;
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
        <path d={arcPath(startAngle, endAngle)} fill="none" stroke="var(--app-text-dim)" strokeOpacity={0.15} strokeWidth={5} strokeLinecap="round" />
        {/* Value arc */}
        {pct > 0.01 && <path d={arcPath(startAngle, valAngle)} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />}
        {/* Value text */}
        <text x={cx} y={cy - 1} textAnchor="middle" fill={color} fontSize={12} fontWeight="var(--font-weight-bold)" fontFamily="var(--font-mono)">
          {value.toFixed(0)}
        </text>
        {/* Unit */}
        <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--app-text-dim)" fontSize={7} fontFamily="var(--font-mono)">
          {unit}
        </text>
      </svg>
      <span className="text-app-micro text-app-text-muted -mt-1">{label}</span>
    </div>
  );
}

/**
 * FuelGauge — Tracks fuel consumption per lap to estimate remaining laps.
 * Strategy: records fuel level at each lap start, computes delta on lap boundary,
 * averages last 5 laps for the burn rate estimate. Seeds from server history
 * so estimates survive page refreshes. Fraction sources reject impossible
 * values (>100% per lap); litre sources retain their native burn amount.
 */
export function FuelGauge({ packet, view }: { packet?: TelemetryPacket; view?: LiveTelemetryView }) {
  const gameId = view?.simulator ?? packet?.gameId;
  const fuelSpec = getGame(gameId ?? "fm-2023").telemetry.fuel;
  const fuelRef = useRef<{
    lapStart: number;
    lastLap: number;
    history: number[]; // fuel used per lap (all recorded)
    avgPerLap: number | null;
  }>({
    lapStart: packet?.Fuel ?? 0,
    lastLap: packet?.LapNumber ?? 0,
    history: [],
    avgPerLap: null,
  });
  const fetchedRef = useRef(false);
  const [fuelStats, setFuelStats] = useState<{ avgPerLap: number | null; lapStart: number }>({ avgPerLap: null, lapStart: packet?.Fuel ?? 0 });

  // Seed from server fuel history
  useEffect(() => {
    if (!packet || fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["fuel-history"]
      .$get()
      .then((r) => r.json() as Promise<{ fuelUsed: number }[]>)
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const f = fuelRef.current;
          f.history = data.map((d) => d.fuelUsed).filter((value) => Number.isFinite(value) && value > 0 && (fuelSpec.packetUnit !== "fraction" || value < 1));
          if (f.history.length > 0) {
            const recent = f.history.slice(-5);
            f.avgPerLap = recent.reduce((s, v) => s + v, 0) / recent.length;
            setFuelStats({ avgPerLap: f.avgPerLap, lapStart: f.lapStart });
          }
        }
      })
      .catch(() => {});
  }, [fuelSpec.packetUnit, packet]);

  // Track fuel consumption per lap
  useEffect(() => {
    if (!packet) return;
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
  }, [packet?.LapNumber, packet?.Fuel]);

  if (!packet && view) {
    const amount = view.fuel.amount ?? 0;
    const capacity = view.fuel.capacity;
    const fill = capacity && capacity > 0 ? (amount / capacity) * 100 : undefined;
    return <div className="flex-1"><div className="flex justify-between text-app-caption mb-0.5"><span className="font-mono font-bold">Fuel {amount.toFixed(1)}</span></div><div className="h-2 rounded-full overflow-hidden">{fill !== undefined && <div className="h-full rounded-full" style={{ width: `${fill}%` }} />}</div></div>;
  }
  if (!packet) return null;

  const fuel = getFuelDisplay(packet, fuelSpec);
  const fillPct = fuel.fillRatio === undefined ? undefined : fuel.fillRatio * 100;
  const isCritical = fuel.fillRatio === undefined ? fuel.amount < 5 : fuel.fillRatio < 0.2;
  const isWarning = !isCritical && (fuel.fillRatio === undefined ? fuel.amount < 15 : fuel.fillRatio < 0.4);
  const fuelColor = severityColor(isCritical ? 3 : isWarning ? 1 : 0);
  const avg = fuelStats.avgPerLap;
  const lapsRemaining = avg && avg > 0 ? Math.floor(packet.Fuel / avg) : null;
  const averageDisplay = avg === null ? null : getFuelAmount(avg, fuelSpec);

  // Current lap fuel used so far
  const currentLapDisplay = getFuelAmount(fuelStats.lapStart - packet.Fuel, fuelSpec);

  // Delta vs average: positive = using more than avg, negative = saving
  return (
    <div className="flex-1">
      <div className="flex justify-between text-app-caption mb-0.5">
        <span className="font-mono font-bold" style={{ color: fuelColor }}>
          Fuel {fuel.amount.toFixed(1)}
          {fuel.unit}
        </span>
        {lapsRemaining != null && <span className="font-mono text-app-text-secondary">~{lapsRemaining} laps left</span>}
      </div>
      {fillPct === undefined ? (
        <div className="h-2 rounded-full border border-dashed border-app-border" title="Fuel capacity unavailable" />
      ) : (
        <div className="h-2 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${isCritical ? "animate-pulse" : ""}`} style={{ backgroundColor: fuelColor, width: `${fillPct}%` }} />
        </div>
      )}
      {averageDisplay != null && (
        <div className="flex justify-between text-app-micro font-mono mt-0.5">
          <span className="text-app-text-muted">
            {averageDisplay.amount.toFixed(1)}
            {averageDisplay.unit}/lap avg
          </span>
          <span className="text-app-text-muted">
            This lap: {currentLapDisplay.amount.toFixed(1)}
            {currentLapDisplay.unit}
          </span>
        </div>
      )}
    </div>
  );
}

export function PowerTorque({ packet, view }: { packet?: TelemetryPacket; view?: LiveTelemetryView }) {
  if (!packet && view) {
    const model = getGame(view.simulator).telemetry;
    return <div className="flex justify-center gap-2">{model.power && <ArcGauge value={(view.engine.powerW ?? 0) / WATTS_PER_HORSEPOWER} max={1000} label="Power" unit="hp" color="var(--telemetry-power)" />}{model.torque && <ArcGauge value={view.engine.torqueNm ?? 0} max={1000} label="Torque" unit="Nm" color="var(--telemetry-torque)" />}</div>;
  }
  if (!packet) return null;

  const showPower = getGame(view?.simulator ?? packet.gameId).telemetry.power !== undefined;
  const showTorque = getGame(view?.simulator ?? packet.gameId).telemetry.torque !== undefined;
  const hp = packet.Power / WATTS_PER_HORSEPOWER;
  const nm = packet.Torque;
  const maxHp = 1000;
  const maxNm = 1000;

  return (
    <div className="flex justify-center gap-2">
      {showPower && <ArcGauge value={hp} max={maxHp} label="Power" unit="hp" color="var(--telemetry-power)" />}
      {showTorque && <ArcGauge value={nm} max={maxNm} label="Torque" unit="Nm" color="var(--telemetry-torque)" />}
    </div>
  );
}

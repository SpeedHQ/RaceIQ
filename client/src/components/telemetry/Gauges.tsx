import { getGame } from "@shared/games/registry";
import { getFuelAmount, getFuelDisplaySemantic, WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { useEffect, useRef, useState } from "react";
import { severityColor } from "@/lib/colors";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";

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
 * Records canonical fuel at each lap start and averages recent lap deltas.
 * Fraction sources reject impossible values; litre sources retain native amounts.
 */
export function FuelGauge({ view }: { view: LiveTelemetryView }) {
  const fuelSpec = getGame(view.simulator).telemetry.fuel;
  const fuelAmount = view.fuel.amount;
  const lapNumber = view.timing.lapNumber;
  const fuelRef = useRef<{
    lapStart: number | null;
    lastLap: number | null;
    history: number[];
    avgPerLap: number | null;
    streamId: string;
  }>({
    lapStart: fuelAmount ?? null,
    lastLap: lapNumber ?? null,
    history: [],
    avgPerLap: null,
    streamId: view.streamId,
  });
  const [fuelStats, setFuelStats] = useState<{ avgPerLap: number | null; lapStart: number | null }>({
    avgPerLap: null,
    lapStart: fuelAmount ?? null,
  });

  useEffect(() => {
    if (fuelAmount === undefined || lapNumber === undefined) return;
    const fuel = fuelRef.current;
    if (fuel.streamId !== view.streamId) {
      fuel.streamId = view.streamId;
      fuel.lapStart = fuelAmount;
      fuel.lastLap = lapNumber;
      fuel.history = [];
      fuel.avgPerLap = null;
      setFuelStats({ avgPerLap: null, lapStart: fuelAmount });
      return;
    }
    if (fuel.lastLap !== null && lapNumber > fuel.lastLap && fuel.lapStart !== null) {
      const used = fuel.lapStart - fuelAmount;
      if (used > 0 && (fuelSpec.packetUnit !== "fraction" || used < 1)) {
        fuel.history.push(used);
        if (fuel.history.length > 50) fuel.history.shift();
        const recent = fuel.history.slice(-5);
        fuel.avgPerLap = recent.reduce((sum, amount) => sum + amount, 0) / recent.length;
      }
      fuel.lapStart = fuelAmount;
      setFuelStats({ avgPerLap: fuel.avgPerLap, lapStart: fuel.lapStart });
    } else if (fuel.lapStart === null) {
      fuel.lapStart = fuelAmount;
      setFuelStats({ avgPerLap: fuel.avgPerLap, lapStart: fuelAmount });
    }
    fuel.lastLap = lapNumber;
  }, [fuelAmount, fuelSpec.packetUnit, lapNumber, view.streamId]);

  if (fuelAmount === undefined) {
    return (
      <div className="flex-1">
        <div className="flex justify-between text-app-caption mb-0.5">
          <span className="font-mono font-bold text-app-text-dim">Fuel —</span>
        </div>
        <div className="h-2 rounded-full border border-dashed border-app-border" title="Fuel unavailable" />
      </div>
    );
  }

  const fuel = getFuelDisplaySemantic(fuelAmount, view.fuel.capacity, fuelSpec);
  const fillPct = fuel.fillRatio === undefined ? undefined : fuel.fillRatio * 100;
  const isCritical = fuel.fillRatio === undefined ? fuel.amount < 5 : fuel.fillRatio < 0.2;
  const isWarning = !isCritical && (fuel.fillRatio === undefined ? fuel.amount < 15 : fuel.fillRatio < 0.4);
  const fuelColor = severityColor(isCritical ? 3 : isWarning ? 1 : 0);
  const average = fuelStats.avgPerLap;
  const lapsRemaining = average !== null && average > 0 ? Math.floor(fuelAmount / average) : null;
  const averageDisplay = average === null ? null : getFuelAmount(average, fuelSpec);
  const currentLapUsed = fuelStats.lapStart === null ? null : getFuelAmount(fuelStats.lapStart - fuelAmount, fuelSpec);

  return (
    <div className="flex-1">
      <div className="flex justify-between text-app-caption mb-0.5">
        <span className="font-mono font-bold" style={{ color: fuelColor }}>
          Fuel {fuel.amount.toFixed(1)}
          {fuel.unit}
        </span>
        {lapsRemaining !== null && <span className="font-mono text-app-text-secondary">~{lapsRemaining} laps left</span>}
      </div>
      {fillPct === undefined ? (
        <div className="h-2 rounded-full border border-dashed border-app-border" title="Fuel capacity unavailable" />
      ) : (
        <div className="h-2 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${isCritical ? "animate-pulse" : ""}`} style={{ backgroundColor: fuelColor, width: `${fillPct}%` }} />
        </div>
      )}
      {averageDisplay !== null && currentLapUsed !== null && (
        <div className="flex justify-between text-app-micro font-mono mt-0.5">
          <span className="text-app-text-muted">
            {averageDisplay.amount.toFixed(1)}
            {averageDisplay.unit}/lap avg
          </span>
          <span className="text-app-text-muted">
            This lap: {currentLapUsed.amount.toFixed(1)}
            {currentLapUsed.unit}
          </span>
        </div>
      )}
    </div>
  );
}

export function PowerTorque({ view }: { view: LiveTelemetryView }) {
  const model = getGame(view.simulator).telemetry;
  return (
    <div className="flex justify-center gap-2">
      {model.power && view.engine.powerW !== undefined && <ArcGauge value={view.engine.powerW / WATTS_PER_HORSEPOWER} max={1000} label="Power" unit="hp" color="var(--telemetry-power)" />}
      {model.torque && view.engine.torqueNm !== undefined && <ArcGauge value={view.engine.torqueNm} max={1000} label="Torque" unit="Nm" color="var(--telemetry-torque)" />}
    </div>
  );
}

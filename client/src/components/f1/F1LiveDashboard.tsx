import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTelemetryStore } from "../../stores/telemetry";
import { useUnits } from "../../hooks/useUnits";
import { useLaps, useDeleteLap } from "../../hooks/queries";
import { useGameRoute } from "../../stores/game";
import { client } from "../../lib/rpc";
import type { TelemetryPacket, F1ExtendedData } from "@shared/types";
import { LapTimeChart } from "../LapTimeChart";

import { useDemoMode } from "../../hooks/useDemoMode";
import { NoDataView } from "../NoDataView";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatLapTime(seconds: number): string {
  if (seconds <= 0) return "-:--.---";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
}

function formatSpeed(mps: number, unit: "metric" | "imperial"): string {
  if (unit === "imperial") return `${Math.round(mps * 2.23694)}`;
  return `${Math.round(mps * 3.6)}`;
}

function fToC(f: number): number {
  return (f - 32) / 1.8;
}

const WEATHER_LABELS: Record<number, string> = {
  0: "Clear", 1: "Light Cloud", 2: "Overcast",
  3: "Light Rain", 4: "Heavy Rain", 5: "Storm",
};

const COMPOUND_COLORS: Record<string, { bg: string; text: string }> = {
  soft:    { bg: "bg-red-600",    text: "text-white" },
  medium:  { bg: "bg-yellow-500", text: "text-black" },
  hard:    { bg: "bg-white",      text: "text-black" },
  inter:   { bg: "bg-green-500",  text: "text-white" },
  wet:     { bg: "bg-blue-500",   text: "text-white" },
  unknown: { bg: "bg-app-surface-alt", text: "text-app-text-muted" },
};

const COMPOUND_DOT: Record<string, string> = {
  soft: "bg-red-500", medium: "bg-yellow-400", hard: "bg-white",
  inter: "bg-green-500", wet: "bg-blue-500", unknown: "bg-app-text-dim",
};

const ERS_MAX_ENERGY = 4_000_000;

const DEPLOY_MODES: Record<number, { label: string; color: string }> = {
  0: { label: "NONE", color: "text-app-text-muted" },
  1: { label: "MEDIUM", color: "text-blue-400" },
  2: { label: "HOTLAP", color: "text-purple-400" },
  3: { label: "OVERTAKE", color: "text-red-400" },
};

function formatGap(gap: number): string {
  if (gap === 0) return "-";
  return gap > 0 ? `+${gap.toFixed(1)}` : `-${Math.abs(gap).toFixed(1)}`;
}

// ── Main Dashboard ───────────────────────────────────────────────────────────

export function F1LiveDashboard() {
  const rawPacket = useTelemetryStore((s) => s.rawPacket);
  const units = useUnits();
  const demo = useDemoMode("f1-2025");

  const hasF1Data = rawPacket?.gameId === "f1-2025" && rawPacket.f1;
  const f1 = hasF1Data ? rawPacket.f1! : null;

  if (!f1) {
    return (
      <div className="flex-1 flex flex-col">
        <F1PageHeader demo={demo} />
        <NoDataView />
      </div>
    );
  }

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      {/* Left column */}
      <div className="border-r border-app-border overflow-auto">
        <F1PageHeader demo={demo} />
        <div className="grid grid-cols-2 border-b border-app-border">
          <div className="border-r border-app-border">
            <TelemetrySection packet={rawPacket!} f1={f1} units={units} />
            <div className="border-t border-app-border">
              <ErsSection f1={f1} />
            </div>
          </div>
          <div>
            <RaceHeader packet={rawPacket!} f1={f1} units={units} />
            <div className="border-t border-app-border">
              <WeatherWidget f1={f1} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 border-b border-app-border">
          <div className="border-r border-app-border">
            <TireTempDiagram packet={rawPacket!} />
          </div>
          <PitEstimateSection packet={rawPacket!} />
        </div>
        <CarDamageSection f1={f1} />
        <GridSection f1={f1} playerPosition={rawPacket!.RacePosition} />
      </div>

      {/* Right column */}
      <div className="overflow-auto flex flex-col">
        <SectorTimesSection packet={rawPacket!} f1={f1} />
        <LapTimeChart packet={rawPacket!} />
        <RecentLaps />
      </div>
    </div>
  );
}

// ── Page Header (matches Live's PageHeader) ──────────────────────────────────

function F1PageHeader({ demo }: { demo: ReturnType<typeof useDemoMode> }) {
  return (
    <div className="p-2 border-b border-app-border flex items-center justify-between">
      <div className="flex items-center gap-1 bg-app-surface-alt rounded p-0.5">
        <span className="text-sm font-semibold px-2 py-0.5 rounded bg-app-accent/20 text-app-accent">
          F1 2025
        </span>
      </div>
      {import.meta.env.DEV && (
        <button
          onClick={demo.toggle}
          disabled={demo.loading}
          className={`text-sm font-mono font-semibold px-3 py-1 rounded border transition-colors ${
            demo.active
              ? "bg-amber-500/20 border-amber-500/50 text-amber-400 hover:bg-amber-500/30"
              : demo.loading
                ? "bg-app-surface-alt border-app-border text-app-text-dim cursor-wait"
                : "bg-app-surface-alt border-app-border text-app-text-muted hover:text-app-text hover:border-app-border-hover"
          }`}
        >
          {demo.loading ? "Loading..." : demo.active ? "Stop Demo" : "Demo"}
        </button>
      )}
    </div>
  );
}

// ── Race Header ──────────────────────────────────────────────────────────────

function RaceHeader({ packet, f1, units }: {
  packet: TelemetryPacket; f1: F1ExtendedData; units: ReturnType<typeof useUnits>;
}) {
  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">
          {f1.sessionType?.replace(/-/g, " ").toUpperCase() ?? "SESSION"}
        </h2>
        <div className="flex items-center gap-2">
          {f1.totalLaps > 0 && (
            <span className="text-xs text-app-text-secondary font-mono">{f1.totalLaps} laps</span>
          )}
        </div>
      </div>
      <div className="p-3">
        <div className="flex items-baseline gap-4 mb-2">
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Position</div>
            <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
              P{packet.RacePosition}
            </div>
          </div>
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Lap</div>
            <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
              {packet.LapNumber}{f1.totalLaps > 0 ? `/${f1.totalLaps}` : ""}
            </div>
          </div>
          <div className="flex-1">
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Current</div>
            <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">
              {formatLapTime(packet.CurrentLap)}
            </div>
          </div>
          {packet.LastLap > 0 && packet.BestLap > 0 && (() => {
            const delta = packet.LastLap - packet.BestLap;
            const color = delta <= 0 ? "text-emerald-400" : delta < 1 ? "text-orange-400" : "text-red-400";
            return (
              <div className="text-right">
                <div className="text-xs text-app-text-muted uppercase tracking-wider">Delta</div>
                <div className={`text-3xl font-mono font-bold tabular-nums leading-none ${color}`}>
                  {delta <= 0 ? "" : "+"}{delta.toFixed(3)}
                </div>
              </div>
            );
          })()}
        </div>
        <div className="flex gap-4 items-end">
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Last</div>
            <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none">
              {formatLapTime(packet.LastLap)}
            </div>
          </div>
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Best</div>
            <div className="text-xl font-mono font-bold text-purple-400 tabular-nums leading-none">
              {formatLapTime(packet.BestLap)}
            </div>
          </div>
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Dist</div>
            <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none">
              {units.speedLabel === "km/h"
                ? `${(packet.DistanceTraveled / 1000).toFixed(2)} km`
                : `${(packet.DistanceTraveled / 1609.34).toFixed(2)} mi`}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Telemetry Section ────────────────────────────────────────────────────────

function TelemetrySection({ packet, f1, units }: {
  packet: TelemetryPacket; f1: F1ExtendedData; units: ReturnType<typeof useUnits>;
}) {
  const gear = packet.Gear <= 0 ? (packet.Gear === 0 ? "N" : "R") : packet.Gear.toString();

  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Speed</h2>
        <DrsInline f1={f1} />
      </div>
      <div className="p-3 flex items-end gap-4">
        <div>
          <div className="text-4xl font-mono font-black text-app-text tabular-nums leading-none">
            {formatSpeed(packet.Speed, units.unit)}
          </div>
          <div className="text-xs text-app-text-muted mt-0.5">{units.speedLabel}</div>
        </div>
        <div className="text-5xl font-mono font-black text-app-text-secondary leading-none">{gear}</div>
      </div>
    </div>
  );
}

function DrsInline({ f1 }: { f1: F1ExtendedData }) {
  if (f1.drsActivated) return <span className="text-sm font-bold px-3 py-1 rounded bg-green-600 text-white">DRS OPEN</span>;
  if (f1.drsAllowed) return <span className="text-sm font-bold px-3 py-1 rounded bg-green-900 text-green-300">DRS READY</span>;
  return <span className="text-sm font-bold px-3 py-1 rounded bg-app-surface-alt text-app-text-dim">DRS</span>;
}

// ── Tire Temperature Diagram ─────────────────────────────────────────────────

function TireTempDiagram({ packet }: { packet: TelemetryPacket }) {
  const f1 = packet.f1;
  const compound = f1?.tyreCompound || "unknown";
  const compoundColors = COMPOUND_COLORS[compound] ?? COMPOUND_COLORS.unknown;
  const tires = [
    { label: "FL", temp: Math.round(fToC(packet.TireTempFL)), wear: packet.TireWearFL, brakeTemp: f1?.brakeTempFL ?? 0, pressure: f1?.tyrePressureFL ?? 0 },
    { label: "FR", temp: Math.round(fToC(packet.TireTempFR)), wear: packet.TireWearFR, brakeTemp: f1?.brakeTempFR ?? 0, pressure: f1?.tyrePressureFR ?? 0 },
    { label: "RL", temp: Math.round(fToC(packet.TireTempRL)), wear: packet.TireWearRL, brakeTemp: f1?.brakeTempRL ?? 0, pressure: f1?.tyrePressureRL ?? 0 },
    { label: "RR", temp: Math.round(fToC(packet.TireTempRR)), wear: packet.TireWearRR, brakeTemp: f1?.brakeTempRR ?? 0, pressure: f1?.tyrePressureRR ?? 0 },
  ];

  // F1 tire temp colors: blue < 80°C, green 85-105°C, orange 105-115°C, red > 115°C
  const tempColor = (t: number) => {
    if (t > 115) return "text-red-400";
    if (t > 105) return "text-orange-400";
    if (t < 80) return "text-blue-400";
    return "text-emerald-400";
  };

  const tempBg = (t: number) => {
    if (t > 115) return "bg-red-500";
    if (t > 105) return "bg-orange-400";
    if (t < 80) return "bg-blue-500";
    return "bg-emerald-500";
  };

  const brakeColor = (t: number) => {
    if (t > 800) return "text-red-400";
    if (t > 500) return "text-orange-400";
    if (t < 200) return "text-blue-400";
    return "text-app-text-secondary";
  };

  const health = (wear: number) => Math.max(0, (1 - wear) * 100);

  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Tyres</h2>
        <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${compoundColors.bg} ${compoundColors.text}`}>{compound}</span>
      </div>
      <div className="p-3 flex flex-col justify-center h-full">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {tires.map((t) => {
            const h = health(t.wear);
            const hColor = h > 60 ? "bg-emerald-400" : h > 30 ? "bg-yellow-400" : "bg-red-500";
            return (
              <div key={t.label} className="flex items-center gap-3">
                <div className={`w-4 h-12 rounded-sm ${tempBg(t.temp)}`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-xl font-mono font-bold tabular-nums leading-none ${tempColor(t.temp)}`}>
                    {t.temp}&deg;C
                  </div>
                  <div className="flex gap-3 mt-1 text-xl font-mono font-bold tabular-nums leading-none">
                    <span className={brakeColor(t.brakeTemp)}>B:{t.brakeTemp}&deg;</span>
                    <span className="text-app-text-muted">{t.pressure.toFixed(1)}psi</span>
                  </div>
                  <div className="h-1.5 bg-app-surface-alt rounded-full overflow-hidden mt-1">
                    <div className={`h-full rounded-full ${hColor}`} style={{ width: `${h}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Car Damage Section ──────────────────────────────────────────────────────

function CarDamageSection({ f1 }: { f1: F1ExtendedData }) {
  const parts = [
    { label: "FL Wing", value: f1.frontLeftWingDamage },
    { label: "FR Wing", value: f1.frontRightWingDamage },
    { label: "Rear Wing", value: f1.rearWingDamage },
    { label: "Floor", value: f1.floorDamage },
    { label: "Diffuser", value: f1.diffuserDamage },
    { label: "Sidepod", value: f1.sidepodDamage },
  ];

  const hasDamage = parts.some((p) => p.value > 0);
  const dmgColor = (v: number) => v === 0 ? "#22c55e" : v < 30 ? "#eab308" : v < 60 ? "#f97316" : "#ef4444";
  const dmgText = (v: number) => v === 0 ? "text-emerald-400" : v < 30 ? "text-yellow-400" : v < 60 ? "text-orange-400" : "text-red-400";

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Damage</h2>
        {!hasDamage && <span className="text-xs text-emerald-400">All Clear</span>}
      </div>
      <div className="p-3 flex items-center gap-4">
        {/* SVG top-down F1 car */}
        <svg viewBox="0 0 100 200" className="w-16 h-32 flex-shrink-0">
          {/* Body */}
          <path d="M40,30 L35,15 L40,5 L60,5 L65,15 L60,30 L62,50 L65,70 L65,140 L62,160 L60,175 L58,190 L42,190 L40,175 L38,160 L35,140 L35,70 L38,50 Z"
            fill="#1e293b" stroke="#475569" strokeWidth="1.5" />
          {/* Front wing */}
          <rect x="15" y="8" width="22" height="6" rx="1" fill={dmgColor(f1.frontLeftWingDamage)} opacity="0.8" />
          <rect x="63" y="8" width="22" height="6" rx="1" fill={dmgColor(f1.frontRightWingDamage)} opacity="0.8" />
          {/* Rear wing */}
          <rect x="30" y="185" width="40" height="6" rx="1" fill={dmgColor(f1.rearWingDamage)} opacity="0.8" />
          {/* Floor — underside of body */}
          <rect x="36" y="80" width="28" height="50" rx="2" fill={dmgColor(f1.floorDamage)} opacity="0.3" />
          {/* Diffuser */}
          <rect x="35" y="175" width="30" height="5" rx="1" fill={dmgColor(f1.diffuserDamage)} opacity="0.6" />
          {/* Sidepods */}
          <rect x="28" y="70" width="6" height="30" rx="2" fill={dmgColor(f1.sidepodDamage)} opacity="0.7" />
          <rect x="66" y="70" width="6" height="30" rx="2" fill={dmgColor(f1.sidepodDamage)} opacity="0.7" />
          {/* Front wheels */}
          <rect x="20" y="20" width="12" height="24" rx="3" fill="#334155" stroke="#475569" strokeWidth="1" />
          <rect x="68" y="20" width="12" height="24" rx="3" fill="#334155" stroke="#475569" strokeWidth="1" />
          {/* Rear wheels */}
          <rect x="18" y="140" width="14" height="28" rx="3" fill="#334155" stroke="#475569" strokeWidth="1" />
          <rect x="68" y="140" width="14" height="28" rx="3" fill="#334155" stroke="#475569" strokeWidth="1" />
          {/* Cockpit */}
          <ellipse cx="50" cy="65" rx="8" ry="12" fill="#0f172a" stroke="#475569" strokeWidth="1" />
          {/* Halo */}
          <path d="M44,58 Q50,50 56,58" fill="none" stroke="#64748b" strokeWidth="2" />
        </svg>

        {/* Damage values */}
        <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {parts.map((p) => (
            <div key={p.label} className="flex items-center justify-between">
              <span className="text-xs text-app-text-muted">{p.label}</span>
              <span className={`text-sm font-mono font-bold tabular-nums ${dmgText(p.value)}`}>
                {p.value === 0 ? "OK" : `${p.value}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Pit Estimate Section (Fuel + Tyres + Lap Estimates) ──────────────────────

function PitEstimateSection({ packet }: { packet: TelemetryPacket }) {
  const positions = ["FL", "FR", "RL", "RR"] as const;

  // Mutable tracking state (not for rendering) — last-seen values for delta calculation
  const trackingRef = useRef({
    lastTime: 0,
    lastFuel: packet.Fuel,
    lastWears: [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
    lastDist: packet.DistanceTraveled,
    lastLapDist: 0,
    estLapLength: 0,
  });
  // Derived rate values used for rendering — stored in state so renders update correctly
  const [rates, setRates] = useState({ fuelPerSec: 0, wearPerSec: [0, 0, 0, 0], avgSpeed: 0 });

  useEffect(() => {
    const t = trackingRef.current;
    const now = Date.now() / 1000;
    const dt = now - t.lastTime;
    if (dt < 3) return;

    const fuelDelta = t.lastFuel - packet.Fuel;
    const distDelta = packet.DistanceTraveled - t.lastDist;
    const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];

    setRates((prev) => {
      const next = { ...prev, wearPerSec: [...prev.wearPerSec] };
      if (fuelDelta > 0) next.fuelPerSec = fuelDelta / dt;
      for (let i = 0; i < 4; i++) {
        const d = wears[i] - t.lastWears[i];
        if (d > 0) next.wearPerSec[i] = d / dt;
      }
      if (distDelta > 0) next.avgSpeed = distDelta / dt;
      return next;
    });

    t.lastTime = now;
    t.lastFuel = packet.Fuel;
    t.lastWears = wears;
    t.lastDist = packet.DistanceTraveled;
  }, [packet]);

  // Estimate lap length from f1.totalLaps and total distance if possible
  // Or from a heuristic: ~5km per lap average F1 track
  const estLapTime = rates.avgSpeed > 1 ? 5000 / rates.avgSpeed : 0; // rough 5km estimate
  const canEstimate = rates.avgSpeed > 1;

  // Fuel estimate
  const fuelPct = packet.Fuel * 100;
  let fuelLaps: number | null = null;
  if (rates.fuelPerSec > 0 && canEstimate) {
    const fuelPerLap = rates.fuelPerSec * estLapTime;
    if (fuelPerLap > 0) fuelLaps = Math.round((packet.Fuel / fuelPerLap) * 10) / 10;
  }
  const fuelColor = fuelPct < 20 ? "text-red-400" : fuelPct < 40 ? "text-amber-400" : "text-emerald-400";

  // Per-tire estimates
  const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  const tireData = positions.map((pos, i) => {
    const wear = wears[i];
    const health = Math.max(0, (1 - wear) * 100);
    const tempKey = `TireTemp${pos}` as keyof TelemetryPacket;
    const tempC = Math.round(fToC(packet[tempKey] as number));

    let laps: number | null = null;
    if (rates.wearPerSec[i] > 0 && canEstimate) {
      const wearPerLap = rates.wearPerSec[i] * estLapTime;
      const remaining = 1 - wear;
      if (wearPerLap > 0) laps = Math.round((remaining / wearPerLap) * 10) / 10;
    }

    const tempColor = tempC > 105 ? "text-red-400" : tempC > 90 ? "text-orange-400" : tempC < 70 ? "text-blue-400" : "text-emerald-400";

    const healthColor = health > 60 ? "text-emerald-400" : health > 30 ? "text-yellow-400" : "text-red-400";
    const healthBg = health > 60 ? "bg-emerald-400" : health > 30 ? "bg-yellow-400" : "bg-red-500";

    return { pos, wear, health, tempC, tempColor, healthColor, healthBg, laps };
  });

  // Pit in estimate
  const worstTireLaps = tireData.reduce<number | null>((min, t) => {
    if (t.laps == null) return min;
    return min == null ? t.laps : Math.min(min, t.laps);
  }, null);
  const pitIn = fuelLaps != null && worstTireLaps != null
    ? Math.min(fuelLaps, worstTireLaps)
    : fuelLaps ?? worstTireLaps;
  const limitedBy = fuelLaps != null && worstTireLaps != null
    ? (fuelLaps <= worstTireLaps ? "fuel" : "tyres")
    : fuelLaps != null ? "fuel" : "tyres";
  const urgentColor = pitIn != null
    ? (pitIn <= 3 ? "text-red-400" : pitIn <= 6 ? "text-amber-400" : "text-emerald-400")
    : "text-app-text-muted";

  return (
    <div>
      <div className="p-2 border-b border-app-border">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Pit Window</h2>
      </div>
      <div className="p-3">
        {/* Pit in headline */}
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-app-text-secondary">
            {pitIn != null ? (
              <>Limited by <span className={`font-bold ${limitedBy === "fuel" ? fuelColor : urgentColor}`}>{limitedBy}</span></>
            ) : (
              <span className="text-app-text-dim">Estimating...</span>
            )}
          </div>
          <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>
            {pitIn != null ? (
              <>{pitIn.toFixed(1)} <span className="text-base font-bold">laps</span></>
            ) : (
              <span className="text-app-text-dim">— <span className="text-base font-bold">laps</span></span>
            )}
          </span>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 items-end mb-1 px-1">
          <div className="w-5" />
          <div />
          <div className="text-xs text-app-text-dim uppercase tracking-wider text-center w-14">Level</div>
          <div className="text-xs text-app-text-dim uppercase tracking-wider text-center w-16">Est. Laps</div>
        </div>

        {/* Fuel row */}
        <div className="bg-app-surface/50 rounded-md p-2.5 mb-2">
          <div className="text-xs text-app-text-muted uppercase tracking-wider mb-1.5">Fuel</div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center">
            <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${fuelPct < 20 ? "bg-red-500" : fuelPct < 40 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, fuelPct)}%` }} />
            </div>
            <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-14 ${fuelColor}`}>
              {fuelPct.toFixed(0)}%
            </div>
            <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-16 ${fuelLaps != null ? fuelColor : "text-app-text-dim"}`}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)}` : "—"}
            </div>
          </div>
        </div>

        {/* Per-tire rows */}
        <div className="space-y-1">
          {tireData.map((t) => (
            <div key={t.pos} className="grid grid-cols-[auto_auto_1fr_auto_auto] gap-x-3 items-center px-2.5 py-1.5">
              <div className="text-xs font-bold text-app-text-muted w-5">{t.pos}</div>
              <div className={`text-lg font-mono font-bold tabular-nums leading-tight w-12 text-center ${t.tempColor}`}>
                {t.tempC}&deg;
              </div>
              <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${t.healthBg}`} style={{ width: `${t.health}%` }} />
              </div>
              <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-14 ${t.healthColor}`}>
                {t.health.toFixed(0)}%
              </div>
              <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-16 ${t.laps != null ? t.healthColor : "text-app-text-dim"}`}>
                {t.laps != null ? `~${t.laps.toFixed(1)}` : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── ERS Section ──────────────────────────────────────────────────────────────

function ErsSection({ f1 }: { f1: F1ExtendedData }) {
  const pct = Math.min(100, (f1.ersStoreEnergy / ERS_MAX_ENERGY) * 100);
  const mode = DEPLOY_MODES[f1.ersDeployMode] ?? DEPLOY_MODES[0];
  const deployedPct = Math.min(100, (f1.ersDeployedThisLap / ERS_MAX_ENERGY) * 100);
  const harvestedPct = Math.min(100, (f1.ersHarvestedThisLap / ERS_MAX_ENERGY) * 100);

  let barColor = "bg-green-500";
  if (pct < 20) barColor = "bg-red-500";
  else if (pct < 50) barColor = "bg-yellow-500";

  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">ERS</h2>
        <span className={`text-xs font-bold ${mode.color}`}>{mode.label}</span>
      </div>
      <div className="p-3">
        <div className="h-3 bg-app-surface-alt rounded-full overflow-hidden mb-2">
          <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-xs text-app-text-muted font-mono tabular-nums">
          <span>Deploy: {deployedPct.toFixed(0)}%</span>
          <span className="text-app-text-secondary font-bold">{pct.toFixed(0)}%</span>
          <span>Harvest: {harvestedPct.toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
}

// ── Weather Section ──────────────────────────────────────────────────────────

const WEATHER_ICONS: Record<number, string> = {
  0: "☀️", 1: "⛅", 2: "☁️", 3: "🌧️", 4: "🌧️", 5: "⛈️",
};

function WeatherWidget({ f1 }: { f1: F1ExtendedData }) {
  const icon = WEATHER_ICONS[f1.weather] ?? "🌤️";
  const label = WEATHER_LABELS[f1.weather] ?? "Unknown";
  const hasRain = f1.rainPercentage > 0;

  return (
    <div className="flex items-center gap-3 p-3">
      <div className="text-3xl leading-none">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-app-text">{label}</div>
        {hasRain && (
          <div className="flex items-center gap-1 mt-0.5">
            <div className="h-1.5 flex-1 bg-app-surface-alt rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-blue-400" style={{ width: `${f1.rainPercentage}%` }} />
            </div>
            <span className="text-xl font-mono font-bold text-blue-400 tabular-nums leading-none">{f1.rainPercentage}%</span>
          </div>
        )}
      </div>
      <div className="flex gap-3">
        <div className="text-center">
          <div className="text-[10px] text-app-text-muted uppercase">Track</div>
          <div className="text-xl font-mono font-bold text-orange-400 tabular-nums leading-none">{f1.trackTemperature}&deg;</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-app-text-muted uppercase">Air</div>
          <div className="text-xl font-mono font-bold text-cyan-400 tabular-nums leading-none">{f1.airTemperature}&deg;</div>
        </div>
      </div>
    </div>
  );
}

// ── Sector Times ─────────────────────────────────────────────────────────────

function formatSectorTime(seconds: number): string {
  if (seconds <= 0) return "—";
  return seconds.toFixed(3);
}

function SectorTimesSection({ packet, f1 }: { packet: TelemetryPacket; f1: F1ExtendedData }) {
  const currentSector = f1.currentSector; // 0=S1, 1=S2, 2=S3
  const s1 = f1.sector1Time;
  const s2 = f1.sector2Time;
  // S3 can be inferred: if we have last lap time and s1+s2 from previous lap, but
  // for current lap, S3 = lastLapTime - s1_prev - s2_prev (not available here).
  // We can track best sectors over time
  const [bestSectors, setBestSectors] = useState({ s1: 0, s2: 0, s3: 0 });

  // Track best sectors
  useEffect(() => {
    setBestSectors((prev) => {
      const next = { ...prev };
      let changed = false;
      if (s1 > 0 && (prev.s1 === 0 || s1 < prev.s1)) { next.s1 = s1; changed = true; }
      if (s2 > 0 && (prev.s2 === 0 || s2 < prev.s2)) { next.s2 = s2; changed = true; }
      return changed ? next : prev;
    });
  }, [s1, s2]);

  const best = bestSectors;

  const sectorColor = (time: number, bestTime: number) => {
    if (time <= 0) return "text-app-text-muted";
    if (bestTime > 0 && time <= bestTime) return "text-purple-400";
    if (bestTime > 0 && time - bestTime < 0.3) return "text-emerald-400";
    if (bestTime > 0 && time - bestTime < 1.0) return "text-yellow-400";
    return "text-app-text";
  };

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Sectors</h2>
      </div>
      <div className="p-3">
        {/* S1 / S2 / S3 current lap */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          {[
            { label: "S1", time: s1, bestTime: best.s1, active: currentSector === 0 },
            { label: "S2", time: s2, bestTime: best.s2, active: currentSector === 1 },
            { label: "S3", time: 0, bestTime: best.s3, active: currentSector === 2 },
          ].map((s) => (
            <div key={s.label} className={`rounded p-2 text-center ${s.active ? "bg-app-accent/10 ring-1 ring-app-accent/30" : "bg-app-surface-alt"}`}>
              <div className={`text-xs uppercase tracking-wider mb-1 ${s.active ? "text-app-accent font-bold" : "text-app-text-muted"}`}>
                {s.label}
              </div>
              <div className={`text-2xl font-mono font-bold tabular-nums leading-none ${s.time > 0 ? sectorColor(s.time, s.bestTime) : "text-app-text-dim"}`}>
                {formatSectorTime(s.time)}
              </div>
              {s.bestTime > 0 && (
                <div className="text-sm text-purple-400/60 font-mono tabular-nums mt-1">
                  best {formatSectorTime(s.bestTime)}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Lap times row */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Current</div>
            <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none mt-1">
              {formatLapTime(packet.CurrentLap)}
            </div>
          </div>
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Last</div>
            <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none mt-1">
              {formatLapTime(packet.LastLap)}
            </div>
          </div>
          <div>
            <div className="text-xs text-app-text-muted uppercase tracking-wider">Best</div>
            <div className="text-xl font-mono font-bold text-purple-400 tabular-nums leading-none mt-1">
              {formatLapTime(packet.BestLap)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Shared hook: fetch laps + sectors from server ────────────────────────────

function useSessionLaps(trackOrdinal?: number) {
  const { data: allLaps = [] } = useLaps({ refetchInterval: 3_000 });
  const { data: sectorTimes } = useQuery({
    queryKey: ["track-lap-sectors", trackOrdinal],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: () => client.api.tracks[":ordinal"]["lap-sectors"].$get({ param: { ordinal: String(trackOrdinal!) }, query: {} }).then((r) => r.json() as any),
    enabled: trackOrdinal != null && trackOrdinal > 0,
    refetchInterval: 5_000,
  });

  const laps = trackOrdinal != null
    ? allLaps.filter((l) => l.trackOrdinal === trackOrdinal)
    : [];

  return { laps, sectorTimes };
}


// ── Recent Laps ──────────────────────────────────────────────────────────────

function RecentLaps() {
  const rawPacket = useTelemetryStore((s) => s.rawPacket);
  const navigate = useNavigate({ from: "/" });
  const gameRoute = useGameRoute();
  const { laps: serverLaps, sectorTimes } = useSessionLaps(rawPacket?.TrackOrdinal);
  const deleteLap = useDeleteLap();

  // Show laps from the current session only (most recent sessionId)
  const latestSessionId = serverLaps.length > 0
    ? Math.max(...serverLaps.map((l) => l.sessionId))
    : null;
  const sessionLaps = latestSessionId != null
    ? serverLaps.filter((l) => l.sessionId === latestSessionId)
    : serverLaps;

  const sorted = [...sessionLaps]
    .sort((a, b) => b.lapNumber - a.lapNumber)
    .slice(0, 15);

  const allTimes = sessionLaps.map(l => l.lapTime);
  const best = allTimes.length > 0 ? Math.min(...allTimes) : 0;

  // Collect best sectors
  const allS1: number[] = [], allS2: number[] = [], allS3: number[] = [];
  if (sectorTimes) {
    for (const s of Object.values(sectorTimes as Record<string, { s1: number; s2: number; s3: number }>)) {
      if (s.s1 > 0) allS1.push(s.s1);
      if (s.s2 > 0) allS2.push(s.s2);
      if (s.s3 > 0) allS3.push(s.s3);
    }
  }
  const bestS1 = allS1.length > 0 ? Math.min(...allS1) : 0;
  const bestS2 = allS2.length > 0 ? Math.min(...allS2) : 0;
  const bestS3 = allS3.length > 0 ? Math.min(...allS3) : 0;

  const sectorColor = (time: number, bestTime: number) => {
    if (time <= 0) return "text-app-text-dim";
    if (bestTime > 0 && time <= bestTime) return "text-purple-400";
    if (bestTime > 0 && time - bestTime < 0.3) return "text-emerald-400";
    if (bestTime > 0 && time - bestTime < 1.0) return "text-yellow-400";
    return "text-app-text-secondary";
  };

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Recent Laps</h2>
        {rawPacket?.f1?.sessionType && (
          <span className="text-xs font-bold text-app-accent uppercase">{rawPacket.f1.sessionType.replace(/-/g, " ")}</span>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="p-3 text-center text-xs text-app-text-dim">No completed laps yet</div>
      ) : (
        <>
          <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto_auto] gap-x-2 px-3 py-1 text-xs text-app-text-dim uppercase tracking-wider border-b border-app-border/50">
            <div className="w-10">Lap</div>
            <div className="text-right">S1</div>
            <div className="text-right">S2</div>
            <div className="text-right">S3</div>
            <div className="text-right">Time</div>
            <div className="text-right w-14">Delta</div>
            <div className="w-16"></div>
          </div>
          <div className="divide-y divide-app-border/30">
            {sorted.map((l) => {
              const sectors = sectorTimes?.[l.id];
              const s1 = sectors?.s1 ?? 0;
              const s2 = sectors?.s2 ?? 0;
              const s3 = sectors?.s3 ?? 0;
              const delta = l.lapTime - best;
              const isBest = delta === 0;
              const timeColor = isBest ? "text-purple-400" : delta < 0.5 ? "text-emerald-400" : delta < 1.5 ? "text-app-text" : "text-red-400";
              return (
                <div key={l.id} className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto_auto] gap-x-2 px-3 py-1.5 items-center">
                  <span className="text-xs text-app-text-muted font-mono w-10">{l.lapNumber}</span>
                  <span className={`text-sm font-mono tabular-nums text-right ${sectorColor(s1, bestS1)}`}>
                    {s1 > 0 ? s1.toFixed(3) : "—"}
                  </span>
                  <span className={`text-sm font-mono tabular-nums text-right ${sectorColor(s2, bestS2)}`}>
                    {s2 > 0 ? s2.toFixed(3) : "—"}
                  </span>
                  <span className={`text-sm font-mono tabular-nums text-right ${sectorColor(s3, bestS3)}`}>
                    {s3 > 0 ? s3.toFixed(3) : "—"}
                  </span>
                  <span className={`text-base font-mono font-bold tabular-nums text-right ${timeColor}`}>
                    {formatLapTime(l.lapTime)}
                  </span>
                  <span className="text-xs text-app-text-dim font-mono tabular-nums text-right w-14">
                    {isBest ? "PB" : `+${delta.toFixed(3)}`}
                  </span>
                  <div className="flex items-center gap-1 w-16 justify-end">
                    <button
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      onClick={() => navigate({ to: `${gameRoute}/analyse` as any, search: { track: l.trackOrdinal, car: l.carOrdinal, lap: l.id } as any })}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-purple-600 hover:bg-purple-500 text-white"
                    >
                      Analyse
                    </button>
                    <button
                      onClick={() => deleteLap.mutate(l.id)}
                      className="px-1 py-0.5 text-[10px] rounded bg-slate-700 hover:bg-red-600 text-app-text"
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Grid Section (focused: leader + nearby drivers) ──────────────────────────

function GridSection({ f1, playerPosition }: { f1: F1ExtendedData; playerPosition: number }) {
  const sorted = [...f1.grid].sort((a, b) => a.position - b.position);
  const [expanded, setExpanded] = useState(false);

  // Show leader + 2 ahead + player + 2 behind
  const focused = (() => {
    if (expanded || sorted.length <= 7) return sorted;

    const indices = new Set<number>();
    // Always show P1
    indices.add(0);
    // Show 2 ahead, player, 2 behind
    const playerIdx = sorted.findIndex(e => e.position === playerPosition);
    if (playerIdx >= 0) {
      for (let i = Math.max(0, playerIdx - 2); i <= Math.min(sorted.length - 1, playerIdx + 2); i++) {
        indices.add(i);
      }
    }

    const result: Array<typeof sorted[0] | { separator: true; position: number }> = [];
    let lastIdx = -1;
    for (const idx of [...indices].sort((a, b) => a - b)) {
      if (lastIdx >= 0 && idx - lastIdx > 1) {
        result.push({ separator: true, position: -idx } as any);
      }
      result.push(sorted[idx]);
      lastIdx = idx;
    }
    if (lastIdx < sorted.length - 1) {
      result.push({ separator: true, position: -999 } as any);
    }
    return result;
  })();

  return (
    <div className="flex flex-col flex-1">
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-app-text-muted uppercase tracking-wider">Live Standings</h2>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-app-accent hover:text-app-accent/80 font-semibold"
        >
          {expanded ? "Focus" : "Show All"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-app-surface">
            <tr className="text-app-text-muted border-b border-app-border">
              <th className="px-2 py-1.5 text-left w-8 font-semibold">P</th>
              <th className="px-2 py-1.5 text-left font-semibold">Driver</th>
              <th className="px-2 py-1.5 text-right font-semibold">S1</th>
              <th className="px-2 py-1.5 text-right font-semibold">S2</th>
              <th className="px-2 py-1.5 text-right font-semibold">S3</th>
              <th className="px-2 py-1.5 text-right font-semibold">Gap</th>
              <th className="px-2 py-1.5 text-right font-semibold">Ahead</th>
              <th className="px-2 py-1.5 text-center w-6 font-semibold">T</th>
              <th className="px-2 py-1.5 text-right w-8 font-semibold">Age</th>
              <th className="px-2 py-1.5 text-center w-8 font-semibold">Pit</th>
            </tr>
          </thead>
          <tbody>
            {focused.map((entry: any) => {
              if (entry.separator) {
                return (
                  <tr key={`sep-${entry.position}`}>
                    <td colSpan={10} className="text-center text-xs text-app-text-dim py-0.5">···</td>
                  </tr>
                );
              }
              const isPlayer = entry.position === playerPosition;
              const dotColor = COMPOUND_DOT[entry.tyreCompound] ?? COMPOUND_DOT.unknown;
              return (
                <tr
                  key={entry.position}
                  className={`border-b border-app-border/50 ${
                    isPlayer ? "bg-app-accent/10" : "hover:bg-app-surface-alt/50"
                  }`}
                >
                  <td className="px-2 py-1.5 font-bold text-app-text tabular-nums">{entry.position}</td>
                  <td className={`px-2 py-1.5 truncate max-w-[140px] ${isPlayer ? "text-app-accent font-semibold" : "text-app-text-secondary"}`}>
                    {entry.name || `Car ${entry.position}`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-app-text-secondary">
                    {entry.lastS1 > 0 ? entry.lastS1.toFixed(3) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-app-text-secondary">
                    {entry.lastS2 > 0 ? entry.lastS2.toFixed(3) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-app-text-secondary">
                    {entry.lastS3 > 0 ? entry.lastS3.toFixed(3) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right text-app-text-muted tabular-nums font-mono">
                    {entry.position === 1 ? "LEADER" : formatGap(entry.gapToLeader)}
                  </td>
                  <td className="px-2 py-1.5 text-right text-app-text-muted tabular-nums font-mono">
                    {formatGap(entry.gapToCarAhead)}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor}`} />
                  </td>
                  <td className="px-2 py-1.5 text-right text-app-text-muted tabular-nums font-mono">{entry.tyreAge}</td>
                  <td className="px-2 py-1.5 text-center text-app-text-muted">
                    {entry.pitStatus === 1 ? (
                      <span className="text-yellow-400 font-bold">IN</span>
                    ) : entry.pitStatus === 2 ? (
                      <span className="text-yellow-400">PIT</span>
                    ) : entry.numPitStops > 0 ? (
                      entry.numPitStops
                    ) : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useTelemetryStore } from "../../stores/telemetry";
import type { F1ExtendedData } from "@shared/types";
import { tryGetGame } from "@shared/games/registry";
import { TireGrid } from "../telemetry/TireGrid";
import { LapTimeChart } from "../LapTimeChart";
import { PitEstimate } from "../telemetry/PitEstimate";
import { RecordedLaps } from "../RecordedLaps";
import { NoDataView } from "../NoDataView";
import { RaceInfo } from "../RaceInfo";
import { useTrackName, useCarName } from "../../hooks/queries";

// ── Helpers ──────────────────────────────────────────────────────────────────


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
  unknown: { bg: "", text: "text-app-text-muted" },
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
  const packet = useTelemetryStore((s) => s.packet);
  const hasF1Data = rawPacket?.gameId === "f1-2025" && rawPacket.f1;
  const f1 = hasF1Data ? rawPacket.f1! : null;
  const { data: trackName } = useTrackName(rawPacket?.TrackOrdinal);
  const { data: carName } = useCarName(rawPacket?.CarOrdinal);

  if (!f1) {
    return (
      <div className="flex-1 flex flex-col">
        <NoDataView />
      </div>
    );
  }

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      {/* Left column: Core telemetry + pit info */}
      <div className="border-r border-app-border overflow-auto">
        {/* Weather | Electronics side-by-side */}
        <div className="border-b border-app-border grid grid-cols-2">
          <div className="border-r border-app-border">
            <div className="h-8 px-2 border-b border-app-border flex items-center">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Weather</h2>
            </div>
            <WeatherWidget f1={f1} />
          </div>
          <div>
            <ErsSection f1={f1} />
          </div>
        </div>
        {/* Damage | Tyres */}
        <div className="border-b border-app-border grid grid-cols-2">
          <div className="border-r border-app-border">
            <CarDamageSection f1={f1} />
          </div>
          <div>
            <TireGrid
              fl={{ tempC: Math.round(fToC(rawPacket!.TireTempFL)), wear: rawPacket!.TireWearFL, brakeTemp: rawPacket!.f1?.brakeTempFL ?? 0, pressure: rawPacket!.f1?.tyrePressureFL ?? 0 }}
              fr={{ tempC: Math.round(fToC(rawPacket!.TireTempFR)), wear: rawPacket!.TireWearFR, brakeTemp: rawPacket!.f1?.brakeTempFR ?? 0, pressure: rawPacket!.f1?.tyrePressureFR ?? 0 }}
              rl={{ tempC: Math.round(fToC(rawPacket!.TireTempRL)), wear: rawPacket!.TireWearRL, brakeTemp: rawPacket!.f1?.brakeTempRL ?? 0, pressure: rawPacket!.f1?.tyrePressureRL ?? 0 }}
              rr={{ tempC: Math.round(fToC(rawPacket!.TireTempRR)), wear: rawPacket!.TireWearRR, brakeTemp: rawPacket!.f1?.brakeTempRR ?? 0, pressure: rawPacket!.f1?.tyrePressureRR ?? 0 }}
              healthThresholds={tryGetGame("f1-2025")?.tireHealthThresholds ?? { green: 0.70, yellow: 0.50 }}
              tempThresholds={{ blue: 80, orange: 105, red: 115 }}
              compound={rawPacket!.f1?.tyreCompound ?? "unknown"}
              compoundStyle={COMPOUND_COLORS[rawPacket!.f1?.tyreCompound ?? "unknown"] ?? COMPOUND_COLORS.unknown}
            />
          </div>
        </div>
        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="h-8 px-2 border-b border-app-border flex items-center">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Pit Window</h2>
          </div>
          <div className="p-3">
            <PitEstimate packet={rawPacket!} />
          </div>
        </div>
        <GridSection f1={f1} playerPosition={rawPacket!.RacePosition} />
      </div>

      {/* Right column: Race info + Charts + Recorded Laps */}
      <div className="overflow-y-auto overflow-x-hidden flex flex-col">
        <RaceInfo packet={packet!} trackName={trackName} carName={carName} totalLaps={f1.totalLaps} sessionType={f1.sessionType} showTrackMap={false} showSectors={true} />
        <LapTimeChart packet={rawPacket!} />
        <div className="flex-1">
          <RecordedLaps />
        </div>
      </div>
    </div>
  );
}

// ── DRS Indicator ────────────────────────────────────────────────────────────

function DrsIndicator({ f1 }: { f1: F1ExtendedData }) {
  let bg = "bg-zinc-700";
  let text = "text-app-text-muted";
  let label = "DRS";

  if (f1.drsActivated) {
    bg = "bg-green-600";
    text = "text-white";
    label = "DRS OPEN";
  } else if (f1.drsAllowed) {
    bg = "bg-green-900";
    text = "text-green-300";
    label = "DRS READY";
  }

  return (
    <div className="flex justify-center">
      <span className={`text-sm font-bold px-3 py-1 rounded ${bg} ${text}`}>{label}</span>
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
      <div className="h-8 px-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Damage</h2>
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

// ── ERS Section ──────────────────────────────────────────────────────────────

function ErsSection({ f1 }: { f1: F1ExtendedData }) {
  const pct = Math.min(100, (f1.ersStoreEnergy / ERS_MAX_ENERGY) * 100);
  const mode = DEPLOY_MODES[f1.ersDeployMode] ?? DEPLOY_MODES[0];
  const deployedPct = Math.min(100, (f1.ersDeployedThisLap / ERS_MAX_ENERGY) * 100);
  const harvestedPct = Math.min(100, (f1.ersHarvestedThisLap / ERS_MAX_ENERGY) * 100);

  let barColor = "bg-green-500";
  let barTextColor = "text-green-500";
  if (pct < 20) { barColor = "bg-red-500"; barTextColor = "text-red-500"; }
  else if (pct < 50) { barColor = "bg-yellow-500"; barTextColor = "text-yellow-500"; }

  return (
    <div>
      <div className="h-8 px-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-[10px] font-semibold text-app-text-muted uppercase tracking-wider">Electronics</h2>
      </div>
      <div className="p-3 space-y-2">
        <DrsIndicator f1={f1} />
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className="text-[10px] text-app-text-muted uppercase tracking-wider">ERS</span>
          <div className="flex items-center gap-1.5">
            <span className={`text-sm font-bold px-2 py-0.5 rounded bg-zinc-700 tabular-nums ${barTextColor}`}>{pct.toFixed(0)}%</span>
            <span className={`text-sm font-bold px-2 py-0.5 rounded bg-zinc-700 ${mode.color}`}>{mode.label}</span>
          </div>
        </div>
        <div className="h-2 rounded-full overflow-hidden">
          <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-app-text-muted font-mono tabular-nums">
          <span>↓ {deployedPct.toFixed(0)}%</span>
          <span>↑ {harvestedPct.toFixed(0)}%</span>
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
    <div className="h-full flex flex-col justify-center gap-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="text-3xl leading-none">{icon}</div>
        <div className="text-sm font-bold text-app-text">{label}</div>
      </div>
      {hasRain && (
        <div className="flex items-center gap-1">
          <div className="h-1.5 flex-1 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-blue-400" style={{ width: `${f1.rainPercentage}%` }} />
          </div>
          <span className="text-xs font-mono font-bold text-blue-400 tabular-nums leading-none">{f1.rainPercentage}%</span>
        </div>
      )}
      <div className="flex gap-3">
        <div>
          <div className="text-[9px] text-app-text-muted uppercase">Track</div>
          <div className="text-base font-mono font-bold text-orange-400 tabular-nums leading-none">{f1.trackTemperature}&deg;</div>
        </div>
        <div>
          <div className="text-[9px] text-app-text-muted uppercase">Air</div>
          <div className="text-base font-mono font-bold text-cyan-400 tabular-nums leading-none">{f1.airTemperature}&deg;</div>
        </div>
      </div>
    </div>
  );
}

// ── Sector Times ─────────────────────────────────────────────────────────────


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

    type SeparatorEntry = { separator: true; position: number };
    type GridEntry = typeof sorted[0] | SeparatorEntry;
    const result: GridEntry[] = [];
    let lastIdx = -1;
    for (const idx of [...indices].sort((a, b) => a - b)) {
      if (lastIdx >= 0 && idx - lastIdx > 1) {
        result.push({ separator: true, position: -idx });
      }
      result.push(sorted[idx]);
      lastIdx = idx;
    }
    if (lastIdx < sorted.length - 1) {
      result.push({ separator: true, position: -999 });
    }
    return result;
  })();

  return (
    <div className="flex flex-col flex-1">
      <div className="h-8 px-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Live Standings</h2>
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
            {focused.map((entry) => {
              if ("separator" in entry) {
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
                    isPlayer ? "bg-app-accent/10" : ""
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

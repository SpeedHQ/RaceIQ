import { Cloud, CloudLightning, CloudRain, CloudSun, Sun } from "lucide-react";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/AppTable";
import { severityColor, severityRangeColor } from "@/lib/colors";
import { m } from "@/paraglide/messages";
import type { LiveF1Extension, LiveTelemetryView } from "../../lib/live-telemetry-view";
import { useCarName } from "../../hooks/catalog-queries";
import { useTrackName } from "../../hooks/track-queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { LapTimeChart } from "../LapTimeChart";
import { NoDataView } from "../NoDataView";
import { RaceInfo } from "../RaceInfo";
import { RecordedLaps } from "../RecordedLaps";
import { PitEstimate } from "../telemetry/PitEstimate";
import { TireGrid } from "../telemetry/TireGrid";
import { Button } from "../ui/button";

// ── Helpers ──────────────────────────────────────────────────────────────────



const WEATHER_LABELS: Record<number, string> = {
  0: m.f1live_weather_clear(),
  1: m.f1live_weather_light_cloud(),
  2: m.f1live_weather_overcast(),
  3: m.f1live_weather_light_rain(),
  4: m.f1live_weather_heavy_rain(),
  5: m.f1live_weather_storm(),
};

const ERS_MAX_ENERGY = 4_000_000;

const DEPLOY_MODES: Record<number, { label: string; color: string }> = {
  0: { label: m.f1live_ers_mode_none(), color: "var(--telemetry-ers-mode-none)" },
  1: { label: m.f1live_ers_mode_medium(), color: "var(--telemetry-ers-mode-medium)" },
  2: { label: m.f1live_ers_mode_hotlap(), color: "var(--telemetry-ers-mode-hotlap)" },
  3: { label: m.f1live_ers_mode_overtake(), color: "var(--telemetry-ers-mode-overtake)" },
};

function formatGap(gap: number): string {
  if (gap === 0) return "-";
  return gap > 0 ? `+${gap.toFixed(1)}` : `-${Math.abs(gap).toFixed(1)}`;
}

// ── Main Dashboard ───────────────────────────────────────────────────────────

export function F1LiveDashboard() {
  const view = useTelemetryStore((s) => s.telemetryView);
  const sectors = useTelemetryStore((s) => s.sectors);
  const pit = useTelemetryStore((s) => s.pit);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const f1 = (view?.simulator === "f1-2025" ? view.f1 : undefined) as Required<LiveF1Extension> | undefined;
  const { data: trackName } = useTrackName(view?.identity.trackOrdinal);
  const { data: carName } = useCarName(view?.identity.carOrdinal);

  if (!view || !f1) {
    return <div className="flex-1 flex flex-col"><NoDataView /></div>;
  }

  return (
    <div data-live-dashboard-layout className="grid h-auto flex-1 grid-cols-1 gap-0 @5xl/workspace:h-full @5xl/workspace:grid-cols-2">
      {/* Left column: Core telemetry + pit info */}
      <div className="border-r border-app-border overflow-auto">
        {/* Weather | Electronics side-by-side */}
        <div className="border-b border-app-border grid grid-cols-2">
          <div className="border-r border-app-border">
            <div className="h-8 px-2 border-b border-app-border flex items-center">
              <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.f1live_section_weather()}</h2>
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
              fl={{ tempC: Math.round(view.tires.temperatureC?.fl ?? 0), wear: view.tires.wear?.fl ?? 0, brakeTemp: view.tires.brakeTemperatureC?.fl ?? 0, pressure: view.tires.pressurePsi?.fl ?? 0 }}
              fr={{ tempC: Math.round(view.tires.temperatureC?.fr ?? 0), wear: view.tires.wear?.fr ?? 0, brakeTemp: view.tires.brakeTemperatureC?.fr ?? 0, pressure: view.tires.pressurePsi?.fr ?? 0 }}
              rl={{ tempC: Math.round(view.tires.temperatureC?.rl ?? 0), wear: view.tires.wear?.rl ?? 0, brakeTemp: view.tires.brakeTemperatureC?.rl ?? 0, pressure: view.tires.pressurePsi?.rl ?? 0 }}
              rr={{ tempC: Math.round(view.tires.temperatureC?.rr ?? 0), wear: view.tires.wear?.rr ?? 0, brakeTemp: view.tires.brakeTemperatureC?.rr ?? 0, pressure: view.tires.pressurePsi?.rr ?? 0 }}
              healthThresholds={{ green: 0.7, yellow: 0.5 }}
              tempThresholds={{ blue: 80, orange: 105, red: 115 }}
              compound={typeof view.tires.compound === "string" ? view.tires.compound : "unknown"}
            />
          </div>
          <div className="p-3">
            <PitEstimate view={view} pit={pit} />
          </div>
        </div>
        <GridSection competitors={view.competitors} playerPosition={view.timing.racePosition ?? 0} />
      </div>
      {/* Right column: Race info + Charts + Recorded Laps */}
      <div data-live-dashboard-race className="overflow-y-auto overflow-x-hidden flex flex-col">
        <RaceInfo view={view} sectors={sectors} trackName={trackName} carName={carName} totalLaps={typeof f1.totalLaps === "number" ? f1.totalLaps : undefined} sessionType={typeof f1.sessionType === "string" ? f1.sessionType : undefined} showTrackMap={false} showSectors={true} />
        <div className="shrink-0 h-[240px]">
          <LapTimeChart sessionLaps={sessionLaps} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <RecordedLaps laps={sessionLaps} />
        </div>
      </div>
    </div>
  );
}

// ── DRS Indicator ────────────────────────────────────────────────────────────

function DrsIndicator({ f1 }: { f1: Required<LiveF1Extension> }) {
  let stateClasses = "bg-app-surface-alt text-app-text-muted";
  let label = m.f1live_drs_closed();

  if (f1.drsActivated) {
    stateClasses = "bg-(--telemetry-drs) text-app-on-filled";
    label = m.f1live_drs_open();
  } else if (f1.drsAllowed) {
    stateClasses = "bg-(--telemetry-drs)/20 text-(--telemetry-drs)";
    label = m.f1live_drs_ready();
  }

  return (
    <div className="flex justify-center">
      <span className={`text-sm font-bold px-3 py-1 rounded ${stateClasses}`}>{label}</span>
    </div>
  );
}

// ── Car Damage Section ──────────────────────────────────────────────────────

function CarDamageSection({ f1 }: { f1: Required<LiveF1Extension> }) {
  const parts = [
    { label: m.f1live_damage_fl_wing(), value: f1.frontLeftWingDamage },
    { label: m.f1live_damage_fr_wing(), value: f1.frontRightWingDamage },
    { label: m.f1live_damage_rear_wing(), value: f1.rearWingDamage },
    { label: m.f1live_damage_floor(), value: f1.floorDamage },
    { label: m.f1live_damage_diffuser(), value: f1.diffuserDamage },
    { label: m.f1live_damage_sidepod(), value: f1.sidepodDamage },
  ];

  const hasDamage = parts.some((p) => p.value > 0);
  const dmgColor = (value: number) => severityRangeColor(value, [1, 30, 60]);

  return (
    <div className="border-b border-app-border">
      <div className="h-8 px-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.f1live_section_damage()}</h2>
        {!hasDamage && <span className="text-xs text-status-success">{m.f1live_damage_all_clear()}</span>}
      </div>
      <div className="p-3 flex items-center gap-4">
        {/* SVG top-down F1 car */}
        <svg viewBox="0 0 100 200" className="w-16 h-32 flex-shrink-0">
          {/* Body */}
          <path
            d="M40,30 L35,15 L40,5 L60,5 L65,15 L60,30 L62,50 L65,70 L65,140 L62,160 L60,175 L58,190 L42,190 L40,175 L38,160 L35,140 L35,70 L38,50 Z"
            fill="var(--app-surface-alt)"
            stroke="var(--app-border)"
            strokeWidth="1.5"
          />
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
          <rect x="20" y="20" width="12" height="24" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          <rect x="68" y="20" width="12" height="24" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          {/* Rear wheels */}
          <rect x="18" y="140" width="14" height="28" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          <rect x="68" y="140" width="14" height="28" rx="3" fill="var(--app-surface)" stroke="var(--app-border)" strokeWidth="1" />
          {/* Cockpit */}
          <ellipse cx="50" cy="65" rx="8" ry="12" fill="var(--app-bg)" stroke="var(--app-border)" strokeWidth="1" />
          {/* Halo */}
          <path d="M44,58 Q50,50 56,58" fill="none" stroke="var(--app-text-dim)" strokeWidth="2" />
        </svg>

        {/* Damage values */}
        <div className="flex-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {parts.map((p) => (
            <div key={p.label} className="flex items-center justify-between">
              <span className="text-xs text-app-text-muted">{p.label}</span>
              <span className="text-sm font-mono font-bold tabular-nums" style={{ color: dmgColor(p.value) }}>
                {p.value === 0 ? m.f1live_damage_ok() : `${p.value}%`}
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

function ErsSection({ f1 }: { f1: Required<LiveF1Extension> }) {
  const pct = Math.min(100, (f1.ersStoreEnergy / ERS_MAX_ENERGY) * 100);
  const mode = DEPLOY_MODES[f1.ersDeployMode] ?? DEPLOY_MODES[0];
  const deployedPct = Math.min(100, (f1.ersDeployedThisLap / ERS_MAX_ENERGY) * 100);
  const harvestedPct = Math.min(100, (f1.ersHarvestedThisLap / ERS_MAX_ENERGY) * 100);

  const chargeColor = severityColor(pct < 20 ? 3 : pct < 50 ? 1 : 0);

  return (
    <div>
      <div className="h-8 px-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-app-caption font-semibold text-app-text-muted uppercase tracking-wider">{m.f1live_section_electronics()}</h2>
      </div>
      <div className="p-3 space-y-2">
        <DrsIndicator f1={f1} />
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.f1live_ers_label()}</span>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold px-2 py-0.5 rounded bg-app-surface-alt tabular-nums" style={{ color: chargeColor }}>
              {pct.toFixed(0)}%
            </span>
            <span className="text-sm font-bold px-2 py-0.5 rounded bg-app-surface-alt" style={{ color: mode.color }}>
              {mode.label}
            </span>
          </div>
        </div>
        <div className="h-2 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ backgroundColor: chargeColor, width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-app-caption text-app-text-muted font-mono tabular-nums">
          <span>↓ {deployedPct.toFixed(0)}%</span>
          <span>↑ {harvestedPct.toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
}

// ── Weather Section ──────────────────────────────────────────────────────────

function WeatherIcon({ weather }: { weather: number }) {
  const iconProps = { "aria-hidden": true, className: "size-8 shrink-0", strokeWidth: 2 } as const;
  switch (weather) {
    case 0:
      return <Sun {...iconProps} className={`${iconProps.className} text-(--metric-track-temperature)`} />;
    case 1:
      return <CloudSun {...iconProps} className={`${iconProps.className} text-(--metric-track-temperature)`} />;
    case 2:
      return <Cloud {...iconProps} className={`${iconProps.className} text-app-text-secondary`} />;
    case 3:
    case 4:
      return <CloudRain {...iconProps} className={`${iconProps.className} text-(--metric-rain)`} />;
    case 5:
      return <CloudLightning {...iconProps} className={`${iconProps.className} text-(--severity-caution)`} />;
    default:
      return <CloudSun {...iconProps} className={`${iconProps.className} text-app-text-secondary`} />;
  }
}

function WeatherWidget({ f1 }: { f1: Required<LiveF1Extension> }) {
  const label = WEATHER_LABELS[f1.weather] ?? "Unknown";
  const hasRain = f1.rainPercentage > 0;

  return (
    <div className="h-full flex flex-col justify-center gap-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <WeatherIcon weather={f1.weather} />
        <div className="text-sm font-bold text-app-text">{label}</div>
      </div>
      {hasRain && (
        <div className="flex items-center gap-1">
          <div className="h-1.5 flex-1 rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ backgroundColor: "var(--metric-rain)", width: `${f1.rainPercentage}%` }} />
          </div>
          <span className="text-xs font-mono font-bold tabular-nums leading-none" style={{ color: "var(--metric-rain)" }}>
            {f1.rainPercentage}%
          </span>
        </div>
      )}
      <div className="flex gap-3">
        <div>
          <div className="text-app-micro text-app-text-muted uppercase">{m.label_track()}</div>
          <div className="text-base font-mono font-bold tabular-nums leading-none" style={{ color: "var(--metric-track-temperature)" }}>
            {f1.trackTemperature}&deg;
          </div>
        </div>
        <div>
          <div className="text-app-micro text-app-text-muted uppercase">{m.f1live_weather_air()}</div>
          <div className="text-base font-mono font-bold tabular-nums leading-none" style={{ color: "var(--metric-air-temperature)" }}>
            {f1.airTemperature}&deg;
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sector Times ─────────────────────────────────────────────────────────────

// ── Grid Section (focused: leader + nearby drivers) ──────────────────────────

function GridSection({ competitors, playerPosition }: { competitors: LiveTelemetryView["competitors"]; playerPosition: number }) {
  const sorted = [...competitors].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const [expanded, setExpanded] = useState(false);

  // Show leader + 2 ahead + player + 2 behind
  const focused = (() => {
    if (expanded || sorted.length <= 7) return sorted;

    const indices = new Set<number>();
    // Always show P1
    indices.add(0);
    // Show 2 ahead, player, 2 behind
    const playerIdx = sorted.findIndex((e) => e.position === playerPosition);
    if (playerIdx >= 0) {
      for (let i = Math.max(0, playerIdx - 2); i <= Math.min(sorted.length - 1, playerIdx + 2); i++) {
        indices.add(i);
      }
    }

    type SeparatorEntry = { separator: true; position: number };
    type GridEntry = (typeof sorted)[0] | SeparatorEntry;
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
        <h2 className="text-app-label font-semibold text-app-text-muted uppercase tracking-wider">{m.f1live_section_standings()}</h2>
        <Button type="button" onClick={() => setExpanded(!expanded)} className="text-app-label text-app-accent hover:text-app-accent/80 font-semibold">
          {expanded ? m.f1live_standings_focus() : m.f1live_standings_show_all()}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Table density="compact" fit variant="embedded">
          <TableHeader>
            <TableHead>{m.f1grid_header_position()}</TableHead>
            <TableHead>{m.f1grid_header_driver()}</TableHead>
            <TableHead align="end">{m.f1grid_header_s1()}</TableHead>
            <TableHead align="end">{m.f1grid_header_s2()}</TableHead>
            <TableHead align="end">{m.f1grid_header_s3()}</TableHead>
            <TableHead align="end">{m.label_delta()}</TableHead>
            <TableHead align="end">{m.f1grid_header_ahead()}</TableHead>
            <TableHead align="center">{m.label_tires()}</TableHead>
            <TableHead align="end">{m.f1grid_header_age()}</TableHead>
            <TableHead align="center">{m.f1grid_header_pit()}</TableHead>
          </TableHeader>
          <TableBody>
            {focused.map((entry) => {
              if ("separator" in entry) {
                return (
                  <TableRow key={`sep-${entry.position}`} variant="separator">
                    <TableCell align="center" colSpan={10} tone="dim">
                      {m.f1grid_separator()}
                    </TableCell>
                  </TableRow>
                );
              }
              const isPlayer = entry.position === playerPosition;
              return (
                <TableRow key={entry.position} selected={isPlayer}>
                  <TableCell emphasis numeric tone="primary">
                    {entry.position}
                  </TableCell>
                  <TableCell emphasis={isPlayer} tone={isPlayer ? "accent" : "default"} truncate="narrow">
                    {entry.name || `${m.label_car()} ${entry.position}`}
                  </TableCell>
                  <TableCell align="end" numeric>
                    {entry.lastS1S && entry.lastS1S > 0 ? entry.lastS1S.toFixed(3) : "—"}
                  </TableCell>
                  <TableCell align="end" numeric>
                    {entry.lastS2S && entry.lastS2S > 0 ? entry.lastS2S.toFixed(3) : "—"}
                  </TableCell>
                  <TableCell align="end" numeric>
                    {entry.lastS3S && entry.lastS3S > 0 ? entry.lastS3S.toFixed(3) : "—"}
                  </TableCell>
                  <TableCell align="end" numeric tone="muted">
                    {entry.position === 1 ? m.f1grid_leader() : formatGap(entry.gapToLeaderS ?? 0)}
                  </TableCell>
                  <TableCell align="end" numeric tone="muted">
                    {formatGap(entry.gapToAheadS ?? 0)}
                  </TableCell>
                  <TableCell align="center">
                    <span className="tire-compound-dot inline-block w-2.5 h-2.5 rounded-full" data-tire-compound={String(entry.tireCompound ?? "unknown").toLowerCase()} />
                  </TableCell>
                  <TableCell align="end" numeric tone="muted">
                    {entry.tireAge ?? 0}
                  </TableCell>
                  <TableCell align="center" tone="muted">
                    {entry.pitStatus === "pitting" ? (
                      <span className="text-status-warning font-bold">IN</span>
                    ) : entry.pitStatus === "in-pit-area" ? (
                      <span className="text-status-warning">PIT</span>
                    ) : (entry.pitStops ?? 0) > 0 ? (
                      entry.pitStops
                    ) : (
                      ""
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

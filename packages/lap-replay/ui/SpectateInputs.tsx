import { useMessages } from "./host"
import { useMemo, useSyncExternalStore } from "react";
import { getTelemetryVariable } from "@raceiq/shared/telemetry/catalog/query";
import { controlInputPercent } from "@raceiq/scene-3d/vehicle-dynamics";
import { useUnits } from "./host"
import type { SpectateController, ReplaySession, SpectateReading } from "../contracts/spectate";
import { channelValue, type SpectateChannel } from "./spectate-channels";
import { getGame } from "@raceiq/shared/games/registry";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { resolveBalance } from "@raceiq/analysis-core/racing/analysis/metric-values";
import { balanceColor } from "@raceiq/scene-3d/vehicle-dynamics";
import { ERS_DEPLOY_MODES, readERSDeployMode } from "./spectate-ers-mode";

function number(reading: SpectateReading | null, key: string): number | null {
  const value = reading?.values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function display(value: number | null, digits = 0) {
  return value === null ? "—" : value.toFixed(digits);
}
function Pedal({ label, keyName, a, b, single }: { label: string; keyName: string; a: SpectateReading | null; b: SpectateReading | null; single?: boolean }) { const m = useMessages(); const av = number(a, keyName),
  bv = number(b, keyName);
const percent = (value: number | null) => (value === null ? null : controlInputPercent(value));
return (
  <div className="flex min-w-[54px] flex-col self-stretch text-center text-app-caption text-app-text-secondary">
    <div className="order-last mt-1 text-app-label">{label}</div>
    <div className="flex flex-1 justify-center gap-1.5">
      {[
        { side: "A", value: percent(av), color: single ? keyName === "inputs.brake" ? "var(--ch-brake)" : "var(--ch-throttle)" : "var(--comparison-lap-a)" },
        ...(!single ? [{ side: "B", value: percent(bv), color: "var(--comparison-lap-b)" }] : []),
      ].map(({ side, value, color }) => (
        <div key={side} data-pedal={keyName} className="flex flex-col items-center gap-0.5" aria-label={single ? `${label}: ${display(value)}%` : m.spectate_pedal_readout({ side, label, value: display(value) })}>
          {!single && <span>{side}</span>}
          <div className="flex min-h-7 w-2 flex-1 items-end overflow-hidden rounded-sm bg-app-progress-track">
            <i className="block w-full" style={{ height: `${value ?? 0}%`, background: color }} />
          </div>
          <span className="w-9 shrink-0 whitespace-nowrap tabular-nums">
            {display(value)}
            {value === null ? "" : "%"}
          </span>
        </div>
      ))}
    </div>
  </div>
); }
function BatteryModeRail({ a, b, single }: { a: SpectateReading | null; b: SpectateReading | null; single?: boolean }) { const m = useMessages(); const modeA = readERSDeployMode(a);
const modeB = readERSDeployMode(b);
return (
  <div role="group" aria-label={m.f1live_ers_label()} className="flex min-w-0 items-center justify-center gap-3 whitespace-nowrap text-app-caption" data-battery-mode-a={modeA ?? "unavailable"} data-battery-mode-b={single ? undefined : modeB ?? "unavailable"}>
    <span className="text-app-text-secondary">{m.f1live_ers_label()}</span>
    {[{ side: "A", mode: modeA, color: "var(--comparison-lap-a)" }, ...(!single ? [{ side: "B", mode: modeB, color: "var(--comparison-lap-b)" }] : [])].map(({ side, mode, color }) => (
      <span key={side} className="inline-flex items-center gap-1">
        {!single && <strong style={{ color }}>{side}</strong>}
        <span style={{ color: mode === null ? "var(--app-text-secondary)" : ERS_DEPLOY_MODES[mode].color }}>{mode === null ? m.analyse_unavailable() : m[ERS_DEPLOY_MODES[mode].label]()}</span>
      </span>
    ))}
  </div>
); }

export function SpectateInputs({ pair, controller }: { pair: ReplaySession; controller: SpectateController }) { const m = useMessages(); const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
const isF1 = pair.gameId === "f1-2025";
const units = useUnits(pair.gameId);
const primaryColor = pair.b ? "var(--comparison-lap-a)" : "var(--app-accent)";
const a = snapshot.a,
  b = snapshot.b;
const balanceMetric = useMemo(() => resolveAnalysisTelemetry(getGame(pair.gameId)).balance, [pair.gameId]);
const balanceA = snapshot.a ? resolveBalance(snapshot.a, balanceMetric) : null;
const balanceB = snapshot.b ? resolveBalance(snapshot.b, balanceMetric) : null;
const deltaChannel = useMemo<SpectateChannel | null>(() => pair.b && pair.comparison.traces && pair.comparison.timeDelta
  ? ({
      id: "comparison.time-delta",
      label: "Time delta",
      unit: "s",
      components: [],
      derived: "delta",
      delta: { distance: pair.comparison.traces.distance, values: pair.comparison.timeDelta },
    })
  : null, [pair]);
const rawDelta = deltaChannel ? channelValue(a, deltaChannel, "") : null;
const delta = rawDelta === null ? null : Math.round(rawDelta * 1000) / 1000;
const previousDelta = !deltaChannel || snapshot.time < 1
  ? null
  : channelValue(controller.sample(snapshot.time - 1).a, deltaChannel, "");
// Delta is A − B, so a falling delta means A is gaining on B.
const gain = rawDelta === null || previousDelta === null
  ? null
  : Math.round((previousDelta - rawDelta) * 1000) / 1000;
const trendValue = Math.max(-1, Math.min(1, gain ?? 0));
const trendText = gain === null
  ? m.spectate_delta_trend_unavailable()
  : gain === 0
    ? m.spectate_delta_trend_steady()
    : gain > 0
      ? m.spectate_delta_trend_gaining({ seconds: gain.toFixed(3) })
      : m.spectate_delta_trend_losing({ seconds: Math.abs(gain).toFixed(3) });
const rawSpeedA = number(a, "motion.speed"),
  rawSpeedB = number(b, "motion.speed");
const valueA = rawSpeedA === null ? null : units.speed(rawSpeedA);
const valueB = rawSpeedB === null ? null : units.speed(rawSpeedB);
const unitLabel = units.speedLabel;
const speedScale = useMemo(() => {
  let maximum = 1;
  for (const lap of [pair.a, ...(pair.b ? [pair.b] : [])])
    for (const sample of lap.samples) {
      const speed = sample.values["motion.speed"];
      if (typeof speed === "number" && Number.isFinite(speed)) maximum = Math.max(maximum, units.speed(speed));
    }
  return maximum;
}, [pair, units]);
const steerA = number(a, "inputs.steer"),
  steerB = number(b, "inputs.steer");
const steeringUnit = getTelemetryVariable("inputs.steer").canonicalUnit ?? "";
const steeringScale = useMemo(() => {
  let maximum = 1;
  for (const lap of [pair.a, ...(pair.b ? [pair.b] : [])])
    for (const sample of lap.samples) {
      const steering = sample.values["inputs.steer"];
      if (typeof steering === "number" && Number.isFinite(steering)) maximum = Math.max(maximum, Math.abs(steering));
    }
  return maximum;
}, [pair]);
const needle = (value: number | null, radius: number) => {
  if (value === null) return null;
  const angle = Math.PI - Math.PI * Math.min(1, Math.max(0, value / speedScale));
  return <line x1="60" y1="52" x2={60 + Math.cos(angle) * radius} y2={52 - Math.sin(angle) * radius} stroke="currentColor" strokeWidth="2.5" />;
};
const markerX = (value: number) => 16 + (Math.max(-1, Math.min(1, value / steeringScale)) + 1) * 64;
return (
  <section
    className="absolute bottom-3 left-1/2 z-20 grid w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 grid-cols-[minmax(132px,1fr)_minmax(132px,1fr)_max-content_max-content_max-content] items-end gap-3 overflow-x-auto rounded-md border border-app-border bg-app-bg/80 px-3 py-2 text-app-label backdrop-blur-md"
    aria-label={pair.b ? m.spectate_inputs() : m.overlay_inputs()}
  >
    {pair.b && <div className="col-span-5 flex items-baseline justify-center gap-2 border-b border-app-border pb-1">
      <span className="text-app-caption text-app-text-secondary">{m.spectate_time_delta()} · A − B</span>
      <output aria-label={`${m.spectate_time_delta()} · A − B`} className="w-[10ch] whitespace-nowrap text-right font-semibold tabular-nums" style={{ color: delta === null || delta === 0 ? "var(--app-text-secondary)" : delta < 0 ? "var(--status-success)" : "var(--status-danger)" }}>
        {delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(3)} s`}
      </output>
      <div className="flex shrink-0 items-center gap-1.5 self-center" title={trendText}>
        <div role={gain === null ? "img" : "meter"} aria-label={gain === null ? trendText : m.spectate_delta_trend_label()}
          aria-valuemin={gain === null ? undefined : -1} aria-valuemax={gain === null ? undefined : 1} aria-valuenow={gain === null ? undefined : trendValue}
          aria-valuetext={trendText} className="relative h-2 w-20 overflow-hidden rounded-sm bg-app-progress-track">
          <div className="absolute inset-y-0" style={{ left: `${50 + Math.min(0, trendValue) * 50}%`, width: `${Math.abs(trendValue) * 50}%`, backgroundColor: gain !== null && gain > 0 ? "var(--status-success)" : "var(--status-danger)" }} />
          <div className="absolute inset-y-0 left-1/2 w-px bg-app-text-muted" />
        </div>
        <span className="text-app-caption text-app-text-secondary">{m.spectate_delta_trend_window()}</span>
      </div>
    </div>}
    <div className="flex min-w-[132px] flex-col self-stretch text-center">
      <div className="order-last mt-1 whitespace-nowrap text-app-text-secondary">
        {m.spectate_speed()} · {unitLabel}
      </div>
      <svg viewBox="0 0 120 65" className="mx-auto my-auto h-14 w-28 shrink-0" role="img" aria-label={pair.b ? m.spectate_speed_readout({ a: display(valueA), b: display(valueB), unit: unitLabel }) : m.spectate_speed()}>
        <path d="M17 52A43 43 0 0 1 103 52" fill="none" stroke="var(--app-border-input)" strokeWidth="1.5" />
        <g style={{ color: primaryColor }}>{needle(valueA, 39)}</g>
        {pair.b && <g style={{ color: "var(--comparison-lap-b)" }}>{needle(valueB, 31)}</g>}
        <circle cx="60" cy="52" r="3" fill="var(--app-text)" />
      </svg>
      <div className="flex justify-center gap-3 tabular-nums">
        <span style={{ color: primaryColor }}>{pair.b ? "A " : ""}{display(valueA)}</span>
        {pair.b && <span style={{ color: "var(--comparison-lap-b)" }}>B {display(valueB)}</span>}
      </div>
    </div>
    <div className="flex min-w-[132px] flex-col self-stretch text-center">
      <div className="order-last mt-1 whitespace-nowrap text-app-text-secondary">
        {m.spectate_steering()}
        {steeringUnit && ` · ${steeringUnit}`}
      </div>
      <svg viewBox="0 0 160 60" className="mx-auto my-auto h-12 w-32 shrink-0" role="img" aria-label={pair.b ? m.spectate_steering_readout({ a: display(steerA, 2), b: display(steerB, 2), unit: steeringUnit }) : m.spectate_steering()}>
        <path d="M12 30H148M12 26v8m34-6v4m34-11v18m34-11v4m34-6v8" stroke="var(--app-border-input)" />
        {steerA !== null && <line x1={markerX(steerA)} x2={markerX(steerA)} y1="8" y2="29" stroke={primaryColor} strokeWidth="3" />}
        {pair.b && steerB !== null && <line x1={markerX(steerB)} x2={markerX(steerB)} y1="31" y2="52" stroke="var(--comparison-lap-b)" strokeWidth="3" />}
      </svg>
      <div className="flex justify-center gap-3 tabular-nums">
        <span style={{ color: primaryColor }}>{pair.b ? "A " : ""}{display(steerA, 2)}</span>
        {pair.b && <span style={{ color: "var(--comparison-lap-b)" }}>B {display(steerB, 2)}</span>}
      </div>
    </div>
    <div className="flex min-w-[42px] flex-col self-stretch text-center text-app-text-secondary">
      <div className="order-last mt-1 whitespace-nowrap">{m.spectate_gear()}</div>
      <div className="flex flex-1 flex-col items-center justify-center gap-0.5 whitespace-nowrap font-semibold tabular-nums">
        <span style={{ color: primaryColor }}>{pair.b ? "A " : ""}{display(number(a, "inputs.gear"))}</span>
        {pair.b && <span style={{ color: "var(--comparison-lap-b)" }}>B {display(number(b, "inputs.gear"))}</span>}
      </div>
    </div>
    <Pedal label={m.spectate_brake()} keyName="inputs.brake" a={a} b={b} single={!pair.b} />
    <Pedal label={m.spectate_throttle()} keyName="inputs.accel" a={a} b={b} single={!pair.b} />
    <div className="col-span-5 flex min-w-max items-center justify-center gap-4 border-t border-app-border pt-1">
      {isF1 && <BatteryModeRail a={a} b={b} single={!pair.b} />}
      <div role="group" aria-label={m.spectate_balance()} className="flex items-center justify-center gap-2 text-app-caption" title={m.dataguide_desc_balance()}>
        <span className="text-app-text-secondary">{m.spectate_balance()}</span>
        <div className="flex items-center gap-2">
          {[
            { side: "A", balance: balanceA, color: "var(--comparison-lap-a)" },
            ...(pair.b ? [{ side: "B", balance: balanceB, color: "var(--comparison-lap-b)" }] : []),
          ].map(({ side, balance, color }) => (
            <div key={side} className="flex items-center gap-1">
              {pair.b && <strong style={{ color }}>{side}</strong>}
              <output
                aria-label={pair.b ? `${side} ${m.spectate_balance()}` : m.spectate_balance()}
                aria-live="off"
                data-balance-side={side.toLowerCase()}
                data-balance-state={balance?.state ?? "unavailable"}
                data-balance-value={balance?.balance ?? ""}
                className="inline-block whitespace-nowrap tabular-nums"
                style={{ color: balance ? balanceColor(balance.state) : "var(--app-text-secondary)" }}
              >
                {balance
                  ? balance.state === "neutral" ? m.dynamics_state_neutral() : balance.state === "understeer" ? m.dynamics_state_understeer() : m.dynamics_state_oversteer()
                  : "—"}
              </output>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
); }

import { m } from "@/paraglide/messages";
import { useMemo, useSyncExternalStore } from "react";
import { getTelemetryVariable } from "@raceiq/shared/telemetry/catalog/query";
import { controlInputPercent } from "@/lib/vehicle-dynamics";
import { useUnits } from "@/hooks/useUnits";
import type { SpectateController, SpectatePair, SpectateReading } from "./types";

function number(reading: SpectateReading | null, key: string): number | null {
  const value = reading?.values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function display(value: number | null, digits = 0) {
  return value === null ? "—" : value.toFixed(digits);
}
function Pedal({ label, keyName, a, b }: { label: string; keyName: string; a: SpectateReading | null; b: SpectateReading | null }) {
  const av = number(a, keyName),
    bv = number(b, keyName);
  const percent = (value: number | null) => (value === null ? null : controlInputPercent(value));
  return (
    <div className="flex min-w-[54px] flex-col self-stretch text-center text-app-caption text-app-text-secondary">
      <div>{label}</div>
      <div className="mt-1 flex flex-1 justify-center gap-1.5">
        {[
          { side: "A", value: percent(av), color: "var(--comparison-lap-a)" },
          { side: "B", value: percent(bv), color: "var(--comparison-lap-b)" },
        ].map(({ side, value, color }) => (
          <div key={side} className="flex flex-col items-center gap-0.5" aria-label={m.spectate_pedal_readout({ side, label, value: display(value) })}>
            <span>{side}</span>
            <div className="flex min-h-7 w-2 flex-1 items-end overflow-hidden rounded-sm bg-app-progress-track">
              <i className="block w-full" style={{ height: `${value ?? 0}%`, background: color }} />
            </div>
            <span className="tabular-nums">
              {display(value)}
              {value === null ? "" : "%"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
const F1_DEPLOY_MODES = [
  { value: 0, label: m.f1live_ers_mode_none(), color: "var(--telemetry-ers-mode-none)" },
  { value: 1, label: m.f1live_ers_mode_medium(), color: "var(--telemetry-ers-mode-medium)" },
  { value: 2, label: m.f1live_ers_mode_hotlap(), color: "var(--telemetry-ers-mode-hotlap)" },
  { value: 3, label: m.f1live_ers_mode_overtake(), color: "var(--telemetry-ers-mode-overtake)" },
] as const;

function deployMode(reading: SpectateReading | null): number | null {
  const value = reading?.values["fuel.ers-deploy-mode"];
  if (typeof value === "string" && /^[0-3]$/.test(value)) return Number(value);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

function BatteryModeRail({ a, b }: { a: SpectateReading | null; b: SpectateReading | null }) {
  const modeA = deployMode(a);
  const modeB = deployMode(b);
  return (
    <div role="group" aria-label={m.f1live_ers_label()} className="col-span-5 min-w-0 text-center" data-battery-mode-a={modeA ?? "unavailable"} data-battery-mode-b={modeB ?? "unavailable"}>
      <div className="text-app-text-secondary">{m.f1live_ers_label()}</div>
      <div className="relative mt-1 flex items-start">
        {F1_DEPLOY_MODES.map((mode) => (
          <div key={mode.value} className="relative min-w-0 flex-1" data-mode-step={mode.value}>
            <div className="min-h-6 text-app-caption leading-tight text-app-text-secondary">{mode.label}</div>
            <div className="relative mt-1 h-5 border-t border-app-border-input">
              {modeA === mode.value && <span role="img" aria-label={`A: ${mode.label}`} className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-app-caption font-semibold leading-none" style={{ color: "var(--comparison-lap-a)" }}>A</span>}
              {modeB === mode.value && <span role="img" aria-label={`B: ${mode.label}`} className="absolute top-1 left-1/2 -translate-x-1/2 text-app-caption font-semibold leading-none" style={{ color: "var(--comparison-lap-b)" }}>B</span>}
            </div>
          </div>
        ))}
      </div>
      {(modeA === null || modeB === null) && (
        <div className="flex justify-center gap-3 text-app-caption text-app-text-secondary">
          {modeA === null && <span>A {m.analyse_unavailable()}</span>}
          {modeB === null && <span>B {m.analyse_unavailable()}</span>}
        </div>
      )}
    </div>
  );
}

export function SpectateInputs({ pair, controller }: { pair: SpectatePair; controller: SpectateController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const isF1 = pair.gameId === "f1-2025";
  const units = useUnits(pair.gameId);
  const a = snapshot.a,
    b = snapshot.b;
  const rawSpeedA = number(a, "motion.speed"),
    rawSpeedB = number(b, "motion.speed");
  const valueA = rawSpeedA === null ? null : units.speed(rawSpeedA);
  const valueB = rawSpeedB === null ? null : units.speed(rawSpeedB);
  const unitLabel = units.speedLabel;
  const speedScale = useMemo(() => {
    let maximum = 1;
    for (const lap of [pair.a, pair.b])
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
    for (const lap of [pair.a, pair.b])
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
      className="absolute bottom-3 left-1/2 z-20 grid w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 grid-cols-[minmax(132px,1fr)_minmax(132px,1fr)_max-content_max-content_max-content] items-end gap-3 overflow-x-auto rounded-md border border-app-border bg-app-bg/80 px-3 py-2 text-app-label"
      aria-label={m.spectate_inputs()}
    >
      <div className="min-w-[132px] text-center">
        <div className="text-app-text-secondary">
          {m.spectate_speed()} · {unitLabel}
        </div>
        <svg viewBox="0 0 120 65" className="mx-auto h-14 w-28" role="img" aria-label={m.spectate_speed_readout({ a: display(valueA), b: display(valueB), unit: unitLabel })}>
          <path d="M17 52A43 43 0 0 1 103 52" fill="none" stroke="var(--app-border-input)" strokeWidth="1.5" />
          <g style={{ color: "var(--comparison-lap-a)" }}>{needle(valueA, 39)}</g>
          <g style={{ color: "var(--comparison-lap-b)" }}>{needle(valueB, 31)}</g>
          <circle cx="60" cy="52" r="3" fill="var(--app-text)" />
        </svg>
        <div className="flex justify-center gap-3 tabular-nums">
          <span style={{ color: "var(--comparison-lap-a)" }}>A {display(valueA)}</span>
          <span style={{ color: "var(--comparison-lap-b)" }}>B {display(valueB)}</span>
        </div>
      </div>
      <div className="min-w-[132px] text-center">
        <div className="text-app-text-secondary">
          {m.spectate_steering()}
          {steeringUnit && ` · ${steeringUnit}`}
        </div>
        <svg viewBox="0 0 160 60" className="mx-auto h-12 w-32" role="img" aria-label={m.spectate_steering_readout({ a: display(steerA, 2), b: display(steerB, 2), unit: steeringUnit })}>
          <path d="M12 30H148M12 26v8m34-6v4m34-11v18m34-11v4m34-6v8" stroke="var(--app-border-input)" />
          {steerA !== null && <line x1={markerX(steerA)} x2={markerX(steerA)} y1="8" y2="29" stroke="var(--comparison-lap-a)" strokeWidth="3" />}
          {steerB !== null && <line x1={markerX(steerB)} x2={markerX(steerB)} y1="31" y2="52" stroke="var(--comparison-lap-b)" strokeWidth="3" />}
        </svg>
        <div className="flex justify-center gap-3 tabular-nums">
          <span style={{ color: "var(--comparison-lap-a)" }}>A {display(steerA, 2)}</span>
          <span style={{ color: "var(--comparison-lap-b)" }}>B {display(steerB, 2)}</span>
        </div>
      </div>
      <div className="min-w-[42px] text-center text-app-text-secondary">
        {m.spectate_gear()}
        <div className="mt-2 flex flex-col items-center gap-0.5 whitespace-nowrap font-semibold tabular-nums">
          <span style={{ color: "var(--comparison-lap-a)" }}>A {display(number(a, "inputs.gear"))}</span>
          <span style={{ color: "var(--comparison-lap-b)" }}>B {display(number(b, "inputs.gear"))}</span>
        </div>
      </div>
      <Pedal label={m.spectate_brake()} keyName="inputs.brake" a={a} b={b} />
      <Pedal label={m.spectate_throttle()} keyName="inputs.accel" a={a} b={b} />
      {isF1 && <BatteryModeRail a={a} b={b} />}
    </section>
  );
}

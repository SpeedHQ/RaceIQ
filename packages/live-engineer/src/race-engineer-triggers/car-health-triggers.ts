import type { TelemetryVariableId } from "@raceiq/shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { RaceEngineerTriggerDraftV1, RaceEngineerTriggerFunction } from "./contracts";
import type { PreviousValueState } from "./common";
import damageCallouts from "@raceiq/shared/racing/live/damage-callouts.json";
type State = PreviousValueState;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const draft = (eventKey: string, severity: RaceEngineerTriggerDraftV1["severity"], payload: Record<string, number | string>, evidenceSemanticIds: TelemetryVariableId[]): RaceEngineerTriggerDraftV1 => ({ eventKey, severity, payload, evidenceSemanticIds });
const bucket = (v: number): "cold" | "normal" | "hot" | "cooking" => v <= 70 ? "cold" : v >= 180 ? "cooking" : v >= 100 ? "hot" : "normal";
export const triggerTyreMonitor: RaceEngineerTriggerFunction<State> = (input, state) => {
  const lap = input.frame.hasFresh("timing.lap-number") ? input.frame.ok("timing.lap-number") : undefined;
  const sector = input.frame.hasFresh("timing.sector.current-index") ? input.frame.ok("timing.sector.current-index") : undefined;
  const fm = input.frame.simulator === "fm-2023";
  const temperatureId: "tire.temperature.surface.representative" | "tire.temperature.core" = fm ? "tire.temperature.surface.representative" : "tire.temperature.core";
  const raw = input.frame.hasFresh(temperatureId) ? input.frame.ok(temperatureId) : undefined;
  const temps = Array.isArray(raw) && raw.length === 4 && raw.every(finite) ? raw.reduce((a, b) => a + b, 0) / 4 : undefined;
  const s = state.previous as { startLap?: number; bucket?: string } | undefined;
  if (!state.armed) { state.armed = true; state.previous = { startLap: finite(lap) ? lap : undefined, bucket: finite(temps) ? bucket(temps) : undefined }; return null; }
  if (!finite(lap) || (!fm && sector !== 2) || input.context.pit || !finite(temps)) return null;
  const nextBucket = bucket(temps);
  state.previous = { startLap: fm ? lap : s?.startLap, bucket: nextBucket };
  if (s?.bucket === nextBucket) return null;
  if (fm) {
    if (s?.startLap === lap) return null;
  } else {
    if (!finite(s?.startLap) || lap < s.startLap + 2 || nextBucket === "normal") return null;
  }
  const payload: Record<string, number> = { lap, temperature: temps };
  const evidence: TelemetryVariableId[] = input.frame.simulator === "fm-2023" ? ["timing.lap-number", temperatureId] : ["timing.lap-number", "timing.sector.current-index", temperatureId];
  if (input.frame.simulator !== "fm-2023") payload.sector = sector as number;
  const severity = fm ? nextBucket === "cold" || nextBucket === "cooking" ? "warning" : "info" : nextBucket === "cooking" ? "critical" : "warning";
  return draft(`tyres-${nextBucket}`, severity, payload, evidence);
};
export const triggerEngineMonitor: RaceEngineerTriggerFunction<State> = (input, state) => { const temp = input.frame.hasFresh("engine.coolant-temperature") ? input.frame.ok("engine.coolant-temperature") : undefined, s = (state.previous ?? {}) as { started?: number; hot?: boolean }; if (!state.armed) state.armed = true; state.previous = s; if (!finite(temp)) return null; s.started ??= input.sessionTimeMs; if (input.context.pit || input.sessionTimeMs - s.started < 120000) return null; if (temp >= 110 && !s.hot) { s.hot = true; return draft("water-temperature-hot", "critical", { temperature: temp }, ["engine.coolant-temperature"]); } if (temp <= 100 && s.hot) { s.hot = false; return draft("water-temperature-clear", "info", { temperature: temp }, ["engine.coolant-temperature"]); } return null; };
type DamageSignal = (typeof damageCallouts)[number];
const damageSignalsByGame: Readonly<Record<string, readonly DamageSignal[]>> = Object.fromEntries(
  [...new Set(damageCallouts.flatMap((signal) => signal.simulators))].map((game) => [
    game, damageCallouts.filter((signal) => signal.simulators.includes(game)),
  ]),
);
type DamageState = { reported: number; current: number | null; value: number; pending?: number; since?: number };
function damageLevel(signal: DamageSignal, value: unknown): number | null {
  if (signal.kind === "flag") return value === true || value === 1 ? 1 : value === false || value === 0 ? 0 : null;
  if (!finite(value) || value < 0) return null;
  if (signal.kind === "percentage") return value > 100 ? null : value <= 5 ? 0 : value >= 30 ? 2 : 1;
  if (signal.kind === "bodywork") return value > .05 ? 1 : 0;
  if (signal.kind === "bitfield") return Number.isInteger(value) && value <= 0xffffffff ? (value & signal.mask!) !== 0 ? 1 : 0 : null;
  return value > 0 ? 1 : 0;
}
export const triggerDamageReporting: RaceEngineerTriggerFunction<State> = (input, state) => {
  const signals = damageSignalsByGame[input.frame.simulator];
  if (!signals) return null;
  const previous = (state.previous ?? {}) as Record<string, DamageState>;
  state.armed = true;
  state.previous = previous;
  for (const signal of signals) {
    const id = signal.semanticId as TelemetryVariableId;
    const raw = input.frame.hasFresh(id) ? input.frame.ok(id) : undefined;
    const value = signal.index === undefined ? raw : Array.isArray(raw) && raw.length === 4 ? raw[signal.index] : undefined;
    const zone = previous[signal.component] ??= { reported: 0, current: null, value: 0 };
    zone.current = damageLevel(signal, value);
    zone.value = typeof value === "boolean" ? Number(value) : finite(value) ? value : 0;
  }
  let selected: DamageSignal | undefined;
  let selectedPriority = -1;
  for (const signal of signals) {
    const zone = previous[signal.component]!;
    const detached = signal.component.endsWith("-tyre-flat") && previous[signal.component.replace("-tyre-flat", "-wheel-detached")]?.current === 1;
    const engineFailure = signal.component === "engine" && (previous["engine-blown"]?.current === 1 || previous["engine-seized"]?.current === 1);
    if (zone.current === 0) zone.reported = 0;
    if (zone.current === null || zone.current <= zone.reported || detached || engineFailure) {
      zone.pending = undefined;
      zone.since = undefined;
      continue;
    }
    if (zone.pending !== zone.current) {
      zone.pending = zone.current;
      zone.since = input.sessionTimeMs;
    }
    if (input.sessionTimeMs - zone.since! < 3000) continue;
    const candidate = selected && previous[selected.component]!;
    const priority = signal.component.endsWith("-wheel-detached") ? 2 : Number(signal.critical ?? false);
    if (!selected || priority > selectedPriority ||
        (priority === selectedPriority && (zone.pending > candidate!.pending! ||
          (zone.pending === candidate!.pending && signal.kind === "percentage" && selected.kind === "percentage" && zone.value > candidate!.value)))) {
      selected = signal;
      selectedPriority = priority;
    }
  }
  if (!selected) return null;
  const zone = previous[selected.component]!;
  zone.reported = zone.pending!;
  zone.pending = undefined;
  zone.since = undefined;
  return draft("damage-reported", selected.critical ? "critical" : "warning", {
    component: selected.component, level: zone.reported, value: zone.value,
  }, [selected.semanticId as TelemetryVariableId]);
};

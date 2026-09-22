import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CrewChiefTriggerDraftV1, CrewChiefTriggerFunction } from "./contracts";
import type { PreviousValueState } from "./common";
type State = PreviousValueState;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const draft = (eventKey: string, severity: CrewChiefTriggerDraftV1["severity"], payload: Record<string, number | string>, evidenceSemanticIds: TelemetryVariableId[]): CrewChiefTriggerDraftV1 => ({ eventKey, severity, payload, evidenceSemanticIds });
const bucket = (v: number): "cold" | "normal" | "hot" | "cooking" => v <= 70 ? "cold" : v >= 180 ? "cooking" : v >= 100 ? "hot" : "normal";
export const triggerTyreMonitor: CrewChiefTriggerFunction<State> = (input, state) => {
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
export const triggerEngineMonitor: CrewChiefTriggerFunction<State> = (input, state) => { const temp = input.frame.hasFresh("engine.coolant-temperature") ? input.frame.ok("engine.coolant-temperature") : undefined, s = (state.previous ?? {}) as { started?: number; hot?: boolean }; if (!state.armed) state.armed = true; state.previous = s; if (!finite(temp)) return null; s.started ??= input.sessionTimeMs; if (input.context.pit || input.sessionTimeMs - s.started < 120000) return null; if (temp >= 110 && !s.hot) { s.hot = true; return draft("water-temperature-hot", "critical", { temperature: temp }, ["engine.coolant-temperature"]); } if (temp <= 100 && s.hot) { s.hot = false; return draft("water-temperature-clear", "info", { temperature: temp }, ["engine.coolant-temperature"]); } return null; };
export const triggerDamageReporting: CrewChiefTriggerFunction<State> = (input, state) => {
  const fields = ["front", "rear", "left", "right", "centre"] as const;
  const semanticIds: TelemetryVariableId[] = input.frame.simulator === "f1-2025"
    ? ["damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage", "damage.floor-damage", "damage.diffuser-damage", "damage.sidepod-damage"]
    : fields.map((field) => `damage.car-damage-${field}` as TelemetryVariableId);
  const values = semanticIds.map((semanticId) => input.frame.hasFresh(semanticId) ? input.frame.ok(semanticId) : undefined);
  if (values.some((value) => !finite(value))) return null;

  const damage = input.frame.simulator === "f1-2025"
    ? {
        front: Math.max(values[0] as number, values[1] as number) / 100,
        rear: (values[2] as number) / 100,
        left: 0,
        right: 0,
        centre: Math.max(values[3] as number, values[4] as number, values[5] as number) / 100,
      }
    : Object.fromEntries(fields.map((field, index) => [field, values[index] as number])) as Record<(typeof fields)[number], number>;
  const s = (state.previous ?? {}) as { since?: number; reported?: boolean };
  if (!state.armed) state.armed = true;
  state.previous = s;
  if (fields.every((field) => damage[field] <= .05)) {
    s.since = undefined;
    s.reported = false;
    return null;
  }
  s.since ??= input.sessionTimeMs;
  if (!s.reported && input.sessionTimeMs - s.since >= 3000) {
    s.reported = true;
    return draft("damage-reported", "warning", damage, semanticIds);
  }
  return null;
};

import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CrewChiefTriggerDraftV1, CrewChiefTriggerFunction } from "./contracts";
import type { PreviousValueState } from "./common";
type State = PreviousValueState;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const draft = (eventKey: string, severity: CrewChiefTriggerDraftV1["severity"], payload: Record<string, number | string>, evidenceSemanticIds: TelemetryVariableId[]): CrewChiefTriggerDraftV1 => ({ eventKey, severity, payload, evidenceSemanticIds });
const bucket = (v: number): "cold" | "normal" | "hot" | "cooking" => v <= 70 ? "cold" : v >= 180 ? "cooking" : v >= 100 ? "hot" : "normal";
export const triggerTyreMonitor: CrewChiefTriggerFunction<State> = (input, state) => { const lap = input.frame.hasFresh("timing.lap-number") ? input.frame.ok("timing.lap-number") : undefined, sector = input.frame.hasFresh("timing.sector.current-index") ? input.frame.ok("timing.sector.current-index") : undefined, raw = input.frame.hasFresh("tire.temperature.core") ? input.frame.ok("tire.temperature.core") : undefined, temps = Array.isArray(raw) && raw.length === 4 && raw.every(finite) ? raw.reduce((a, b) => a + b, 0) / 4 : undefined; const s = state.previous as { startLap?: number; bucket?: string } | undefined; if (!state.armed) { state.armed = true; state.previous = { startLap: finite(lap) ? lap : undefined, bucket: finite(temps) ? bucket(temps) : undefined }; return null; } if (!finite(lap) || !finite(sector) || sector !== 2 || input.context.pit || !finite(temps)) return null; if (!s || !finite(s.startLap)) return null; const old = s.bucket, current = bucket(temps); s.bucket = current; if (lap < s.startLap + 2 || !old || old === current) return null; const key = current === "cold" ? "tyres-cold" : current === "hot" ? "tyres-hot" : current === "cooking" ? "tyres-cooking" : null; return key ? draft(key, current === "cooking" ? "critical" : "warning", { temperature: temps, bucket: current }, ["tire.temperature.core", "timing.lap-number", "timing.sector.current-index"]) : null; };
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

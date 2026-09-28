import type { CrewChiefTriggerFunction } from "./contracts";
import type { PreviousValueState } from "./common";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const triggerConditionsMonitor: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  const f1 = input.frame.simulator === "f1-2025";
  const acc = input.frame.simulator === "acc";
  const semanticId = f1 ? "weather.weather-type" : acc ? "weather.rain-intensity-code" : "weather.rain-intensity";
  const raw = input.frame.ok(semanticId);
  const s = (state.previous ?? {}) as { sampled?: number; bucket?: string };
  if (!state.armed) state.armed = true;
  state.previous = s;
  if (s.sampled !== undefined && input.sessionTimeMs - s.sampled < 10000) return null;
  let current: string;
  let intensity: number;
  if (f1) {
    if (typeof raw !== "string" || !/^[0-5]$/.test(raw)) return null;
    const weather = Number(raw);
    current = weather <= 2 ? "clear" : weather === 3 ? "light" : "heavy";
    intensity = weather;
  } else if (acc) {
    if (!finite(raw) || !Number.isInteger(raw) || raw < 0 || raw > 5) return null;
    intensity = raw;
    current = raw === 0 ? "clear" : raw <= 2 ? "light" : "heavy";
  } else {
    if (!finite(raw)) return null;
    intensity = raw;
    current = raw <= 0 ? "clear" : raw < 0.5 ? "light" : "heavy";
  }
  const old = s.bucket;
  s.sampled = input.sessionTimeMs;
  s.bucket = current;
  return old && old !== current
    ? {
        eventKey: "rain-changed",
        severity: "info",
        payload: { intensity, bucket: current },
        evidenceSemanticIds: [semanticId],
      }
    : null;
};

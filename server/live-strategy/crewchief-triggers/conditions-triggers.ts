import type { CrewChiefTriggerFunction } from "./contracts";
import type { PreviousValueState } from "./common";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const triggerConditionsMonitor: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  const rain = input.frame.hasFresh("weather.rain-intensity")
    ? input.frame.ok("weather.rain-intensity")
    : undefined;
  const s = (state.previous ?? {}) as { sampled?: number; bucket?: string };

  if (!state.armed) state.armed = true;
  state.previous = s;
  if (!finite(rain) || (s.sampled !== undefined && input.sessionTimeMs - s.sampled < 10000)) return null;

  const current = rain <= 0 ? "clear" : rain < 0.5 ? "light" : "heavy";
  const old = s.bucket;
  s.sampled = input.sessionTimeMs;
  s.bucket = current;
  return old && old !== current
    ? {
        eventKey: "rain-changed",
        severity: "info",
        payload: { intensity: rain, bucket: current },
        evidenceSemanticIds: ["weather.rain-intensity"],
      }
    : null;
};

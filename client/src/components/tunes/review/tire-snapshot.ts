import type { SemanticAnalysisFrame } from "../../analyse/track-map/types";
import { wheelValue } from "../semantic-tune";
import type { TelemetryVariableId } from "../../../../../shared/telemetry/catalog/generated/telemetry-catalog.types";

export interface CornerSnap {
  tempC: number;
  wear: number;
  pressure: number;
  brakeTemp: number;
}

const IDS: Record<"tempC" | "wear" | "pressure" | "brakeTemp", TelemetryVariableId> = {
  tempC: "tire.temperature.average",
  wear: "tires.tire-wear",
  pressure: "tires.tire-pressure",
  brakeTemp: "brakes.brake-temp",
};

/** End-of-lap tyre snapshot: averaged temp/pressure/brake-temp, wear at end. */
export function tireSnapshot(frames: SemanticAnalysisFrame[]): Record<"FL" | "FR" | "RL" | "RR", CornerSnap> | null {
  if (frames.length === 0) return null;
  const last = frames[frames.length - 1];
  const avg = (id: TelemetryVariableId, index: number): number | null => {
    const values = frames.map((frame) => wheelValue(frame, id, index)).filter((value): value is number => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const snapshot = (index: number): CornerSnap | null => {
    const tempC = avg(IDS.tempC, index);
    const wear = wheelValue(last, IDS.wear, index) ?? null;
    const pressure = avg(IDS.pressure, index);
    const brakeTemp = avg(IDS.brakeTemp, index);
    return tempC != null && wear != null && pressure != null && brakeTemp != null ? { tempC, wear, pressure, brakeTemp } : null;
  };
  const fl = snapshot(0);
  const fr = snapshot(1);
  const rl = snapshot(2);
  const rr = snapshot(3);
  return fl && fr && rl && rr ? { FL: fl, FR: fr, RL: rl, RR: rr } : null;
}

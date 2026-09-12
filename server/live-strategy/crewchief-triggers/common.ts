import type { TelemetryVariableId } from "../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CrewChiefTriggerDraftV1, CrewChiefTriggerFunction } from "./contracts";

export interface PreviousValueState { previous: unknown; armed: boolean; }
export const createPreviousValueState = (): PreviousValueState => ({ previous: undefined, armed: false });
const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (typeof a === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    return ak.length === bk.length && ak.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
};
export const transition = (input: Parameters<CrewChiefTriggerFunction<PreviousValueState>>[0], state: PreviousValueState, family: string, eventKey: string, id: TelemetryVariableId, severity: CrewChiefTriggerDraftV1["severity"] = "info"): CrewChiefTriggerDraftV1 | null => {
  void family;
  const current = input.frame.ok(id);
  if (!state.armed) { state.armed = true; state.previous = current; return null; }
  const previous = state.previous;
  state.previous = current;
  if (current === undefined || equal(current, previous)) return null;
  return { eventKey, severity, payload: { previous: previous as CrewChiefTriggerDraftV1["payload"][string], current: current as CrewChiefTriggerDraftV1["payload"][string] }, evidenceSemanticIds: [id] };
};

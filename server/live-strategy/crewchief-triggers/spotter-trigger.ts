import type { CrewChiefTriggerFunction } from "./contracts";
import { transition, type PreviousValueState } from "./common";
export const triggerSpotter: CrewChiefTriggerFunction<PreviousValueState> = (input, state) => {
  const native = input.frame.resolved("identity.car-left-right");
  if (native?.state !== "ok") return null;
  return transition(input, state, "Spotter", "spotter-position", "identity.car-left-right");
};

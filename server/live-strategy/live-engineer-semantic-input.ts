import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";
import type { LiveResolvedSemanticFrame } from "../telemetry/live-projector";

export type LiveEngineerAvailabilityDiagnostic = {
  family: "opponent-pace" | "positional-spotter";
  missing: readonly string[];
  reason: string;
};

export type LiveEngineerSemanticInput = {
  frame: LiveResolvedSemanticFrame;
  values: ReadonlyMap<string, ResolvedValue<unknown>>;
  diagnostics: readonly LiveEngineerAvailabilityDiagnostic[];
};

const ok = (value: ResolvedValue<unknown> | undefined): value is ResolvedValue<unknown> => value?.state === "ok";

export function extractLiveEngineerSemanticInput(frame: LiveResolvedSemanticFrame): LiveEngineerSemanticInput {
  const values = new Map<string, ResolvedValue<unknown>>();
  frame.ids.forEach((id, index) => {
    const value = frame.values[index];
    if (value) values.set(id, value);
  });
  const diagnostics: LiveEngineerAvailabilityDiagnostic[] = [];
  const paceRequired = [
    "identity.player-car-index", "identity.player-car-class-id", "timing.lap-number", "timing.last-lap", "race.pit-status",
    "session.session-type", "race.competitor.car-index", "race.competitor.car-class-id", "race.competitor.laps-complete",
    "race.competitor.pit-status", "timing.competitor.last-lap-time",
  ];
  const missingPace = paceRequired.filter((id) => !ok(values.get(id)));
  const hasNativeValidity = ok(values.get("timing.competitor.last-lap-valid"));
  const hasIRacingInference = frame.simulator === "iracing" && ok(values.get("race.competitor.track-surface-material"));
  if (missingPace.length > 0 || (!hasNativeValidity && !hasIRacingInference)) diagnostics.push({ family: "opponent-pace", missing: [...missingPace, ...(!hasNativeValidity && !hasIRacingInference ? ["timing.competitor.last-lap-valid or iRacing conservative source"] : [])], reason: "required source-backed completed-lap facts unavailable" });
  return { frame, values, diagnostics };
}

import type { GameId } from "../../../shared/games/ids";
import {
  CREWCHIEF_AUTOMATIC_EVENTS,
  CREWCHIEF_EVENT_GROUPS,
  CREWCHIEF_EVENT_SOURCES,
  CREWCHIEF_SEMANTIC_GROUPS,
  type CrewChiefEventFamily,
} from "../../../shared/telemetry/live/crewchief-callout-contract";
import type { LiveResolvedSemanticFrame } from "../../telemetry/live-projector";
import { isLiveEngineerGameId } from "../../../shared/telemetry/live/semantics";
import { createPreviousValueState, type PreviousValueState } from "./common";
import type {
  CrewChiefTriggerBatchV1,
  CrewChiefTriggerDraftV1,
  CrewChiefTriggerEventV1,
  CrewChiefTriggerFunction,
  CrewChiefTriggerResultV1,
} from "./contracts";
import { CrewChiefTriggerFrame } from "./frame";
import { triggerTyreMonitor, triggerEngineMonitor, triggerDamageReporting } from "./car-health-triggers";
import { triggerConditionsMonitor } from "./conditions-triggers";
import { triggerFlagsMonitor, triggerOvertakingAidsMonitor, triggerPenalties } from "./race-control-triggers";
import { triggerFrozenOrderMonitor, triggerLapCounter, triggerPosition, triggerRaceTime, triggerSessionEndMessages } from "./session-triggers";
import { triggerSpotter } from "./spotter-trigger";
import { triggerBattery, triggerFuel, triggerPitStops, triggerPushNow, triggerStrategy } from "./strategy-triggers";
import { triggerDriverSwaps, triggerLapTimes, triggerMulticlassWarnings, triggerOpponents, triggerRatings, triggerTimings, triggerWatchedOpponents } from "./timing-opponent-triggers";

export type CrewChiefRequiredSemanticId = (typeof CREWCHIEF_SEMANTIC_GROUPS)[keyof typeof CREWCHIEF_SEMANTIC_GROUPS][number];
type CapabilityState = "active" | "partial" | "unavailable";
export interface CrewChiefCapability { state: CapabilityState; reasonCode?: string }
export interface CrewChiefTriggerDescriptor<S = unknown> {
  family: CrewChiefEventFamily;
  source: (typeof CREWCHIEF_EVENT_SOURCES)[string][number];
  requiredSemanticIds: readonly CrewChiefRequiredSemanticId[];
  requiredGroups: readonly string[];
  accParity: CapabilityState;
  accReasonCode?: string;
  createState: () => S;
  trigger: CrewChiefTriggerFunction<S>;
}

const descriptor = (
  family: CrewChiefEventFamily,
  trigger: CrewChiefTriggerFunction<PreviousValueState>,
  requiredSemanticIds: readonly CrewChiefRequiredSemanticId[],
  accParity: CapabilityState = "partial",
  accReasonCode = accParity === "partial" ? "partial-semantic-coverage" : undefined,
): CrewChiefTriggerDescriptor<PreviousValueState> => ({
  family,
  source: CREWCHIEF_EVENT_SOURCES[family]![0]!,
  requiredSemanticIds,
  requiredGroups: CREWCHIEF_EVENT_GROUPS[family],
  accParity,
  ...(accReasonCode ? { accReasonCode } : {}),
  createState: createPreviousValueState,
  trigger,
});
const unavailable = (family: CrewChiefEventFamily, trigger: CrewChiefTriggerFunction<PreviousValueState>) =>
  descriptor(family, trigger, [], "unavailable", "no-source-backed-semantic-branch");

export const CREWCHIEF_TRIGGER_CATALOG = [
  descriptor("Position", triggerPosition, ["race.race-position", "identity.player-car-class-id", "race.competitor.car-class-id"]),
  descriptor("LapCounter", triggerLapCounter, ["session.session-state"]),
  unavailable("Timings", triggerTimings),
  descriptor("LapTimes", triggerLapTimes, ["timing.lap-number", "timing.last-lap", "timing.current-lap-valid", "race.pit-status"]),
  descriptor("Opponents", triggerOpponents, ["race.competitor.car-index", "race.competitor.laps-complete"]),
  descriptor("Penalties", triggerPenalties, ["race.penalties"]),
  descriptor("PitStops", triggerPitStops, ["race.pit-status"]),
  descriptor("Fuel", triggerFuel, ["fuel.remaining-volume", "fuel.fuel-per-lap"]),
  unavailable("Battery", triggerBattery),
  unavailable("WatchedOpponents", triggerWatchedOpponents),
  unavailable("Strategy", triggerStrategy),
  unavailable("RaceTime", triggerRaceTime),
  descriptor("TyreMonitor", triggerTyreMonitor, ["timing.lap-number", "timing.sector.current-index", "tire.temperature.average", "race.pit-status"]),
  descriptor("EngineMonitor", triggerEngineMonitor, ["engine.coolant-temperature", "race.pit-status"]),
  descriptor("DamageReporting", triggerDamageReporting, ["damage.car-damage-front", "damage.car-damage-rear"]),
  unavailable("PushNow", triggerPushNow),
  descriptor("FlagsMonitor", triggerFlagsMonitor, ["race.flag-status", "race.pit-status", "session.session-state"]),
  descriptor("ConditionsMonitor", triggerConditionsMonitor, ["weather.rain-intensity"], "active"),
  unavailable("OvertakingAidsMonitor", triggerOvertakingAidsMonitor),
  unavailable("FrozenOrderMonitor", triggerFrozenOrderMonitor),
  unavailable("Ratings", triggerRatings),
  descriptor("MulticlassWarnings", triggerMulticlassWarnings, [
    "identity.player-car-class-id", "motion.position-x", "motion.position-z", "motion.speed",
    "race.competitor.car-index", "race.competitor.connected", "race.competitor.pit-status", "race.competitor.car-class-id",
    "motion.competitor.position-x", "motion.competitor.position-z", "motion.competitor.speed",
  ]),
  unavailable("DriverSwaps", triggerDriverSwaps),
  unavailable("SessionEndMessages", triggerSessionEndMessages),
  descriptor("Spotter", triggerSpotter, ["identity.car-left-right"], "active"),
] as const satisfies readonly CrewChiefTriggerDescriptor<PreviousValueState>[];

if (new Set(CREWCHIEF_TRIGGER_CATALOG.map(({ family }) => family)).size !== 25 ||
    CREWCHIEF_TRIGGER_CATALOG.some(({ family }, index) => family !== [...CREWCHIEF_AUTOMATIC_EVENTS, "Spotter"][index])) {
  throw new Error("CrewChief trigger catalog membership mismatch");
}

const sessionTime = (frame: LiveResolvedSemanticFrame): number =>
  "milliseconds" in frame.observedAt ? frame.observedAt.milliseconds : Number(frame.observedAt.nanoseconds / 1_000_000n);
const normalize = (result: CrewChiefTriggerResultV1): readonly CrewChiefTriggerDraftV1[] =>
  result === null ? [] : "eventKey" in result ? [result] : result;
const capabilityMap = (gameId: GameId, observed?: ReadonlyMap<string, boolean>): Record<CrewChiefEventFamily, CrewChiefCapability> =>
  Object.fromEntries(CREWCHIEF_TRIGGER_CATALOG.map((item) => {
    if (!isLiveEngineerGameId(gameId) || item.accParity === "unavailable") {
      return [item.family, { state: "unavailable", reasonCode: "no-source-backed-semantic-branch" }];
    }
    if (observed && item.requiredSemanticIds.some((id) => observed.get(id) !== true)) {
      return [item.family, { state: "partial", reasonCode: "runtime-semantic-unavailable" }];
    }
    return [item.family, item.accParity === "active"
      ? { state: "active" }
      : { state: "partial", reasonCode: item.accReasonCode ?? "partial-semantic-coverage" }];
  })) as Record<CrewChiefEventFamily, CrewChiefCapability>;

export class CrewChiefTriggerCatalog {
  private readonly states = new Map<CrewChiefEventFamily, PreviousValueState>(
    CREWCHIEF_TRIGGER_CATALOG.map((item) => [item.family, item.createState()]),
  );
  private readonly observed = new Map<string, boolean>();
  private streamKey = "";
  private observedGameId: GameId | null = null;
  private timelineEpoch = 0;

  consume(source: LiveResolvedSemanticFrame): CrewChiefTriggerBatchV1 {
    const key = `${source.simulator}/${source.sessionId ?? ""}/${source.streamId}`;
    if (key !== this.streamKey) {
      this.streamKey = key;
      this.timelineEpoch += 1;
      this.observed.clear();
      for (const item of CREWCHIEF_TRIGGER_CATALOG) this.states.set(item.family, item.createState());
    }
    this.observedGameId = source.simulator;
    source.ids.forEach((id, index) => {
      const value = source.values[index];
      this.observed.set(id, value?.state === "ok" && value.freshness === "fresh");
    });
    const frame = new CrewChiefTriggerFrame(source);
    const context = frame.context();
    const now = sessionTime(source);
    const caps = capabilityMap(source.simulator, this.observed);
    const drafts = CREWCHIEF_TRIGGER_CATALOG.flatMap((item) =>
      caps[item.family].state === "unavailable"
        ? []
        : normalize(item.trigger({ frame, context, sessionTimeMs: now }, this.states.get(item.family)!))
          .map((draft) => ({ ...draft, family: item.family })),
    );
    const events: CrewChiefTriggerEventV1[] = drafts.map((draft, ordinal) => ({
      ...draft,
      triggerId: `${source.streamId}/${this.timelineEpoch}/${source.sequence}/${draft.family}/${draft.eventKey}/${ordinal}`,
      sessionId: String(source.sessionId ?? ""),
      timelineEpoch: this.timelineEpoch,
      sourceSequence: source.sequence,
      sessionTimeMs: now,
      source: CREWCHIEF_EVENT_SOURCES[draft.family]![0]!,
    }));
    return {
      streamId: source.streamId,
      sessionId: String(source.sessionId ?? ""),
      timelineEpoch: this.timelineEpoch,
      sourceSequence: source.sequence,
      sessionTimeMs: now,
      context,
      events,
      semanticFrame: source,
    };
  }

  reset(): void {
    this.streamKey = "";
    this.observed.clear();
    this.observedGameId = null;
    for (const item of CREWCHIEF_TRIGGER_CATALOG) this.states.set(item.family, item.createState());
  }

  capabilities(gameId: GameId): Record<CrewChiefEventFamily, CrewChiefCapability> {
    return capabilityMap(gameId, this.observedGameId === gameId ? this.observed : undefined);
  }
}

export const capabilities = (gameId: GameId): Record<CrewChiefEventFamily, CrewChiefCapability> => capabilityMap(gameId);

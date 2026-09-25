import type { GameId } from "../../../shared/games/ids";
import {
  CREWCHIEF_AUTOMATIC_EVENTS,
  CREWCHIEF_EVENT_GROUPS,
  CREWCHIEF_EVENT_SOURCES,
  CREWCHIEF_SEMANTIC_GROUPS,
  type CrewChiefEventFamily,
} from "../../../shared/telemetry/live/crewchief-callout-contract";
import type { LiveResolvedSemanticFrame } from "../../telemetry/live-projector";
import type {
  CrewChiefTriggerBatchV1,
  CrewChiefTriggerDraftV1,
  CrewChiefTriggerEventV1,
  CrewChiefTriggerFunction,
  CrewChiefTriggerResultV1,
} from "./contracts";
import { createPreviousValueState, type PreviousValueState } from "./common";
import { CrewChiefTriggerFrame } from "./frame";
import { triggerTyreMonitor, triggerEngineMonitor, triggerDamageReporting } from "./car-health-triggers";
import { triggerConditionsMonitor } from "./conditions-triggers";
import { triggerFlagsMonitor, triggerOvertakingAidsMonitor, triggerPenalties } from "./race-control-triggers";
import { triggerFrozenOrderMonitor, triggerLapCounter, triggerPosition, triggerRaceTime, triggerSessionEndMessages } from "./session-triggers";
import { triggerSpotter } from "./spotter-trigger";
import { triggerBattery, triggerFuel, triggerPitStops, triggerPushNow, triggerStrategy } from "./strategy-triggers";
import { triggerDriverSwaps, triggerLapTimes, triggerMulticlassWarnings, triggerOpponents, triggerRatings, triggerTimings, triggerWatchedOpponents } from "./timing-opponent-triggers";

export type CrewChiefRequiredSemanticId = (typeof CREWCHIEF_SEMANTIC_GROUPS)[keyof typeof CREWCHIEF_SEMANTIC_GROUPS][number];
export type CapabilityState = "active" | "partial" | "unavailable";
export type CrewChiefImplementationStatus = "implemented" | "detector-not-implemented" | "renderer-unavailable" | "no-game-branch";
export interface CrewChiefCapability { state: CapabilityState; reasonCode?: string }
export interface CrewChiefTriggerCatalogOptions { allowUnsupportedGame?: boolean }
export interface CrewChiefSystemEvaluation {
  lifecycle: "unavailable" | "baseline" | "ready";
  reasonCode: string;
  dependencies: readonly {
    semanticId: string;
    state: LiveResolvedSemanticFrame["values"][number]["state"] | "not-requested";
    freshness: LiveResolvedSemanticFrame["values"][number]["freshness"] | "unknown";
    mappingStatus: string | null;
    limitations: readonly string[];
    shape: "scalar" | "array" | "missing" | "invalid";
    aligned: boolean | null;
  }[];
}
export interface CrewChiefTriggerDescriptor<S = unknown> {
  family: CrewChiefEventFamily;
  source: (typeof CREWCHIEF_EVENT_SOURCES)[string][number];
  requiredSemanticIds: readonly CrewChiefRequiredSemanticId[];
  requiredGroups: readonly string[];
  implementationStatus: CrewChiefImplementationStatus;
  requiredSemanticIdsByGame?: Partial<Record<GameId, readonly string[] | null>>;
  accParity?: CapabilityState;
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
  implementationStatus: CrewChiefImplementationStatus = "implemented",
  requiredSemanticIdsByGame?: Partial<Record<GameId, readonly string[] | null>>,
): CrewChiefTriggerDescriptor<PreviousValueState> => ({
  family,
  source: CREWCHIEF_EVENT_SOURCES[family]![0]!,
  requiredSemanticIds,
  requiredGroups: CREWCHIEF_EVENT_GROUPS[family],
  implementationStatus,
  ...(requiredSemanticIdsByGame ? { requiredSemanticIdsByGame } : {}),
  ...(accParity ? { accParity } : {}),
  ...(accReasonCode ? { accReasonCode } : {}),
  createState: createPreviousValueState,
  trigger,
});
const unavailable = (family: CrewChiefEventFamily, trigger: CrewChiefTriggerFunction<PreviousValueState>) =>
  descriptor(family, trigger, [], "unavailable", "no-source-backed-semantic-branch", "detector-not-implemented");

const implementedFor = (
  family: CrewChiefEventFamily,
  trigger: CrewChiefTriggerFunction<PreviousValueState>,
  games: Partial<Record<GameId, readonly string[]>>,
) => descriptor(family, trigger, [], "partial", undefined, "implemented", {
  "fm-2023": null, "f1-2025": null, acc: null, "ac-evo": null, iracing: null, ...games,
});
const ACC_FINISH_REQUIREMENTS = [
  "session.session-type", "race.is-race-on", "race.pit-status", "race.flag-status",
  "timing.session-time-remain", "timing.last-lap", "fuel.remaining-volume", "fuel.fuel-per-lap",
] as const;
const EVO_FINISH_REQUIREMENTS = [
  "session.session-type", "race.is-race-on", "race.pit-status", "race.flag-status", "race.is-timed-race",
  "timing.session-time-left-ms", "timing.last-lap", "timing.total-laps", "timing.lap-number", "fuel.laps-remaining",
] as const;

export const CREWCHIEF_TRIGGER_CATALOG = [
  descriptor("Position", triggerPosition, ["race.race-position", "identity.player-car-class-id", "race.competitor.car-class-id"], "partial", undefined, "implemented", {
    "f1-2025": ["race.race-position", "identity.player-car-class-id", "race.competitor.car-class-id"],
    "fm-2023": ["race.race-position"],
  }),
  descriptor("LapCounter", triggerLapCounter, ["session.session-state"], "partial", undefined, "implemented", {
    "f1-2025": ["timing.lap-number", "timing.total-laps"],
    "fm-2023": ["timing.lap-number"],
  }),
  implementedFor("Timings", triggerTimings, { acc: [
    "session.session-type", "session.session-state", "identity.player-car-index", "race.pit-status",
    "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.position",
    "race.competitor.pit-status", "race.competitor.connected", "timing.gap-ahead-ms", "timing.gap-behind-ms",
  ] }),
  descriptor("LapTimes", triggerLapTimes, ["timing.lap-number", "timing.last-lap", "timing.current-lap-valid", "race.pit-status"], "partial", undefined, "implemented", {
    "f1-2025": ["timing.lap-number", "timing.last-lap", "timing.current-lap-valid", "race.pit-status"],
    "fm-2023": ["timing.lap-number", "timing.last-lap"],
  }),
  descriptor("Opponents", triggerOpponents, ["race.competitor.car-index", "race.competitor.laps-complete"], "partial", undefined, "implemented", {
    "f1-2025": ["race.competitor.car-index", "race.competitor.laps-complete"],
  }),
  descriptor("Penalties", triggerPenalties, ["race.penalties"], "partial", undefined, "implemented", {
    "f1-2025": ["race.penalties"], acc: ["race.penalty-code"],
  }),
  descriptor("PitStops", triggerPitStops, ["race.pit-status"], "partial", undefined, "implemented", { "f1-2025": ["race.pit-status"] }),
  descriptor("Fuel", triggerFuel, ["fuel.remaining-volume", "fuel.fuel-per-lap"], "partial", undefined, "implemented", { "f1-2025": ["fuel.laps-remaining"] }),
  unavailable("Battery", triggerBattery),
  unavailable("WatchedOpponents", triggerWatchedOpponents),
  implementedFor("Strategy", triggerStrategy, { acc: ACC_FINISH_REQUIREMENTS, "ac-evo": EVO_FINISH_REQUIREMENTS }),
  implementedFor("RaceTime", triggerRaceTime, {
    acc: ["timing.session-time-remain", "race.is-race-on", "session.session-type"],
    "ac-evo": ["timing.session-time-left-ms", "race.is-timed-race", "race.is-race-on"],
  }),
  descriptor("TyreMonitor", triggerTyreMonitor, ["timing.lap-number", "timing.sector.current-index", "tire.temperature.core", "race.pit-status"], "partial", undefined, "implemented", {
    "f1-2025": ["timing.lap-number", "timing.sector.current-index", "tire.temperature.core", "race.pit-status"],
    "fm-2023": ["timing.lap-number", "tire.temperature.surface.representative"],
  }),
  descriptor("EngineMonitor", triggerEngineMonitor, ["engine.coolant-temperature", "race.pit-status"], "partial", undefined, "implemented", { "f1-2025": null }),
  descriptor("DamageReporting", triggerDamageReporting, ["damage.car-damage-front", "damage.car-damage-rear", "damage.car-damage-left", "damage.car-damage-right", "damage.car-damage-centre"], "partial", undefined, "implemented", {
    "f1-2025": ["damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage", "damage.floor-damage", "damage.diffuser-damage", "damage.sidepod-damage"],
  }),
  implementedFor("PushNow", triggerPushNow, { acc: ACC_FINISH_REQUIREMENTS, "ac-evo": EVO_FINISH_REQUIREMENTS }),
  descriptor("FlagsMonitor", triggerFlagsMonitor, ["race.flag-status", "race.pit-status", "session.session-state"], "partial", undefined, "implemented", {
    "f1-2025": ["race.flag-status", "race.pit-status"],
    acc: ["race.flag-status", "race.pit-status"],
    "ac-evo": ["race.flag-status", "race.pit-status"],
  }),
  descriptor("ConditionsMonitor", triggerConditionsMonitor, ["weather.rain-intensity"], "active", undefined, "implemented", {
    "f1-2025": ["weather.weather-type"], acc: ["weather.rain-intensity-code"],
  }),
  implementedFor("OvertakingAidsMonitor", triggerOvertakingAidsMonitor, {
    "ac-evo": ["aero.drs-active", "race.is-race-on", "session.session-type", "race.pit-status", "race.flag-status"],
  }),
  unavailable("FrozenOrderMonitor", triggerFrozenOrderMonitor),
  unavailable("Ratings", triggerRatings),
  descriptor("MulticlassWarnings", triggerMulticlassWarnings, [
    "identity.player-car-class-id", "motion.position-x", "motion.position-z", "motion.speed",
    "race.competitor.car-index", "race.competitor.connected", "race.competitor.pit-status", "race.competitor.car-class-id",
    "motion.competitor.position-x", "motion.competitor.position-z", "motion.competitor.speed",
  ], "partial", undefined, "implemented", { "f1-2025": null }),
  implementedFor("DriverSwaps", triggerDriverSwaps, {
    acc: ["race.competitor.car-index", "race.competitor.driver-id", "race.competitor.connected"],
  }),
  implementedFor("SessionEndMessages", triggerSessionEndMessages, { acc: ["session.session-state"] }),
  descriptor("Spotter", triggerSpotter, ["identity.car-left-right"], "active", undefined, "implemented", { "f1-2025": null }),
] as const satisfies readonly CrewChiefTriggerDescriptor<PreviousValueState>[];

if (new Set(CREWCHIEF_TRIGGER_CATALOG.map(({ family }) => family)).size !== 25 ||
    CREWCHIEF_TRIGGER_CATALOG.some(({ family }, index) => family !== [...CREWCHIEF_AUTOMATIC_EVENTS, "Spotter"][index])) {
  throw new Error("CrewChief trigger catalog membership mismatch");
}

const sessionTime = (frame: LiveResolvedSemanticFrame): number =>
  "milliseconds" in frame.observedAt ? frame.observedAt.milliseconds : Number(frame.observedAt.nanoseconds / 1_000_000n);
const normalize = (result: CrewChiefTriggerResultV1): readonly CrewChiefTriggerDraftV1[] =>
  result === null ? [] : "eventKey" in result ? [result] : result;
const dependencyShape = (value: LiveResolvedSemanticFrame["values"][number] | undefined): "scalar" | "array" | "missing" | "invalid" => {
  if (!value || value.state !== "ok" || value.value === null || value.value === undefined) return "missing";
  if (Array.isArray(value.value)) return value.value.every((item) => item === null || typeof item === "number" || typeof item === "string" || typeof item === "boolean") ? "array" : "invalid";
  return typeof value.value === "number" || typeof value.value === "string" || typeof value.value === "boolean" ? "scalar" : "invalid";
};
const reasonRank: readonly string[] = ["release-gate", "detector-not-implemented", "renderer-unavailable", "no-game-branch", "persisted-source-not-captured", "source-unavailable", "missing-executable-catalog-link", "semantic-not-projected", "error", "not-applicable", "invalid", "missing", "stale", "freshness-unknown", "semantic-shape-invalid", "semantic-array-misaligned"];
const chooseReason = (reasons: readonly string[]): string => [...reasons].sort((a, b) => {
  const left = reasonRank.indexOf(a);
  const right = reasonRank.indexOf(b);
  return (left < 0 ? 999 : left) - (right < 0 ? 999 : right);
})[0] ?? "semantic-not-projected";
export function gameRequirements(
  descriptor: CrewChiefTriggerDescriptor<any>,
  gameId: GameId,
): readonly string[] {
  const gameRequirements = descriptor.requiredSemanticIdsByGame?.[gameId];
  return gameRequirements ?? descriptor.requiredSemanticIds;
}
export function evaluateCrewChiefAvailability(
  descriptor: CrewChiefTriggerDescriptor<any>,
  frame: LiveResolvedSemanticFrame,
  gameId: GameId = frame.simulator,
): CrewChiefSystemEvaluation {
  const required = gameRequirements(descriptor, gameId);
  if (descriptor.implementationStatus !== "implemented") return { lifecycle: "unavailable", reasonCode: descriptor.implementationStatus, dependencies: [] };
  if (descriptor.accParity === "unavailable") return { lifecycle: "unavailable", reasonCode: "source-unavailable", dependencies: [] };
  const values = new Map(frame.ids.map((id, index) => [id, frame.values[index]]));
  const dependencies = required.map((semanticId) => {
    const value = values.get(semanticId);
    const shape = dependencyShape(value);
    const state: CrewChiefSystemEvaluation["dependencies"][number]["state"] = value?.state ?? "not-requested";
    const freshness: CrewChiefSystemEvaluation["dependencies"][number]["freshness"] = value?.freshness ?? "unknown";
    const aligned = shape === "array" ? (Array.isArray(value?.value) && value.value.length <= 64) : null;
    return { semanticId, state, freshness, mappingStatus: value?.mappingStatus ?? null, limitations: value?.limitations ?? [], shape, aligned };
  });
  const arrayLengths = dependencies.filter((dependency) => dependency.shape === "array").map((dependency) => {
    const value = values.get(dependency.semanticId)?.value;
    return Array.isArray(value) ? value.length : null;
  }).filter((length): length is number => length !== null);
  const alignedArrays = arrayLengths.length < 2 || new Set(arrayLengths).size === 1;
  const normalizedDependencies = alignedArrays ? dependencies : dependencies.map((dependency) => dependency.shape === "array" ? { ...dependency, aligned: false } : dependency);
  const reasons = normalizedDependencies.flatMap((dependency) => {
    if (dependency.state === "not-requested") return ["semantic-not-projected"];
    if (dependency.state !== "ok") return [dependency.state === "error" ? "error" : dependency.state];
    if (dependency.freshness !== "fresh") return [dependency.freshness === "unknown" ? "freshness-unknown" : "stale"];
    if (dependency.shape === "invalid" || dependency.shape === "missing") return ["semantic-shape-invalid"];
    if (dependency.aligned === false) return ["semantic-array-misaligned"];
    return [];
  });
  return { lifecycle: reasons.length ? "unavailable" : "ready", reasonCode: reasons.length ? chooseReason(reasons) : "ready", dependencies: normalizedDependencies };
}
const capabilityMap = (gameId: GameId, observed?: ReadonlyMap<string, boolean>, _allowUnsupportedGame = false): Record<CrewChiefEventFamily, CrewChiefCapability> =>
  Object.fromEntries(CREWCHIEF_TRIGGER_CATALOG.map((item) => {
    const required = gameRequirements(item, gameId);
    if (item.implementationStatus !== "implemented") {
      return [item.family, { state: "unavailable", reasonCode: item.implementationStatus === "detector-not-implemented" ? "detector-not-implemented" : item.implementationStatus }];
    }
    if (item.accParity === "unavailable") {
      return [item.family, { state: "unavailable", reasonCode: "source-unavailable" }];
    }
    if (!required.length) return [item.family, { state: "unavailable", reasonCode: "semantic-not-projected" }];
    if (observed && required.some((id) => observed.get(id) !== true)) {
      return [item.family, { state: "unavailable", reasonCode: "semantic-not-projected" }];
    }
    return [item.family, { state: "active", reasonCode: observed ? undefined : "semantic-not-projected" }];
  })) as Record<CrewChiefEventFamily, CrewChiefCapability>;
export class CrewChiefTriggerCatalog {
  private readonly options: CrewChiefTriggerCatalogOptions;
  private readonly states = new Map<CrewChiefEventFamily, PreviousValueState>(
    CREWCHIEF_TRIGGER_CATALOG.map((item) => [item.family, item.createState()]),
  );
  private readonly observed = new Map<string, boolean>();
  private readonly ready = new Map<CrewChiefEventFamily, boolean>();
  private streamKey = "";
  private observedGameId: GameId | null = null;
  private timelineEpoch = 0;
  constructor(options: CrewChiefTriggerCatalogOptions = {}) { this.options = options; }
  consume(source: LiveResolvedSemanticFrame): CrewChiefTriggerBatchV1 {
    const key = `${source.simulator}/${source.sessionId ?? ""}/${source.streamId}`;
    if (key !== this.streamKey) {
      this.streamKey = key;
      this.timelineEpoch += 1;
      this.observed.clear();
      this.ready.clear();
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
    const caps = capabilityMap(source.simulator, this.observed, this.options.allowUnsupportedGame);
    const drafts = CREWCHIEF_TRIGGER_CATALOG.flatMap((item) => {
      const capability = caps[item.family];
      const wasReady = this.ready.get(item.family) === true;
      const isReady = capability.state === "active";
      if (!isReady) {
        if (wasReady) this.states.set(item.family, item.createState());
        this.ready.set(item.family, false);
        return [];
      }
      if (!wasReady) {
        this.states.set(item.family, item.createState());
        this.ready.set(item.family, true);
        normalize(item.trigger({ frame, context, sessionTimeMs: now }, this.states.get(item.family)!));
        return [];
      }
      return normalize(item.trigger({ frame, context, sessionTimeMs: now }, this.states.get(item.family)!))
        .map((draft) => ({ ...draft, family: item.family }));
    });
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
    this.ready.clear();
    this.observedGameId = null;
    for (const item of CREWCHIEF_TRIGGER_CATALOG) this.states.set(item.family, item.createState());
  }
  capabilities(gameId: GameId): Record<CrewChiefEventFamily, CrewChiefCapability> {
    return capabilityMap(gameId, this.observedGameId === gameId ? this.observed : undefined, this.options.allowUnsupportedGame);
  }
}
export const capabilities = (gameId: GameId): Record<CrewChiefEventFamily, CrewChiefCapability> => capabilityMap(gameId);


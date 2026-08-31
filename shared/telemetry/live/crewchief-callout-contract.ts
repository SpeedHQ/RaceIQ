import type { TelemetryVariableId } from "../catalog/generated/telemetry-catalog.types";

export const CREWCHIEF_REFERENCE = {
  host: "gitlab.com",
  project: "mr_belowski/CrewChiefV4",
  commit: "97dc39c219b94de1099242fb8a5958869083603c",
} as const;

export type CrewChiefSourceRef = {
  host: typeof CREWCHIEF_REFERENCE.host;
  project: typeof CREWCHIEF_REFERENCE.project;
  commit: typeof CREWCHIEF_REFERENCE.commit;
  path: string;
  symbols: readonly string[];
};

export type RaceIQSourceRef = {
  path: string;
  symbols: readonly string[];
};

export type CrewChiefCoverageState =
  | {
      kind: "mapped";
      semanticId: TelemetryVariableId;
      parity: "crew-chief-native" | "source-equivalent";
      crewChiefSources: readonly CrewChiefSourceRef[];
      raceIqSources: readonly RaceIQSourceRef[];
    }
  | {
      kind: "source-unavailable";
      reasonCode: string;
      reason: string;
      crewChiefSources: readonly CrewChiefSourceRef[];
      raceIqEvidence?: readonly RaceIQSourceRef[];
    }
  | {
      kind: "not-applicable";
      reasonCode: string;
      reason: string;
      crewChiefSources?: readonly CrewChiefSourceRef[];
      raceIqEvidence?: readonly RaceIQSourceRef[];
    };

const ids = <const T extends readonly TelemetryVariableId[]>(...values: T) => values;

export const CREWCHIEF_SEMANTIC_GROUPS = {
  SESSION_TIMING: ids(
    "session.session-type", "session.session-state", "session.phase", "session.session-flags", "session.is-spectating",
    "timing.session-time-remain", "timing.session-time-total", "session.laps-remaining", "timing.lap-number",
    "timing.last-completed-lap-number", "timing.lap-fraction", "timing.current-lap-valid", "timing.last-lap",
    "timing.predicted-lap-time", "timing.sector.current-index", "timing.track-length", "race.race-position",
    "race.player-class-position",
  ),
  OPPONENT: ids(
    "identity.player-car-class-id", "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.driver-name", "race.competitor.car-class-id",
    "race.competitor.car-class-name", "race.competitor.class-position", "race.competitor.position", "race.competitor.laps-complete",
    "race.competitor.pit-status", "race.competitor.connected", "race.competitor.track-location", "race.competitor.track-surface-material",
    "timing.competitor.current-lap-number", "timing.competitor.current-lap-time", "timing.competitor.last-lap-time",
    "timing.competitor.last-lap-valid", "timing.competitor.best-lap-time", "timing.competitor.lap-fraction",
    "timing.competitor.gap-to-ahead", "timing.competitor.gap-to-leader", "timing.sector.competitor-last.s1",
    "timing.sector.competitor-last.s2", "timing.sector.competitor-last.s3",
  ),
  FLAGS_PENALTIES: ids(
    "race.flag-status", "race.safety-car-status", "session.session-flags", "race.incident-flags", "race.session-summary.caution-flags",
    "race.penalties", "race.player-incident-count", "race.driver-incident-count", "race.team-incident-count",
  ),
  SPATIAL_SPOTTER: ids(
    "identity.player-car-index", "identity.player-track-surface", "identity.car-left-right", "motion.position-x", "motion.position-y",
    "motion.position-z", "motion.velocity-x", "motion.velocity-y", "motion.velocity-z", "motion.speed", "motion.yaw",
    "motion.competitor.position-x", "motion.competitor.position-y", "motion.competitor.position-z", "motion.competitor.velocity-x",
    "motion.competitor.velocity-y", "motion.competitor.velocity-z", "motion.competitor.speed", "race.competitor.connected",
    "race.competitor.pit-status", "session.is-spectating",
  ),
  PITS_STRATEGY: ids(
    "race.pit-status", "race.on-pit-road", "race.player-car-in-pit-stall", "race.pit-speed-limit", "race.pits-open", "race.pitstop-active",
    "race.pit-lane-timer-active", "race.pit-stall-lap-fraction", "race.pit-service.status", "race.pit-service.flags",
    "race.pit-service.fuel-add-amount", "race.pit-service.mandatory-repair-time-remaining", "race.pit-service.optional-repair-time-remaining",
    "race.pit-service.tire-compound", "race.pit-service.tire-pressure", "timing.pit-stop-window-ideal-lap",
    "timing.pit-stop-window-latest-lap", "timing.pit-lane-time-in-lane-in-ms", "session.configuration.enforce-tire-compound-change",
  ),
  ENERGY: ids(
    "fuel.remaining-volume", "fuel.fuel-percent", "fuel.fuel-capacity", "fuel.fuel-per-lap", "fuel.fuel-liters-used", "fuel.laps-remaining",
    "fuel.ers-store-energy", "fuel.ers-deployed", "fuel.ers-harvested", "fuel.ers-deploy-mode", "engine.battery-voltage",
    "engine.battery-state-of-charge",
  ),
  TYRES_BRAKES: ids(
    "tires.tire-compound", "tires.tire-compound-code", "tires.tire-compound-name", "tires.tire-wear", "tires.tyre-age", "tires.tire-pressure",
    "tire.temperature.average", "tire.temperature.carcass.average", "tire.temperature.surface.inner", "tire.temperature.surface.middle",
    "tire.temperature.surface.outer", "brakes.brake-temp", "damage.brake-pad-wear", "damage.brake-disc-life", "tires.tire-sets-available",
    "tires.tire-sets-used", "tires.competitor.age", "tires.competitor.compound",
  ),
  DAMAGE_ENGINE: ids(
    "damage.engine-damage", "damage.brakes-damage", "damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage",
    "damage.floor-damage", "damage.diffuser-damage", "damage.sidepod-damage", "damage.car-damage-front", "damage.car-damage-rear",
    "damage.car-damage-left", "damage.car-damage-right", "damage.car-damage-centre", "damage.tyres-damage", "damage.drs-fault", "damage.ers-fault",
    "engine.current-engine-rpm", "engine.coolant-temperature", "engine.oil-temperature", "engine.oil-pressure", "engine.engine-temperature", "engine.exhaust-temp-c",
  ),
  CONDITIONS: ids("weather.air-temp", "weather.track-temp", "weather.track-wetness", "weather.rain-intensity", "weather.rain-percent", "weather.wind-speed", "weather.wind-direction", "weather.track-grip-status"),
  OVERTAKING_AIDS: ids("aero.drs-available", "aero.drs-active", "aero.drs-zone-approaching", "timing.drs-activation-distance", "race.player.push-to-pass-active", "race.player.push-to-pass-count"),
  DRIVER_TEAM_RATINGS: ids("identity.player-driver-id", "race.competitor.team-id", "race.competitor.team-name", "race.competitor.rating", "race.competitor.license-level", "race.competitor.license-name", "race.competitor.driver-incident-count", "race.competitor.team-incident-count", "session.driver-change-rule-set", "session.driver-change.drivers-used"),
} as const;

export const CREWCHIEF_AUTOMATIC_EVENTS = [
  "Position", "LapCounter", "Timings", "LapTimes", "Opponents", "Penalties", "PitStops", "Fuel", "Battery", "WatchedOpponents",
  "Strategy", "RaceTime", "TyreMonitor", "EngineMonitor", "DamageReporting", "PushNow", "FlagsMonitor", "ConditionsMonitor",
  "OvertakingAidsMonitor", "FrozenOrderMonitor", "Ratings", "MulticlassWarnings", "DriverSwaps", "SessionEndMessages",
] as const;

export type CrewChiefAutomaticEvent = (typeof CREWCHIEF_AUTOMATIC_EVENTS)[number];
export type CrewChiefEventFamily = CrewChiefAutomaticEvent | "Spotter";
export const CREWCHIEF_CALLOUT_SEMANTIC_IDS = Object.freeze(
  [...new Set(Object.values(CREWCHIEF_SEMANTIC_GROUPS).flat())],
) as readonly TelemetryVariableId[];
export const CREWCHIEF_EVENT_GROUPS = {
  Spotter: ["SESSION_TIMING", "OPPONENT", "SPATIAL_SPOTTER", "PITS_STRATEGY"],
  Position: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  LapCounter: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "CONDITIONS"],
  Timings: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  LapTimes: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  Opponents: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  Penalties: ["SESSION_TIMING", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  PitStops: ["SESSION_TIMING", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "TYRES_BRAKES"],
  Fuel: ["SESSION_TIMING", "ENERGY", "PITS_STRATEGY", "CONDITIONS", "SPATIAL_SPOTTER"],
  Battery: ["SESSION_TIMING", "ENERGY", "PITS_STRATEGY", "CONDITIONS", "SPATIAL_SPOTTER"],
  WatchedOpponents: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "CONDITIONS", "TYRES_BRAKES"],
  Strategy: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "TYRES_BRAKES", "CONDITIONS", "OVERTAKING_AIDS", "SPATIAL_SPOTTER"],
  PushNow: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY", "TYRES_BRAKES", "CONDITIONS", "OVERTAKING_AIDS", "SPATIAL_SPOTTER"],
  RaceTime: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "ENERGY"],
  TyreMonitor: ["SESSION_TIMING", "TYRES_BRAKES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  EngineMonitor: ["SESSION_TIMING", "DAMAGE_ENGINE", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  DamageReporting: ["SESSION_TIMING", "DAMAGE_ENGINE", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  FlagsMonitor: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  ConditionsMonitor: ["SESSION_TIMING", "CONDITIONS"],
  OvertakingAidsMonitor: ["SESSION_TIMING", "OPPONENT", "PITS_STRATEGY", "OVERTAKING_AIDS"],
  FrozenOrderMonitor: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  Ratings: ["SESSION_TIMING", "OPPONENT", "FLAGS_PENALTIES", "DRIVER_TEAM_RATINGS"],
  MulticlassWarnings: ["SESSION_TIMING", "OPPONENT", "PITS_STRATEGY", "SPATIAL_SPOTTER"],
  DriverSwaps: ["SESSION_TIMING", "PITS_STRATEGY", "DRIVER_TEAM_RATINGS"],
  SessionEndMessages: ["SESSION_TIMING"],
} as const;

export const CREWCHIEF_EVENT_SOURCES: Record<string, readonly CrewChiefSourceRef[]> = Object.fromEntries(
  ["CrewChief.cs::createListOfAllEvents", ...CREWCHIEF_AUTOMATIC_EVENTS].map((family) => {
    const isFactory = family === "CrewChief.cs::createListOfAllEvents";
    return [family, [{
      host: CREWCHIEF_REFERENCE.host,
      project: CREWCHIEF_REFERENCE.project,
      commit: CREWCHIEF_REFERENCE.commit,
      path: isFactory ? "CrewChiefV4/CrewChief.cs" : `CrewChiefV4/Events/${family}.cs`,
      symbols: [isFactory ? "createListOfAllEvents" : family === "SessionEndMessages" ? "trigger" : "triggerInternal"],
    }]];
  }),
);
CREWCHIEF_EVENT_SOURCES.Spotter = [{
  host: CREWCHIEF_REFERENCE.host,
  project: CREWCHIEF_REFERENCE.project,
  commit: CREWCHIEF_REFERENCE.commit,
  path: "CrewChiefV4/Events/Spotter.cs",
  symbols: ["trigger"],
}];

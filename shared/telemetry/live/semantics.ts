import type { GameId } from "../../games/ids";

export const LIVE_CORE_SEMANTIC_IDS = [
  "brakes.brake-temp", "engine.boost", "engine.current-engine-rpm", "engine.engine-idle-rpm", "engine.engine-max-rpm", "engine.power", "engine.torque",
  "fuel.fuel", "fuel.fuel-capacity", "identity.car-class", "identity.car-ordinal", "identity.car-performance-index", "identity.drivetrain-type", "identity.track-ordinal",
  "inputs.accel", "inputs.brake", "inputs.gear", "inputs.steer", "motion.acceleration-x", "motion.acceleration-z", "motion.pitch", "motion.position-x", "motion.position-z", "motion.roll", "motion.speed", "motion.yaw",
  "race.race-position", "suspension.norm-suspension-travel", "timing.best-lap", "timing.current-lap", "timing.distance-traveled", "timing.lap-number", "timing.last-lap", "tire.temperature.average", "tires.tire-combined-slip", "tires.tire-pressure", "tires.tire-slip-angle", "tires.tire-slip-ratio", "tires.tire-wear", "tires.wheel-in-puddle-depth", "tires.wheel-on-rumble-strip", "tires.wheel-rotation-speed", "weather.air-temp", "weather.track-temp", "weather.weather-type",
] as const;

export const LIVE_GAME_SEMANTIC_IDS = {
  "fm-2023": [],
  acc: ["damage.brake-pad-wear", "race.pit-status", "tires.tire-compound-name", "tires.tire-radius"],
  "ac-evo": ["damage.brake-pad-wear", "race.pit-status", "tires.tire-compound-name", "tires.tire-radius"],
  iracing: ["race.on-pit-road", "timing.lap-fraction"],
  "f1-2025": ["aero.drs-active", "aero.drs-available", "damage.diffuser-damage", "damage.floor-damage", "damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage", "damage.sidepod-damage", "fuel.ers-deploy-mode", "fuel.ers-deployed", "fuel.ers-harvested", "fuel.ers-store-energy", "race.competitor.driver-name", "race.competitor.pit-status", "race.competitor.pit-stops", "race.competitor.position", "session.session-type", "timing.competitor.gap-to-ahead", "timing.competitor.gap-to-leader", "timing.sector.competitor-last.s1", "timing.sector.competitor-last.s2", "timing.sector.competitor-last.s3", "timing.total-laps", "tires.competitor.age", "tires.competitor.compound", "tires.tire-compound", "weather.rain-percent"],
} as const;

export const LIVE_ENGINEER_PACE_SEMANTIC_IDS = [
  "identity.player-car-index", "identity.player-car-class-id", "identity.player-track-surface",
  "timing.lap-number", "timing.last-lap", "timing.current-lap-valid", "race.pit-status",
  "race.safety-car-status", "race.flag-status", "session.session-flags", "session.session-type",
  "race.competitor.car-index", "race.competitor.driver-id", "race.competitor.driver-name",
  "race.competitor.car-class-id", "race.competitor.car-class-name", "race.competitor.laps-complete",
  "race.competitor.pit-status", "race.competitor.track-location", "timing.competitor.last-lap-time",
  "timing.competitor.last-lap-valid",
] as const;

const LIVE_ENGINEER_SPOTTER_SEMANTIC_IDS: Record<GameId, readonly string[]> = {
  "fm-2023": [],
  acc: ["identity.player-car-index", "motion.position-x", "motion.position-z", "motion.speed", "motion.yaw", "race.pit-status", "race.competitor.car-index", "race.competitor.connected", "race.competitor.position-x", "race.competitor.position-z", "race.competitor.speed", "race.competitor.pit-status"],
  "ac-evo": [],
  iracing: ["identity.car-left-right"],
  "f1-2025": ["motion.position-x", "motion.position-z", "motion.speed", "motion.yaw", "race.pit-status", "race.safety-car-status", "race.flag-status", "session.session-flags", "race.competitor.car-index", "race.competitor.connected", "race.competitor.position-x", "race.competitor.position-z", "race.competitor.speed"],
};

export function liveEngineerRequiredSemanticIds(gameId: GameId): readonly string[] {
  return [...new Set([...LIVE_ENGINEER_PACE_SEMANTIC_IDS, ...LIVE_ENGINEER_SPOTTER_SEMANTIC_IDS[gameId]])];
}

export function liveSemanticIds(gameId: GameId): readonly string[] {
  return [...new Set([...LIVE_CORE_SEMANTIC_IDS, ...(LIVE_GAME_SEMANTIC_IDS[gameId] ?? [])])];
}

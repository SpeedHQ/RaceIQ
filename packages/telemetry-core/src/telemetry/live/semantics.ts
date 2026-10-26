import type { GameId } from "@raceiq/shared/games/ids";

export const LIVE_CORE_SEMANTIC_IDS = [
  "brakes.brake-temp", "engine.boost", "engine.current-engine-rpm", "engine.engine-idle-rpm", "engine.engine-max-rpm", "engine.power", "engine.torque",
  "fuel.fuel", "fuel.fuel-capacity", "identity.car-class", "identity.car-id", "identity.car-performance-index", "identity.drivetrain-type", "identity.track-id",
  "inputs.accel", "inputs.brake", "inputs.gear", "inputs.steer", "motion.acceleration-x", "motion.acceleration-z", "motion.pitch", "motion.position-x", "motion.position-z", "motion.roll", "motion.speed", "motion.yaw",
  "race.race-position", "suspension.norm-suspension-travel", "timing.best-lap", "timing.current-lap", "timing.distance-traveled", "timing.lap-number", "timing.last-lap", "tire.temperature.surface.representative", "tire.temperature.core", "tire.temperature.carcass.representative", "tires.tire-combined-slip", "tires.tire-pressure", "tires.tire-slip-angle", "tires.tire-slip-ratio", "tires.tire-wear", "tires.wheel-in-puddle-depth", "tires.wheel-on-rumble-strip", "tires.wheel-rotation-speed", "weather.air-temp", "weather.track-temp", "weather.weather-type",
] as const;

export const LIVE_GAME_SEMANTIC_IDS = {
  "fm-2023": [],
  ams2: ["race.on-pit-road", "session.session-type", "timing.track-length"],
  acc: ["damage.brake-pad-wear", "race.pit-status", "tires.tire-compound-name", "tires.tire-radius"],
  "ac-evo": ["damage.brake-pad-wear", "race.pit-status", "tires.tire-compound-name", "tires.tire-radius", "tire.temperature.surface.inner", "tire.temperature.surface.middle", "tire.temperature.surface.outer"],
  iracing: ["race.on-pit-road", "timing.lap-fraction", "inputs.clutch", "suspension.suspension-travel-m", "tire.temperature.carcass.left", "tire.temperature.carcass.middle", "tire.temperature.carcass.right"],
  lmu: [
    "identity.car-id", "identity.track-id", "race.on-pit-road", "session.session-type", "timing.lap-fraction",
    "tire.temperature.surface.inner", "tire.temperature.surface.middle", "tire.temperature.surface.outer",
    "fuel.battery-charge-fraction", "fuel.state-of-charge", "fuel.virtual-energy", "diagnostics.regen-kw",
    "engine.rpm", "engine.water-temperature", "engine.oil-temperature", "engine.ignition-starter", "engine.overheating",
    "hybrid.motor.rpm", "hybrid.motor.torque", "hybrid.motor.temperature", "hybrid.motor.water-temperature", "hybrid.motor.state",
    "steering.shaft-torque", "control.throttle", "control.brake", "control.steering", "control.clutch",
    "timing.gap.car-ahead", "timing.gap.car-behind", "timing.gap.place-ahead", "timing.gap.place-behind",
    "diagnostics.best-sector1", "diagnostics.best-sector2", "diagnostics.last-sector1", "diagnostics.last-sector2",
    "diagnostics.current-sector1", "diagnostics.current-sector2", "timing.sector.current-index",
    "weather.rain-intensity", "weather.cloud-coverage", "weather.cloud-darkness", "weather.minimum-path-wetness",
    "weather.maximum-path-wetness", "weather.average-path-wetness", "weather.wind",
    "race.scheduled-stops", "race.penalty-count", "race.pit-stop-count", "race.primary-flag", "race.under-yellow",
    "race.count-lap-flag", "race.in-garage-stall", "race.finish-status", "race.control", "race.yellow-flag-state",
    "race.sector-flags", "session.game-phase", "race.pit-state", "identity.track-limits-steps",
    "electronics.tc-active", "electronics.abs-active", "electronics.traction-control-level", "electronics.abs-level",
    "motion.speed-limiter-active", "diagnostics.rear-flap-activated", "race.rear-flap-legal-status",
    "electronics.motor-map", "electronics.tc-cut-level", "diagnostics.migration", "weather.track-grip-level",
  ],
  "f1-2025": ["aero.drs-active", "aero.drs-available", "damage.diffuser-damage", "damage.floor-damage", "damage.front-left-wing-damage", "damage.front-right-wing-damage", "damage.rear-wing-damage", "damage.sidepod-damage", "fuel.ers-deploy-mode", "fuel.ers-deployed", "fuel.ers-harvested", "fuel.ers-store-energy", "race.competitor.driver-name", "race.competitor.pit-status", "race.competitor.pit-stops", "race.competitor.position", "session.session-type", "timing.competitor.gap-to-ahead", "timing.competitor.gap-to-leader", "timing.sector.competitor-last.s1", "timing.sector.competitor-last.s2", "timing.sector.competitor-last.s3", "timing.total-laps", "tires.competitor.age", "tires.competitor.compound", "tires.tire-compound", "weather.rain-percent"],
} as const;

export function liveSemanticIds(gameId: GameId): readonly string[] {
  return [...new Set([...LIVE_CORE_SEMANTIC_IDS, ...(LIVE_GAME_SEMANTIC_IDS[gameId] ?? [])])];
}

// Extension aliases, descriptive metadata, and unavailable-source records.
import { SETUP_PARSER_SOURCE_MAPPINGS } from "../../shared/racing/setups/catalog/parser-source-mappings";
import { unavailable } from "./ast-discovery";
import type { AvailableLink, ExtensionMetadata, GameId, GameLink, UnavailableExtensionSource } from "./model";
import { GAME_IDS } from "./model";

const EXTENSION_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SETUP_PARSER_SOURCE_MAPPINGS).map(([path, mapping]) => [path, mapping.semanticId])),
  "f1.drsActivated": "aero.drs-active",
  "f1.ersStoreEnergy": "fuel.ers-store-energy",
  "f1.ersDeployMode": "fuel.ers-deploy-mode",
  "f1.ersDeployedThisLap": "fuel.ers-deployed",
  "f1.ersHarvestedThisLap": "fuel.ers-harvested",
  "f1.tyreCompound": "tires.tire-compound-name",
  "f1.tyreVisualCompound": "tires.tire-compound-code",
  "f1.trackLength": "timing.track-length",
  "f1.pitSpeedLimit": "race.pit-speed-limit",
  "f1.pitStatus": "race.player-pit-code",
  "f1.weather": "weather.weather-type",
  "f1.trackTemperature": "weather.track-temp",
  "f1.airTemperature": "weather.air-temp",
  "f1.rainPercentage": "weather.rain-percent",
  "f1.resultSource": "diagnostics.result-source",
  "f1.drsAllowed": "aero.drs-available",
  "f1.frontBrakeBias": "brakes.brake-bias",
  "f1.tractionControl": "electronics.traction-control-level",
  "f1.antiLockBrakes": "electronics.abs-level",
  "f1.fuelRemainingLaps": "fuel.laps-remaining",
  "f1.totalLaps": "timing.total-laps",
  "f1.currentLapInvalid": "timing.current-lap-valid",
  "f1.currentSector": "timing.sector.current-index",
  "f1.sector1Time": "timing.sector.current-lap.s1",
  "f1.sector2Time": "timing.sector.current-lap.s2",
  "f1.lastS1": "timing.sector.last-lap.s1",
  "f1.lastS2": "timing.sector.last-lap.s2",
  "f1.lastS3": "timing.sector.last-lap.s3",
  "f1.lapSectors.s1": "timing.sector.lap-history.s1",
  "f1.lapSectors.s2": "timing.sector.lap-history.s2",
  "f1.lapSectors.s3": "timing.sector.lap-history.s3",
  "f1.lapSectors.lapTime": "timing.sector.lap-history.lap-time",
  "f1.grid[].position": "race.competitor.position",
  "f1.grid[].driverId": "race.competitor.driver-id",
  "f1.grid[].teamId": "race.competitor.team-id",
  "f1.grid[].name": "race.competitor.driver-name",
  "f1.grid[].currentLapTime": "timing.competitor.current-lap-time",
  "f1.grid[].lastLapTime": "timing.competitor.last-lap-time",
  "f1.grid[].bestLapTime": "timing.competitor.best-lap-time",
  "f1.grid[].gapToLeader": "timing.competitor.gap-to-leader",
  "f1.grid[].gapToCarAhead": "timing.competitor.gap-to-ahead",
  "f1.grid[].pitStatus": "race.competitor.pit-status",
  "f1.grid[].numPitStops": "race.competitor.pit-stops",
  "f1.grid[].penalties": "race.competitor.penalties",
  "f1.grid[].tyreCompound": "tires.competitor.compound",
  "f1.grid[].tyreAge": "tires.competitor.age",
  "f1.grid[].bestS1": "timing.sector.competitor-best.s1",
  "f1.grid[].bestS2": "timing.sector.competitor-best.s2",
  "f1.grid[].bestS3": "timing.sector.competitor-best.s3",
  "f1.grid[].lastS1": "timing.sector.competitor-last.s1",
  "f1.grid[].lastS2": "timing.sector.competitor-last.s2",
  "f1.grid[].lastS3": "timing.sector.competitor-last.s3",
  "f1.brakeTemp": "brakes.brake-temp",
  "f1.tyrePressure": "tires.tire-pressure",
  "f1.tyresInnerTemp": "tire.temperature.carcass.average",
  "f1.motionEx.wheelLatForce": "tires.wheel-force.lateral",
  "f1.motionEx.wheelLongForce": "tires.wheel-force.longitudinal",
  "f1.motionEx.wheelVertForce": "tires.wheel-force.vertical",
  "f1.motionEx.wheelSlipAngle": "tires.tire-slip-angle",
  "f1.motionEx.wheelSpeed": "tires.wheel-linear-speed",
  "f1.motionEx.frontWheelsAngle": "inputs.front-wheel-angle",
  "f1.motionEx.heightOfCOGAboveGround": "suspension.cg-height",
  "f1.motionEx.frontAeroHeight": "aero.front-aero-height",
  "f1.motionEx.rearAeroHeight": "aero.rear-aero-height",
  "f1.motionEx.frontRollAngle": "motion.front-axle-roll-angle",
  "f1.motionEx.rearRollAngle": "motion.rear-axle-roll-angle",
  "f1.motionEx.chassisYaw": "motion.yaw",
  "f1.motionEx.chassisPitch": "motion.pitch",
  "acc.brakePadWear": "damage.brake-pad-wear",
  "acc.tireRadius": "tires.tire-radius",
  "acc.tireCamber": "tires.tire-camber",
  "acc.tireCoreTemp": "tire.temperature.carcass.average",
  "acc.tireMiddleTemp": "tire.temperature.surface.middle",
  "acc.tireOuterTemp": "tire.temperature.surface.outer",
  "acc.tireCompound": "tires.tire-compound-name",
  "acc.brakePadCompound": "setup.brakes.pad-compound",
  "acc.rideHeight": "suspension.ride-height",
  "acc.drsAvailable": "aero.drs-available",
  "acc.drsEnabled": "aero.drs-active",
  "acc.brakeBias": "brakes.brake-bias",
  "acc.tc": "electronics.traction-control-level",
  "acc.abs": "electronics.abs-level",
  "acc.engineMap": "engine.engine-map",
  "acc.airTempC": "weather.air-temp",
  "acc.roadTempC": "weather.track-temp",
  "acc.windSpeed": "weather.wind-speed",
  "acc.windDirection": "weather.wind-direction",
  "acc.acEvo.airTempC": "weather.air-temp",
  "acc.acEvo.roadTempC": "weather.track-temp",
  "acc.acEvo.tyreMiddleTempC": "tire.temperature.surface.middle",
  "acc.acEvo.isDrsOpen": "aero.drs-active",
  "acc.acEvo.engineMapLevel": "engine.engine-map",
  "acc.acEvo.fuelLitersPerLap": "fuel.fuel-per-lap",
  "acc.acEvo.fuelPercent": "fuel.fuel-percent",
  "acc.acEvo.lapsPossibleWithFuel": "fuel.laps-remaining",
  "acc.acEvo.waterTempC": "engine.coolant-temperature",
  "acc.acEvo.oilTempC": "engine.oil-temperature",
  "acc.acEvo.oilPressureBar": "engine.oil-pressure",
  "acc.acEvo.acEvoVersion": "diagnostics.sim-build-version",
  "acc.currentSectorIndex": "timing.sector.current-index",
  "acc.lastSectorTime": "timing.sector.last-completed-time",
  "acc.isValidLap": "timing.current-lap-valid",
  "acc.acEvo.timingIsInvalid": "timing.current-lap-valid",
  "acc.acEvo.sessionTotalLaps": "timing.total-laps",
  "acc.acEvo.sessionCurrentLap": "timing.lap-number",
  "acc.acEvo.lapLengthKm": "timing.track-length",
  "acc.acEvo.predictedLapTimeMs": "timing.predicted-lap-time",
  "acc.acEvo.idealLapTime": "timing.ideal-lap-time",
  "acc.acEvo.windSpeed": "weather.wind-speed",
  "acc.acEvo.windDirection": "weather.wind-direction",
  "iracing.trackLengthM": "timing.track-length",
  "iracing.lapDistanceM": "timing.distance-traveled",
  "iracing.driverCarIdx": "identity.player-car-index",
  "iracing.lapDistancePct": "timing.lap-fraction",
  "iracing.sdkCurrentLapTime": "timing.current-lap",
  "iracing.sectorStarts": "timing.sector.layout.start-fractions",
  "iracing.incidents": "race.incident-flags",
  "iracing.trackWetness": "weather.track-wetness",
};

const EXTENSION_METADATA: Record<string, Omit<ExtensionMetadata, "semanticId">> = {
  ...Object.fromEntries(
    Object.entries(SETUP_PARSER_SOURCE_MAPPINGS).map(([path, mapping]) => [
      path,
      {
        unit: mapping.nativeUnit,
        ...(mapping.kind ? { kind: mapping.kind } : {}),
        ...(mapping.normalization ? { normalization: mapping.normalization } : {}),
        freshness: "static" as const,
      },
    ]),
  ),
  "acc.brakePadWear": {
    unit: "mm",
    description: "Brake pad wear in millimetres, FL/FR/RL/RR.",
  },
  "acc.tireRadius": {
    unit: "m",
    description: "Tire radius in metres, FL/FR/RL/RR.",
    freshness: "static",
  },
  "f1.currentLapInvalid": {
    unit: "boolean",
    description: "Whether F1 has invalidated current lap.",
    kind: "normalized",
    normalization: "valid = currentLapInvalid === 0",
  },
  "f1.tyreCompound": {
    unit: "text",
    description: "F1 display name resolved from visual compound code.",
    kind: "normalized",
    normalization: "map F1 visual compound code to display name",
  },
  "f1.tyreVisualCompound": {
    unit: "id",
    description: "F1 visual tire-compound identifier.",
  },
  "f1.trackLength": {
    unit: "m",
    description: "F1 session packet track length.",
    freshness: "session-update",
  },
  "f1.pitStatus": {
    unit: "count",
    description: "Native player pit code: 0=none, 1=pitting, 2=pit area.",
  },
  "f1.pitSpeedLimit": {
    unit: "km/h",
    description: "F1 session packet pit-lane speed limit.",
  },
  "f1.fuelRemainingLaps": {
    unit: "count",
    description: "F1 estimated laps remaining at current fuel usage.",
  },
  "f1.resultSource": {
    unit: "enum",
    description: "Whether F1 result status comes from live lap data or final classification.",
  },
  "f1.tractionControl": {
    unit: "level",
    description: "F1 traction-control assist level.",
  },
  "f1.antiLockBrakes": {
    unit: "level",
    description: "F1 anti-lock-brake assist level.",
  },
  "f1.grid[].driverId": {
    unit: "id",
    description: "F1 participant identifier for each competitor.",
  },
  "f1.grid[].teamId": {
    unit: "id",
    description: "F1 team identifier for each competitor.",
  },
  "f1.grid[].pitStatus": {
    unit: "enum",
    description: "F1 pit-status code for each competitor.",
    kind: "normalized",
    normalization: "map F1 pit-status code to common pit-state enum",
  },
  "f1.grid[].tyreCompound": {
    unit: "text",
    description: "F1 display compound name for each competitor.",
  },
  "f1.motionEx.wheelLatForce": {
    unit: "N",
    description: "F1 per-wheel lateral force.",
  },
  "f1.motionEx.wheelLongForce": {
    unit: "N",
    description: "F1 per-wheel longitudinal force.",
  },
  "f1.motionEx.wheelVertForce": {
    unit: "N",
    description: "F1 per-wheel vertical force.",
  },
  "f1.motionEx.wheelSlipAngle": {
    unit: "rad",
    description: "F1 per-wheel tire slip angle.",
  },
  "f1.motionEx.wheelSpeed": {
    unit: "m/s",
    description: "F1 per-wheel linear speed.",
  },
  "f1.motionEx.frontWheelsAngle": {
    unit: "rad",
    description: "F1 front-wheel steering angle.",
  },
  "f1.motionEx.heightOfCOGAboveGround": {
    unit: "m",
    description: "F1 center-of-gravity height above ground.",
  },
  "f1.motionEx.frontAeroHeight": {
    unit: "m",
    description: "F1 front aerodynamic reference height.",
  },
  "f1.motionEx.rearAeroHeight": {
    unit: "m",
    description: "F1 rear aerodynamic reference height.",
  },
  "f1.motionEx.frontRollAngle": {
    unit: "rad",
    description: "F1 front axle roll angle.",
  },
  "f1.motionEx.rearRollAngle": {
    unit: "rad",
    description: "F1 rear axle roll angle.",
  },
  "f1.motionEx.chassisYaw": {
    unit: "rad",
    description: "F1 chassis yaw angle.",
  },
  "f1.motionEx.chassisPitch": {
    unit: "rad",
    description: "F1 chassis pitch angle.",
  },
  "f1.currentSector": {
    unit: "index",
    description: "F1 native 0-based current sector index.",
  },
  "f1.sector1Time": {
    unit: "s",
    description: "F1 native completed sector 1 time for current lap.",
  },
  "f1.sector2Time": {
    unit: "s",
    description: "F1 native completed sector 2 time for current lap.",
  },
  "f1.lastS1": {
    unit: "s",
    description: "Definitive sector 1 time from latest completed F1 lap.",
  },
  "f1.lastS2": {
    unit: "s",
    description: "Definitive sector 2 time from latest completed F1 lap.",
  },
  "f1.lastS3": {
    unit: "s",
    description: "Definitive sector 3 time from latest completed F1 lap.",
  },
  "f1.lapSectors.s1": {
    unit: "s",
    description: "F1 SessionHistory sector 1 time keyed by lap number.",
  },
  "f1.lapSectors.s2": {
    unit: "s",
    description: "F1 SessionHistory sector 2 time keyed by lap number.",
  },
  "f1.lapSectors.s3": {
    unit: "s",
    description: "F1 SessionHistory sector 3 time keyed by lap number.",
  },
  "f1.lapSectors.lapTime": {
    unit: "s",
    description: "F1 SessionHistory lap time keyed by lap number.",
  },
  "acc.currentSectorIndex": {
    unit: "index",
    description: "ACC native 0-based current sector index.",
  },
  "acc.brakePadCompound": {
    unit: "enum",
    description: "ACC brake-pad compound identifier.",
  },
  "acc.windSpeed": {
    unit: "m/s",
    description: "ACC wind speed in metres per second.",
  },
  "acc.lastSectorTime": {
    unit: "ms",
    description: "ACC native time for most recently completed sector.",
    kind: "normalized",
    normalization: "milliseconds / 1000",
  },
  "acc.isValidLap": {
    unit: "boolean",
    description: "Whether source considers current lap valid.",
  },
  "acc.acEvo.timingIsInvalid": {
    unit: "boolean",
    description: "Whether AC Evo timing state marks current lap invalid.",
    kind: "normalized",
    normalization: "valid = !timingIsInvalid",
  },
  "acc.acEvo.predictedLapTimeMs": {
    unit: "ms",
    description: "AC Evo predicted current-lap completion time.",
    kind: "normalized",
    normalization: "milliseconds / 1000",
  },
  "acc.acEvo.idealLapTime": {
    unit: "text",
    description: "AC Evo preformatted ideal-lap time.",
    kind: "normalized",
    normalization: "parse formatted duration as seconds",
  },
  "acc.acEvo.lapLengthKm": {
    unit: "km",
    description: "AC Evo current lap length.",
    kind: "normalized",
    normalization: "kilometres * 1000",
    freshness: "session-update",
  },
  "acc.acEvo.sessionCurrentLap": {
    unit: "count",
    description: "AC Evo current session lap number.",
  },
  "acc.acEvo.lapsPossibleWithFuel": {
    unit: "count",
    description: "AC Evo estimated laps possible with current fuel.",
  },
  "acc.windDirection": {
    unit: "deg",
    description: "ACC wind direction in degrees.",
  },
  "acc.acEvo.windDirection": {
    unit: "deg",
    description: "AC Evo wind direction in degrees.",
  },
  "iracing.trackLengthM": {
    unit: "m",
    description: "iRacing track length retained from session metadata.",
    freshness: "session-update",
  },
  "iracing.lapDistancePct": {
    unit: "fraction",
    description: "iRacing lap distance normalized to 0-1.",
  },
  "iracing.incidents": {
    unit: "flags",
    description: "iRacing player incident event flags retained by current source frame.",
  },
  "iracing.sectorStarts": {
    unit: "fraction",
    description: "Variable-length sector start fractions parsed from SessionInfo SplitTimeInfo.",
    freshness: "session-update",
  },
};

const UNAVAILABLE_EXTENSION_SOURCES: Partial<Record<GameId, Record<string, UnavailableExtensionSource>>> = {
  acc: {
    "acc.brakePadCompound": {
      reason: "parser-placeholder",
      description: "ACC parser currently emits constant 0; shared-memory source is not wired.",
    },
    "acc.rainIntensity": {
      reason: "parser-placeholder",
      description: "ACC parser currently emits constant 0; rain intensity source is not wired.",
    },
    "acc.trackGripStatus": {
      reason: "parser-placeholder",
      description: "ACC parser currently emits constant unknown; grip status source is not wired.",
    },
    "acc.drsAvailable": {
      reason: "parser-placeholder",
      description: "ACC parser currently emits constant false; DRS availability source is not wired.",
    },
    "acc.drsEnabled": {
      reason: "parser-placeholder",
      description: "ACC parser currently emits constant false; DRS state source is not wired.",
    },
  },
  "ac-evo": {
    "acc.tireInnerTemp": {
      reason: "source-not-populated",
      description: "AC Evo v0.6 reserves inner surface temperatures but current shared-memory pages report zero placeholders.",
    },
    "acc.tireMiddleTemp": {
      reason: "source-not-populated",
      description: "AC Evo v0.6 reserves middle surface temperatures but current shared-memory pages report zero placeholders.",
    },
    "acc.acEvo.tyreMiddleTempC": {
      reason: "source-not-populated",
      description: "AC Evo v0.6 native middle-temperature array currently mirrors zero placeholder offsets.",
    },
    "acc.tireOuterTemp": {
      reason: "source-not-populated",
      description: "AC Evo v0.6 reserves outer surface temperatures but current shared-memory pages report zero placeholders.",
    },
    "acc.rideHeight": {
      reason: "source-not-populated",
      description: "AC Evo v0.6 does not populate shared ACC ride-height field.",
    },
    "acc.tireRadius": {
      reason: "parser-placeholder",
      description: "AC Evo v0.6 parser emits zero tire radii because static page does not provide them.",
    },
    "acc.brakePadCompound": {
      reason: "parser-placeholder",
      description: "AC Evo parser currently emits constant 0; brake-pad compound source is not wired.",
    },
    "acc.rainIntensity": {
      reason: "parser-placeholder",
      description: "AC Evo parser currently emits constant 0; rain intensity source is not wired.",
    },
    "acc.trackGripStatus": {
      reason: "parser-placeholder",
      description: "AC Evo parser currently emits constant unknown; grip status source is not wired.",
    },
    "acc.windSpeed": {
      reason: "parser-placeholder",
      description: "AC Evo v0.6 shared ACC wind-speed field is a constant placeholder.",
    },
    "acc.windDirection": {
      reason: "parser-placeholder",
      description: "AC Evo v0.6 shared ACC wind-direction field is a constant placeholder.",
    },
    "acc.drsAvailable": {
      reason: "parser-placeholder",
      description: "AC Evo shared ACC DRS-availability field is a constant placeholder.",
    },
    "acc.drsEnabled": {
      reason: "parser-placeholder",
      description: "AC Evo shared ACC DRS-state field is a placeholder; use native acc.acEvo.isDrsOpen.",
    },
    "acc.currentSectorIndex": {
      reason: "parser-placeholder",
      description: "AC Evo v0.6 parser emits -1; native sector index is not populated.",
    },
    "acc.lastSectorTime": {
      reason: "parser-placeholder",
      description: "AC Evo v0.6 parser emits 0; native sector time is not populated.",
    },
  },
};

function unavailableExtensionSource(gameId: GameId, path: string): UnavailableExtensionSource | undefined {
  return UNAVAILABLE_EXTENSION_SOURCES[gameId]?.[path];
}

function extensionMetadata(path: string): ExtensionMetadata | undefined {
  const semanticId = EXTENSION_ALIASES[path] ?? EXTENSION_ALIASES[path.replace(/(FL|FR|RL|RR)$/, "")];
  if (!semanticId) return undefined;
  const metadata = EXTENSION_METADATA[path] ?? EXTENSION_METADATA[path.replace(/(FL|FR|RL|RR)$/, "")] ?? {};
  return { semanticId, ...metadata };
}

function extensionAlias(path: string): string | undefined {
  return extensionMetadata(path)?.semanticId;
}

function unavailableGames(description: string): Record<GameId, GameLink> {
  return Object.fromEntries(GAME_IDS.map((gameId) => [gameId, unavailable("source-not-provided", description)])) as Record<GameId, GameLink>;
}

function appendNormalization(link: AvailableLink, normalization: string): void {
  const parts = new Set(
    (link.normalization ?? "")
      .split("; ")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  parts.add(normalization);
  link.normalization = [...parts].join("; ");
}

export { appendNormalization, EXTENSION_ALIASES, EXTENSION_METADATA, extensionAlias, extensionMetadata, UNAVAILABLE_EXTENSION_SOURCES, unavailableExtensionSource, unavailableGames };

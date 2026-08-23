import type { GameId } from "../../../shared/games/ids";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import type { FreshnessState, ResolutionState } from "../../../shared/telemetry/resolver/contracts";

export type WheelValues<T> = Readonly<{ fl: T; fr: T; rl: T; rr: T }>;
export interface LiveCompetitorView {
  position?: number;
  name?: string;
  gapToAheadS?: number;
  gapToLeaderS?: number;
  tireCompound?: string | number;
  tireAge?: number;
  pitStatus?: number | boolean | string;
  pitStops?: number;
  lastS1S?: number;
  lastS2S?: number;
  lastS3S?: number;
}
export interface LiveTelemetryValueStatus {
  resolution: ResolutionState;
  freshness: FreshnessState;
}
export interface LiveTelemetryView {
  simulator: GameId;
  streamId: string;
  sessionId: number | null;
  sequence: number;
  observedAtMs: number;
  identity: { carOrdinal?: number; trackOrdinal?: number; carClass?: number; performanceIndex?: number; drivetrainType?: number };
  motion: {
    speedMps?: number;
    acceleration?: { x: number; z: number };
    position?: { x: number; z: number };
    attitude?: { roll: number; pitch: number; yaw: number };
    distanceM?: number;
  };
  inputs: { throttle?: number; brake?: number; steer?: number; gear?: number };
  engine: { rpm?: number; idleRpm?: number; maxRpm?: number; powerW?: number; torqueNm?: number; boost?: number };
  fuel: { amount?: number; capacity?: number };
  timing: {
    lapNumber?: number;
    currentLapS?: number;
    lastLapS?: number;
    bestLapS?: number;
    totalLaps?: number;
    lapFraction?: number;
    racePosition?: number;
  };
  tires: {
    temperatureC?: WheelValues<number>;
    wear?: WheelValues<number>;
    pressurePsi?: WheelValues<number>;
    slipAngleRad?: WheelValues<number>;
    slipRatio?: WheelValues<number>;
    combinedSlip?: WheelValues<number>;
    rotationRadS?: WheelValues<number>;
    suspensionNormalized?: WheelValues<number>;
    suspensionTravelM?: WheelValues<number>;
    brakeTemperatureC?: WheelValues<number>;
    brakePadRemainingMm?: WheelValues<number>;
    radiusM?: WheelValues<number>;
    surfaceRumble?: WheelValues<number>;
    puddleDepth?: WheelValues<number>;
    onRumbleStrip?: WheelValues<number>;
    compound?: string | number;
  };
  weather: { kind?: number; airTemperatureC?: number; trackTemperatureC?: number; rainPercent?: number };
  aero: { drsActive?: boolean; drsAvailable?: boolean };
  ers: { storeJ?: number; deployMode?: number; deployedThisLapJ?: number; harvestedThisLapJ?: number };
  damage: {
    frontLeftWingPct?: number;
    frontRightWingPct?: number;
    rearWingPct?: number;
    floorPct?: number;
    diffuserPct?: number;
    sidepodPct?: number;
  };
  session: { type?: number | string };
  competitors: readonly LiveCompetitorView[];
  statusBySemanticId: Readonly<Record<string, LiveTelemetryValueStatus>>;
}

type Indexed = { schema: LiveTelemetrySchemaMessageV1; indexes: Map<string, number> };
export function indexTelemetrySchema(schema: LiveTelemetrySchemaMessageV1): Indexed {
  return { schema, indexes: new Map(schema.definitions.map((definition, index) => [definition.semanticId, index])) };
}
export function readIndexedValue(indexed: Indexed, frame: LiveTelemetryFrameMessageV1, semanticId: string): unknown {
  if (frame.schemaId !== indexed.schema.schemaId) return undefined;
  const index = indexed.indexes.get(semanticId);
  if (index === undefined || frame.states?.[index] || frame.freshness?.[index]) return undefined;
  return frame.values[index] ?? undefined;
}
export function buildLiveTelemetryView(schema: LiveTelemetrySchemaMessageV1, frame: LiveTelemetryFrameMessageV1): LiveTelemetryView | undefined {
  if (frame.schemaId !== schema.schemaId) return undefined;
  const indexed = indexTelemetrySchema(schema);
  const value = (semanticId: string) => readIndexedValue(indexed, frame, semanticId);
  const number = (semanticId: string): number | undefined => {
    const candidate = value(semanticId);
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  };
  const boolean = (semanticId: string): boolean | undefined => {
    const candidate = value(semanticId);
    return typeof candidate === "boolean" ? candidate : undefined;
  };
  const numberOrString = (semanticId: string): number | string | undefined => {
    const candidate = value(semanticId);
    return typeof candidate === "string" || (typeof candidate === "number" && Number.isFinite(candidate)) ? candidate : undefined;
  };
  const wheel = (semanticId: string): WheelValues<number> | undefined => {
    const candidate = value(semanticId);
    if (!Array.isArray(candidate) || candidate.length < 4 || !candidate.slice(0, 4).every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
    return { fl: candidate[0] as number, fr: candidate[1] as number, rl: candidate[2] as number, rr: candidate[3] as number };
  };
  const wheelCelsius = (semanticId: string): WheelValues<number> | undefined => {
    const source = wheel(semanticId);
    if (!source) return undefined;
    const index = indexed.indexes.get(semanticId);
    const unit = index === undefined ? null : schema.definitions[index]?.unit?.toLowerCase();
    if (unit !== "°f" && unit !== "f" && unit !== "fahrenheit") return source;
    const celsius = (fahrenheit: number) => ((fahrenheit - 32) * 5) / 9;
    return {
      fl: celsius(source.fl),
      fr: celsius(source.fr),
      rl: celsius(source.rl),
      rr: celsius(source.rr),
    };
  };
  const vector = (xId: string, zId: string): { x: number; z: number } | undefined => {
    const x = number(xId);
    const z = number(zId);
    return x === undefined || z === undefined ? undefined : { x, z };
  };
  const attitude = (() => {
    const roll = number("motion.roll");
    const pitch = number("motion.pitch");
    const yaw = number("motion.yaw");
    return roll === undefined || pitch === undefined || yaw === undefined ? undefined : { roll, pitch, yaw };
  })();
  const statusBySemanticId: Record<string, LiveTelemetryValueStatus> = Object.fromEntries(
    schema.definitions.map((definition, index) => [
      definition.semanticId,
      {
        resolution: frame.states?.[index] ?? "ok",
        freshness: frame.freshness?.[index] ?? "fresh",
      },
    ]),
  );
  const competitorFields = [
    ["position", "race.competitor.position"],
    ["name", "race.competitor.driver-name"],
    ["gapToAheadS", "timing.competitor.gap-to-ahead"],
    ["gapToLeaderS", "timing.competitor.gap-to-leader"],
    ["tireCompound", "tires.competitor.compound"],
    ["tireAge", "tires.competitor.age"],
    ["pitStatus", "race.competitor.pit-status"],
    ["pitStops", "race.competitor.pit-stops"],
    ["lastS1S", "timing.sector.competitor-last.s1"],
    ["lastS2S", "timing.sector.competitor-last.s2"],
    ["lastS3S", "timing.sector.competitor-last.s3"],
  ] as const;
  const competitorArrays = competitorFields.map(([key, semanticId]) => [key, value(semanticId)] as const);
  const competitorCount = Math.max(0, ...competitorArrays.map(([, items]) => (Array.isArray(items) ? items.length : 0)));
  const competitors: LiveCompetitorView[] = [];
  for (let index = 0; index < competitorCount; index++) {
    const competitor: LiveCompetitorView = {};
    for (const [key, items] of competitorArrays) {
      if (Array.isArray(items) && items[index] !== undefined && items[index] !== null) {
        (competitor as Record<string, unknown>)[key] = items[index];
      }
    }
    competitors.push(competitor);
  }

  return {
    simulator: schema.simulator,
    streamId: frame.streamId,
    sessionId: frame.sessionId,
    sequence: frame.sequence,
    observedAtMs: frame.observedAt.milliseconds,
    identity: {
      carOrdinal: number("identity.car-ordinal"),
      trackOrdinal: number("identity.track-ordinal"),
      carClass: number("identity.car-class"),
      performanceIndex: number("identity.car-performance-index"),
      drivetrainType: number("identity.drivetrain-type"),
    },
    motion: {
      speedMps: number("motion.speed"),
      distanceM: number("timing.distance-traveled"),
      position: vector("motion.position-x", "motion.position-z"),
      acceleration: vector("motion.acceleration-x", "motion.acceleration-z"),
      attitude,
    },
    inputs: {
      throttle: number("inputs.accel"),
      brake: number("inputs.brake"),
      steer: number("inputs.steer"),
      gear: number("inputs.gear"),
    },
    engine: {
      rpm: number("engine.current-engine-rpm"),
      idleRpm: number("engine.engine-idle-rpm"),
      maxRpm: number("engine.engine-max-rpm"),
      powerW: number("engine.power"),
      torqueNm: number("engine.torque"),
      boost: number("engine.boost"),
    },
    fuel: {
      amount: number("fuel.fuel"),
      capacity: number("fuel.fuel-capacity"),
    },
    timing: {
      lapNumber: number("timing.lap-number"),
      currentLapS: number("timing.current-lap"),
      lastLapS: number("timing.last-lap"),
      bestLapS: number("timing.best-lap"),
      totalLaps: number("timing.total-laps"),
      lapFraction: number("timing.lap-fraction"),
      racePosition: number("race.race-position"),
    },
    tires: {
      temperatureC: wheelCelsius("tire.temperature.average"),
      wear: wheel("tires.tire-wear"),
      pressurePsi: wheel("tires.tire-pressure"),
      slipAngleRad: wheel("tires.tire-slip-angle"),
      slipRatio: wheel("tires.tire-slip-ratio"),
      combinedSlip: wheel("tires.tire-combined-slip"),
      rotationRadS: wheel("tires.wheel-rotation-speed"),
      suspensionNormalized: wheel("suspension.norm-suspension-travel"),
      suspensionTravelM: wheel("suspension.suspension-travel-m"),
      brakeTemperatureC: wheel("brakes.brake-temp"),
      brakePadRemainingMm: wheel("damage.brake-pad-wear"),
      radiusM: wheel("tires.tire-radius"),
      surfaceRumble: wheel("tires.surface-rumble"),
      puddleDepth: wheel("tires.wheel-in-puddle-depth"),
      onRumbleStrip: wheel("tires.wheel-on-rumble-strip"),
      compound: numberOrString("tires.tire-compound"),
    },
    weather: {
      kind: number("weather.weather-type"),
      airTemperatureC: number("weather.air-temp"),
      trackTemperatureC: number("weather.track-temp"),
      rainPercent: number("weather.rain-percent"),
    },
    aero: {
      drsActive: boolean("aero.drs-active"),
      drsAvailable: boolean("aero.drs-available"),
    },
    ers: {
      storeJ: number("fuel.ers-store-energy"),
      deployMode: number("fuel.ers-deploy-mode"),
      deployedThisLapJ: number("fuel.ers-deployed"),
      harvestedThisLapJ: number("fuel.ers-harvested"),
    },
    damage: {
      frontLeftWingPct: number("damage.front-left-wing-damage"),
      frontRightWingPct: number("damage.front-right-wing-damage"),
      rearWingPct: number("damage.rear-wing-damage"),
      floorPct: number("damage.floor-damage"),
      diffuserPct: number("damage.diffuser-damage"),
      sidepodPct: number("damage.sidepod-damage"),
    },
    session: { type: numberOrString("session.session-type") },
    competitors,
    statusBySemanticId,
  };
}

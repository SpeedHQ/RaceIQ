import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { resolve } from "node:path";
import { IRACING_SESSION_INFO_CATALOG_FIELDS } from "../shared/games/iracing/session-info/catalog";
import { IRACING_SESSION_INFO_RAW_SOURCE } from "../shared/games/iracing/session-info/contracts";
import { getSchemaForGame } from "../shared/setups/schema";
import { SETUP_GROUP_DEFINITIONS } from "../shared/setups/catalog/groups";
import { SETUP_CONCEPT_DEFINITIONS } from "../shared/setups/catalog/concepts";
import { SETUP_FILE_SOURCE_MAPPINGS } from "../shared/setups/catalog/file-source-mappings";
import { SETUP_PARSER_SOURCE_MAPPINGS } from "../shared/setups/catalog/parser-source-mappings";
import {
  assertIRacingSessionInfoCaptureCoverage,
  readIRacingSessionInfoCaptures,
} from "./iracing-session-info-capture";

const IRACING_SESSION_INFO_SOURCE_FILES = [
  "shared/games/iracing/session-info/catalog.ts",
  "shared/games/iracing/session-info/contracts.ts",
  "shared/games/iracing/session-info/formatting.ts",
  "shared/games/iracing/session-info/sections.ts",
  "shared/games/iracing/session-info/setup-aero-drivetrain.ts",
  "shared/games/iracing/session-info/setup-builders.ts",
  "shared/games/iracing/session-info/setup-captured.ts",
  "shared/games/iracing/session-info/setup-chassis.ts",
  "shared/games/iracing/session-info/setup-in-car.ts",
  "shared/games/iracing/session-info/setup-tires.ts",
] as const;

const GAME_IDS = [
  "fm-2023",
  "f1-2025",
  "acc",
  "ac-evo",
  "iracing",
] as const;
type GameId = (typeof GAME_IDS)[number];

// Babel's public parser result is a large discriminated union. Generator only
// needs generic traversal and a small set of well-known node properties.
// biome-ignore lint/suspicious/noExplicitAny: generic AST traversal is clearer with Babel's runtime node shape
type AstNode = Record<string, any>;

interface SourceVariable {
  path: string;
  label: string;
  unit: string;
  dataType?: string;
  count?: number;
  description: string;
  semanticId: string;
  sourceKind: "packet" | "extension" | "sdk" | "yaml" | "setup";
  recordedByRaceIQ: boolean;
  retention: "exact" | "normalized" | "not-recorded";
}

type ValueType =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "structured";

type ValueCardinality =
  | { kind: "scalar" }
  | { kind: "fixed"; count: number }
  | { kind: "variable"; min: number; max?: number };

interface StructuredIndexSchema {
  id: string;
  cardinality: ValueCardinality;
  ordering: "numeric-ascending" | "source-order" | "semantic-order";
}

interface StructuredFieldSchema {
  id: string;
  valueType: Exclude<ValueType, "structured">;
  dimensions: readonly string[];
  enumDomain?: readonly string[];
}

interface StructuredValueSchema {
  indices: readonly StructuredIndexSchema[];
  fields: readonly StructuredFieldSchema[];
}

interface MappingExecution {
  kind: "conversion" | "derivation" | "simplification";
  id: string;
  version: string;
  codeHash: string;
  deterministic: boolean;
  declaredInputs: readonly string[];
  missingDataPolicy: "propagate-missing" | "drop-missing" | "require-all";
}

interface MappingProvenance {
  origin:
    | "parser"
    | "projection"
    | "schema"
    | "yaml"
    | "derivation";
  artifact: string;
  commit: string;
}

interface CompatibilityReview {
  id: string;
  rationale: string;
}

interface AvailableLink {
  kind: "direct" | "normalized" | "derived" | "simplified";
  nativeUnit: string;
  sources: string[] | Record<string, string[]>;
  freshness: "continuous" | "pit-snapshot" | "session-update" | "static";
  normalization?: string;
  description: string;
  limitations?: readonly string[];
  provenance?: MappingProvenance;
  execution?: MappingExecution;
  compatibilityReview?: CompatibilityReview;
}

interface UnavailableLink {
  kind: "unavailable";
  reason:
    | "source-not-provided"
    | "parser-placeholder"
    | "source-not-populated"
    | "not-applicable";
  description: string;
}

type GameLink = AvailableLink | UnavailableLink;

interface CatalogGroup {
  id: string;
  label: string;
  description: string;
  parentId?: string;
  canonicalUnit?: string;
  children: string[];
}

interface CatalogVariable {
  id: string;
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  valueType?: ValueType;
  dimensions?: readonly string[];
  cardinality?: ValueCardinality;
  ordering?: readonly string[];
  range?: {
    min: number;
    max: number;
  };
  enumDomain?: readonly string[];
  structuredSchema?: StructuredValueSchema;
  limitations?: readonly string[];
  shape: "scalar" | "per-wheel" | "vector" | "array" | "structured";
  packetFields?: string[];
  games: Record<GameId, GameLink>;
}

interface CatalogMetadata {
  catalogVersion: string;
  schemaVersion: string;
  generator: {
    name: string;
    version: string;
    commit: string;
  };
  generatedAt: string;
  contentHash: string;
}

export interface BuiltTelemetryCatalog {
  format: "raceiq-semantic-telemetry-catalog-v6";
  metadata: CatalogMetadata;
  generatedFrom: readonly string[];
  groups: readonly CatalogGroup[];
  variables: readonly CatalogVariable[];
  sources: Record<GameId, readonly SourceVariable[]>;
  coverage: {
    normalizedPacketFields: number;
    semanticVariables: number;
    sourceCounts: Record<
      GameId,
      {
        total: number;
        packet: number;
        extension: number;
        sdk: number;
        yaml: number;
        setup: number;
        recorded: number;
      }
    >;
  };
}

interface FieldInfo {
  name: string;
  type: string;
  description?: string;
}

interface ExtensionFieldSet {
  key: string;
  semanticKey: string;
  paths: string[];
  type: string;
  description?: string;
  shape: CatalogVariable["shape"];
  wheelPaths?: Record<string, string>;
}

interface SemanticDefinition {
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  shape: CatalogVariable["shape"];
  valueType?: ValueType;
  dimensions?: readonly string[];
  cardinality?: ValueCardinality;
  ordering?: readonly string[];
  range?: { min: number; max: number };
  enumDomain?: readonly string[];
  limitations?: readonly string[];
}

interface ExtensionMetadata {
  semanticId: string;
  unit?: string;
  description?: string;
  kind?: AvailableLink["kind"];
  normalization?: string;
  freshness?: AvailableLink["freshness"];
}

interface UnavailableExtensionSource {
  reason: UnavailableLink["reason"];
  description: string;
}

interface FieldSet {
  key: string;
  fields: string[];
  shape: CatalogVariable["shape"];
  wheelFields?: Record<string, string>;
}

interface ParserOutput {
  source: string;
  properties: Map<string, AstNode>;
  variables: Map<string, AstNode>;
}

function semanticDefinition(
  label: string,
  description: string,
  parentId: string,
  canonicalUnit: string,
  shape: SemanticDefinition["shape"] = "scalar",
): SemanticDefinition {
  return { label, description, parentId, canonicalUnit, shape };
}

const ROOT = resolve(import.meta.dirname, "..");
const TELEMETRY_TYPE_SOURCE_FILES = [
  "shared/telemetry/types.ts",
  "shared/telemetry/f1-2025.ts",
  "shared/telemetry/kunos.ts",
  "shared/telemetry/iracing.ts",
] as const;
const GENERATED_OUTPUT_DIRECTORY = resolve(
  ROOT,
  "shared/telemetry/catalog/generated",
);
const OUTPUT_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "telemetry-catalog.generated.json",
);
const OUTPUT_TS_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "telemetry-catalog.generated.ts",
);
const OUTPUT_MARKDOWN_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "TELEMETRY_CATALOG.md",
);
const OUTPUT_MATRIX_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "telemetry-catalog-matrix.md",
);
const IRACING_DIAGNOSTIC = resolve(
  ROOT,
  "data/diagnostics/iracing-all-vars-2026-07-29T02-06-39-162Z.json",
);
const IRACING_SESSION_INFO_CAPTURE_DIRECTORY = resolve(
  ROOT,
  "data/diagnostics/iracing-session-info",
);
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const PACKAGE_VERSION = JSON.parse(
  await Bun.file(PACKAGE_JSON_PATH).text(),
).version as string;
const GENERATOR_NAME = "RaceIQ telemetry-catalog generator";
const CATALOG_FORMAT = "raceiq-semantic-telemetry-catalog-v6";
const CATALOG_SCHEMA_VERSION = "v6";
const DERIVATION_VERSION = `${PACKAGE_VERSION}`;

const PARSER_FILES: Record<GameId, string> = {
  "fm-2023": "server/games/fm-2023/parser.ts",
  "f1-2025": "server/games/f1-2025/f1-state.ts",
  acc: "server/games/acc/parser.ts",
  "ac-evo": "server/games/ac-evo/parser.ts",
  iracing: "server/games/iracing/normalizer.ts",
};

const CATEGORY_META: Record<string, [string, string]> = {
  session: ["Session", "Session identity, state, and elapsed-time values."],
  timing: ["Timing", "Lap, sector, delta, and race-timing values."],
  engine: ["Engine", "Engine speed, output, temperature, and health values."],
  motion: ["Vehicle motion", "Position, velocity, acceleration, and attitude values."],
  inputs: ["Driver inputs", "Driver control inputs and requested control positions."],
  tires: ["Tires", "Tire temperature, pressure, wear, slip, and contact values."],
  suspension: ["Suspension", "Suspension position, travel, load, and geometry values."],
  brakes: ["Brakes", "Brake input, temperature, wear, balance, and intervention values."],
  fuel: ["Fuel and energy", "Fuel, hybrid energy, economy, and deployment values."],
  weather: ["Weather and track", "Ambient weather, track surface, and grip values."],
  identity: ["Vehicle and track identity", "Car, class, drivetrain, and track identity values."],
  race: ["Race control", "Position, flags, pits, penalties, and race-control values."],
  damage: ["Damage and wear", "Vehicle component damage, faults, and remaining-life values."],
  aero: ["Aerodynamics", "Aerodynamic devices, ride heights, and aero-state values."],
  electronics: ["Electronics", "Driver aids, maps, limiters, and electronic intervention values."],
  setup: ["Car setup", "Static or adjustable vehicle setup values."],
  diagnostics: ["Diagnostics", "Source identity, packet counters, and diagnostic values."],
};

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  IsRaceOn: "Whether source considers vehicle actively driving.",
  TimestampMS: "Source timestamp for telemetry frame.",
  CurrentEngineRpm: "Current engine crankshaft speed.",
  EngineMaxRpm: "Current or configured engine speed limit.",
  EngineIdleRpm: "Nominal engine idle speed.",
  AccelerationX: "Vehicle lateral acceleration on RaceIQ X axis.",
  AccelerationY: "Vehicle vertical acceleration on RaceIQ Y axis.",
  AccelerationZ: "Vehicle longitudinal acceleration on RaceIQ Z axis.",
  VelocityX: "Vehicle velocity on RaceIQ X axis.",
  VelocityY: "Vehicle velocity on RaceIQ Y axis.",
  VelocityZ: "Vehicle velocity on RaceIQ Z axis.",
  AngularVelocityX: "Vehicle pitch rate around RaceIQ X axis.",
  AngularVelocityY: "Vehicle yaw rate around RaceIQ Y axis.",
  AngularVelocityZ: "Vehicle roll rate around RaceIQ Z axis.",
  Yaw: "Vehicle heading angle around vertical axis.",
  Pitch: "Vehicle nose-up or nose-down angle.",
  Roll: "Vehicle body roll angle.",
  Speed: "Vehicle ground speed.",
  Boost: "Current forced-induction boost pressure.",
  Power: "Current combined vehicle power output.",
  Torque: "Current engine or driveline torque.",
  Fuel: "Current fuel amount in game-native packet representation.",
  FuelCapacity: "Source-provided fuel tank capacity.",
  DistanceTraveled: "Distance traveled on current lap or session as defined by source.",
  BestLap: "Best completed lap time.",
  LastLap: "Most recently completed lap time.",
  CurrentLap: "Current lap elapsed time.",
  CurrentRaceTime: "Elapsed session or race time.",
  LapNumber: "Current displayed lap number.",
  RacePosition: "Current race position.",
  Accel: "Accelerator input on RaceIQ's 0–255 control scale.",
  Brake: "Brake input on RaceIQ's 0–255 control scale.",
  Clutch: "Clutch input on RaceIQ's 0–255 control scale.",
  HandBrake: "Handbrake input on RaceIQ's 0–255 control scale.",
  Gear: "Current normalized gear index.",
  NormDrivingLine: "Driving-line assistance value on RaceIQ's signed control scale.",
  NormAIBrakeDiff: "AI braking-difference value on RaceIQ's signed control scale.",
  Steer: "Steering input on RaceIQ's signed -128–127 scale.",
  PositionX: "Vehicle world position on RaceIQ X axis.",
  PositionY: "Vehicle world position on RaceIQ Y axis.",
  PositionZ: "Vehicle world position on RaceIQ Z axis.",
  DrsActive: "Whether drag-reduction-system flap is currently open.",
  ErsStoreEnergy: "Current stored energy in ERS battery.",
  ErsDeployMode: "Current ERS deployment mode.",
  ErsDeployed: "ERS energy deployed during current lap.",
  ErsHarvested: "ERS energy harvested during current lap.",
  WeatherType: "Source weather-condition category.",
  TrackTemp: "Current track-surface temperature.",
  AirTemp: "Current ambient air temperature.",
  RainPercent: "Current precipitation percentage.",
  CarOrdinal: "Source vehicle model identifier.",
  CarClass: "Source vehicle-class identifier.",
  CarPerformanceIndex: "Source vehicle performance rating.",
  DrivetrainType: "Driven-axle layout: front-, rear-, or all-wheel drive.",
  NumCylinders: "Engine cylinder count.",
  TrackOrdinal: "Source track or layout identifier.",
  WheelRotationSpeed: "Wheel angular velocity.",
  TireSlipRatio: "Per-wheel longitudinal tire slip ratio.",
  TireWear: "Per-wheel consumed tire-wear fraction, where 0 is new and 1 is fully worn.",
  TireCombinedSlip: "Combined tire slip magnitude.",
  TireSlipCombinedFL_2: "Additional front-left combined tire-slip channel; source protocol does not document its relationship to primary combined slip.",
  SurfaceRumble: "Force-feedback surface-rumble intensity.",
};

const TIRE_IDS: Record<string, [string, string, string]> = {
  TireTemp: [
    "tire.temperature.average",
    "tire.temperature",
    "Representative / average",
  ],
  TireCarcassTemp: [
    "tire.temperature.carcass.average",
    "tire.temperature.carcass",
    "Average carcass temperature",
  ],
  TireCarcassTempLeft: [
    "tire.temperature.carcass.left",
    "tire.temperature.carcass",
    "Left carcass temperature",
  ],
  TireCarcassTempMiddle: [
    "tire.temperature.carcass.middle",
    "tire.temperature.carcass",
    "Middle carcass temperature",
  ],
  TireCarcassTempRight: [
    "tire.temperature.carcass.right",
    "tire.temperature.carcass",
    "Right carcass temperature",
  ],
  TireSurfaceTempInner: [
    "tire.temperature.surface.inner",
    "tire.temperature.surface",
    "Inner surface temperature",
  ],
  TireSurfaceTempMiddle: [
    "tire.temperature.surface.middle",
    "tire.temperature.surface",
    "Middle surface temperature",
  ],
  TireSurfaceTempOuter: [
    "tire.temperature.surface.outer",
    "tire.temperature.surface",
    "Outer surface temperature",
  ],
};

const SEMANTIC_DEFINITIONS: Record<string, SemanticDefinition> = {
  ...SETUP_CONCEPT_DEFINITIONS,
  "aero.drs-active": {
    label: "DRS active",
    description: "Whether drag-reduction flap is currently open.",
    parentId: "aero",
    canonicalUnit: "boolean",
    shape: "scalar",
  },
  "aero.drs-available": {
    label: "DRS available",
    description: "Whether source currently permits DRS activation.",
    parentId: "aero",
    canonicalUnit: "boolean",
    shape: "scalar",
  },
  "aero.front-aero-height": {
    label: "Front aero height",
    description: "Live front aerodynamic reference height above ground.",
    parentId: "aero",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "aero.rear-aero-height": {
    label: "Rear aero height",
    description: "Live rear aerodynamic reference height above ground.",
    parentId: "aero",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "motion.front-axle-roll-angle": {
    label: "Front axle roll angle",
    description: "Live roll angle measured across front axle.",
    parentId: "motion",
    canonicalUnit: "rad",
    shape: "scalar",
  },
  "motion.rear-axle-roll-angle": {
    label: "Rear axle roll angle",
    description: "Live roll angle measured across rear axle.",
    parentId: "motion",
    canonicalUnit: "rad",
    shape: "scalar",
  },
  "brakes.brake-bias": {
    label: "Front brake bias",
    description: "Current front-axle brake bias.",
    parentId: "brakes",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "electronics.traction-control-level": {
    label: "Traction-control level",
    description: "Current driver-selected traction-control setting.",
    parentId: "electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "electronics.abs-level": {
    label: "ABS level",
    description: "Current driver-selected anti-lock braking setting.",
    parentId: "electronics",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "engine.engine-map": {
    label: "Engine map",
    description: "Current driver-selected engine map.",
    parentId: "engine",
    canonicalUnit: "level",
    shape: "scalar",
  },
  "engine.coolant-temperature": {
    label: "Coolant temperature",
    description: "Engine coolant or water temperature.",
    parentId: "engine",
    canonicalUnit: "°C",
    shape: "scalar",
  },
  "engine.oil-temperature": {
    label: "Oil temperature",
    description: "Current engine oil temperature.",
    parentId: "engine",
    canonicalUnit: "°C",
    shape: "scalar",
  },
  "engine.oil-pressure": {
    label: "Oil pressure",
    description: "Current engine oil pressure.",
    parentId: "engine",
    canonicalUnit: "bar",
    shape: "scalar",
  },
  "engine.cylinder-count": {
    label: "Engine cylinder count",
    description: "Number of engine cylinders.",
    parentId: "engine",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "engine.shift-light.first-rpm": {
    label: "Shift-light first RPM",
    description: "Engine speed where first shift-light indicator illuminates.",
    parentId: "engine.shift-light",
    canonicalUnit: "rpm",
    shape: "scalar",
  },
  "engine.shift-light.shift-rpm": {
    label: "Shift-light target RPM",
    description: "Engine speed for primary upshift indication.",
    parentId: "engine.shift-light",
    canonicalUnit: "rpm",
    shape: "scalar",
  },
  "engine.shift-light.last-rpm": {
    label: "Shift-light last RPM",
    description: "Engine speed where final steady shift-light indicator illuminates.",
    parentId: "engine.shift-light",
    canonicalUnit: "rpm",
    shape: "scalar",
  },
  "engine.shift-light.blink-rpm": {
    label: "Shift-light blink RPM",
    description: "Engine speed where shift lights begin blinking.",
    parentId: "engine.shift-light",
    canonicalUnit: "rpm",
    shape: "scalar",
  },
  "suspension.ride-height": {
    label: "Live ride height",
    description:
      "Measured front/rear or per-corner ride height while vehicle is running.",
    parentId: "suspension",
    canonicalUnit: "m",
    shape: "array",
  },
  "diagnostics.sim-build-version": {
    label: "Simulator build version",
    description: "Source simulator build or telemetry protocol version.",
    parentId: "diagnostics",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "fuel.fuel-percent": {
    label: "Fuel remaining percentage",
    description: "Fuel remaining as percentage of usable capacity.",
    parentId: "fuel",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "fuel.remaining-volume": {
    label: "Fuel remaining volume",
    description: "Current usable fuel volume.",
    parentId: "fuel",
    canonicalUnit: "L",
    shape: "scalar",
  },
  "fuel.density": {
    label: "Fuel density",
    description: "Fuel mass per unit volume.",
    parentId: "fuel",
    canonicalUnit: "kg/L",
    shape: "scalar",
  },
  "fuel.maximum-fill-percentage": {
    label: "Maximum fuel fill percentage",
    description: "Maximum allowed fuel fill as percentage of tank capacity.",
    parentId: "fuel",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "fuel.fuel": {
    label: "RaceIQ packet fuel value",
    description: "Normalized packet field whose legacy unit differs by game; use fuel volume or percentage semantic values for comparison.",
    parentId: "fuel",
    canonicalUnit: "game-native",
    shape: "scalar",
  },
  "fuel.laps-remaining": {
    label: "Fuel laps remaining",
    description: "Source estimate of laps possible with current fuel.",
    parentId: "fuel",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "tires.tire-compound": {
    label: "Tire compound",
    description: "Current player tire compound in RaceIQ's common representation.",
    parentId: "tires",
    canonicalUnit: "enum",
    shape: "scalar",
  },
  "tires.tire-compound-name": {
    label: "Tire compound name",
    description: "Source display name for current player tire compound.",
    parentId: "tires",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "tires.tire-compound-code": {
    label: "Tire compound code",
    description: "Source numeric identifier for current player tire compound.",
    parentId: "tires",
    canonicalUnit: "id",
    shape: "scalar",
  },
  "identity.track-name": {
    label: "Track name",
    description: "Source-provided display name for current track configuration.",
    parentId: "identity.track",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "identity.track.configuration-name": {
    label: "Track configuration name",
    description: "Source display name for current track layout or configuration.",
    parentId: "identity.track",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "identity.track.altitude": {
    label: "Track altitude",
    description: "Track elevation above sea level.",
    parentId: "identity.track",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "identity.track.city": {
    label: "Track city",
    description: "City associated with current track.",
    parentId: "identity.track",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "identity.track.country": {
    label: "Track country",
    description: "Country associated with current track.",
    parentId: "identity.track",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "identity.track.direction": {
    label: "Track direction",
    description: "Track direction category such as neutral, left, or right.",
    parentId: "identity.track",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "identity.track.latitude": {
    label: "Track latitude",
    description: "Geographic latitude of current track.",
    parentId: "identity.track",
    canonicalUnit: "deg",
    shape: "scalar",
  },
  "identity.track.longitude": {
    label: "Track longitude",
    description: "Geographic longitude of current track.",
    parentId: "identity.track",
    canonicalUnit: "deg",
    shape: "scalar",
  },
  "identity.track.north-offset": {
    label: "Track north offset",
    description: "Angular offset from track coordinate north to geographic north.",
    parentId: "identity.track",
    canonicalUnit: "deg",
    shape: "scalar",
  },
  "identity.track.turn-count": {
    label: "Track turn count",
    description: "Source-reported number of turns around current track.",
    parentId: "identity.track",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "identity.track.type": {
    label: "Track type",
    description: "Source category for track or racing venue type.",
    parentId: "identity.track",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "timing.track-length": {
    label: "Track length",
    description: "Official or source-reported lap length.",
    parentId: "identity.track",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "timing.official-track-length": {
    label: "Official track length",
    description: "Sanctioned lap length for current track configuration.",
    parentId: "identity.track",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "timing.current-lap-valid": {
    label: "Current lap valid",
    description: "Whether current lap remains valid according to source.",
    parentId: "timing",
    canonicalUnit: "boolean",
    shape: "scalar",
  },
  "timing.total-laps": {
    label: "Session total laps",
    description: "Configured or scheduled number of laps in current session.",
    parentId: "timing",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "timing.predicted-lap-time": {
    label: "Predicted lap time",
    description: "Source prediction for completed time of current lap.",
    parentId: "timing",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.ideal-lap-time": {
    label: "Ideal lap time",
    description: "Source-provided ideal or optimal lap time.",
    parentId: "timing",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.current-index": {
    label: "Current sector index",
    description: "Zero-based index of sector vehicle currently occupies.",
    parentId: "timing.sector",
    canonicalUnit: "index",
    shape: "scalar",
  },
  "timing.sector.current-time": {
    label: "Current sector running time",
    description: "Elapsed time since vehicle entered current sector.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.last-completed-time": {
    label: "Last completed sector time",
    description: "Time taken through most recently completed sector.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.layout.indexes": {
    label: "Sector indexes",
    description: "Ordered native sector identifiers.",
    parentId: "timing.sector.layout",
    canonicalUnit: "index",
    shape: "array",
  },
  "timing.sector.layout.start-fractions": {
    label: "Sector start fractions",
    description:
      "Ordered lap fractions where sectors start. Count can vary by simulator and track.",
    parentId: "timing.sector.layout",
    canonicalUnit: "fraction",
    shape: "array",
  },
  "timing.sector.current-lap.s1": {
    label: "Current lap S1",
    description: "Completed sector 1 time on current lap.",
    parentId: "timing.sector.current-lap",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.current-lap.s2": {
    label: "Current lap S2",
    description: "Completed sector 2 time on current lap.",
    parentId: "timing.sector.current-lap",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.current-lap.s3": {
    label: "Current lap S3",
    description: "Completed sector 3 time on current lap.",
    parentId: "timing.sector.current-lap",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.current-lap.times": {
    label: "Current lap sector times",
    description:
      "Ordered completed/running sector-time array assembled by RaceIQ for current lap.",
    parentId: "timing.sector.current-lap",
    canonicalUnit: "s",
    shape: "array",
  },
  "timing.sector.last-lap.s1": {
    label: "Last lap S1",
    description: "Sector 1 time from most recently completed lap.",
    parentId: "timing.sector.last-lap",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.last-lap.s2": {
    label: "Last lap S2",
    description: "Sector 2 time from most recently completed lap.",
    parentId: "timing.sector.last-lap",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.last-lap.s3": {
    label: "Last lap S3",
    description: "Sector 3 time from most recently completed lap.",
    parentId: "timing.sector.last-lap",
    canonicalUnit: "s",
    shape: "scalar",
  },
  "timing.sector.last-lap.times": {
    label: "Last lap sector times",
    description:
      "Ordered sector times for most recently completed lap; supports variable sector counts.",
    parentId: "timing.sector.last-lap",
    canonicalUnit: "s",
    shape: "array",
  },
  "timing.sector.best-times": {
    label: "Best sector times",
    description:
      "Fastest observed time for each sector, possibly drawn from different laps.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    shape: "array",
  },
  "timing.sector.lap-history.s1": {
    label: "Lap-history S1",
    description: "Sector 1 time keyed by completed lap number.",
    parentId: "timing.sector.lap-history",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.lap-history.s2": {
    label: "Lap-history S2",
    description: "Sector 2 time keyed by completed lap number.",
    parentId: "timing.sector.lap-history",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.lap-history.s3": {
    label: "Lap-history S3",
    description: "Sector 3 time keyed by completed lap number.",
    parentId: "timing.sector.lap-history",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.lap-history.lap-time": {
    label: "Lap-history lap time",
    description: "Completed lap time stored beside lap's sector splits.",
    parentId: "timing.sector.lap-history",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.competitor-best.s1": {
    label: "Competitor best S1",
    description: "Best sector 1 time for each competitor.",
    parentId: "timing.sector.competitor-best",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.competitor-best.s2": {
    label: "Competitor best S2",
    description: "Best sector 2 time for each competitor.",
    parentId: "timing.sector.competitor-best",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.competitor-best.s3": {
    label: "Competitor best S3",
    description: "Best sector 3 time for each competitor.",
    parentId: "timing.sector.competitor-best",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.competitor-last.s1": {
    label: "Competitor last S1",
    description: "Last completed sector 1 time for each competitor.",
    parentId: "timing.sector.competitor-last",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.competitor-last.s2": {
    label: "Competitor last S2",
    description: "Last completed sector 2 time for each competitor.",
    parentId: "timing.sector.competitor-last",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.sector.competitor-last.s3": {
    label: "Competitor last S3",
    description: "Last completed sector 3 time for each competitor.",
    parentId: "timing.sector.competitor-last",
    canonicalUnit: "s",
    shape: "structured",
  },
  "race.competitor.position": {
    label: "Competitor position",
    description: "Overall running or classified position for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.class-position": {
    label: "Competitor class position",
    description: "Class running or classified position for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.driver-id": {
    label: "Competitor driver ID",
    description: "Source-specific driver identifier for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "id",
    shape: "structured",
  },
  "race.competitor.driver-name": {
    label: "Competitor driver name",
    description: "Display name for each registered competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "text",
    shape: "structured",
  },
  "race.competitor.team-id": {
    label: "Competitor team ID",
    description: "Source-specific team identifier for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "id",
    shape: "structured",
  },
  "race.competitor.team-name": {
    label: "Competitor team name",
    description: "Team display name for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "text",
    shape: "structured",
  },
  "race.competitor.car-index": {
    label: "Competitor car index",
    description: "Session-local car index used to join competitor arrays.",
    parentId: "race.competitor.identity",
    canonicalUnit: "index",
    shape: "structured",
  },
  "race.competitor.car-id": {
    label: "Competitor car ID",
    description: "Source-specific vehicle model identifier for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "id",
    shape: "structured",
  },
  "race.competitor.car-name": {
    label: "Competitor car name",
    description: "Vehicle display name for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "text",
    shape: "structured",
  },
  "race.competitor.car-class-id": {
    label: "Competitor car-class ID",
    description: "Source-specific vehicle class identifier for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "id",
    shape: "structured",
  },
  "race.competitor.car-class-name": {
    label: "Competitor car-class name",
    description: "Vehicle class display name for each competitor.",
    parentId: "race.competitor.identity",
    canonicalUnit: "text",
    shape: "structured",
  },
  "timing.competitor.current-lap-time": {
    label: "Competitor current lap time",
    description: "Current lap elapsed time for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.competitor.last-lap-time": {
    label: "Competitor last lap time",
    description: "Most recently completed lap time for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.competitor.best-lap-time": {
    label: "Competitor best lap time",
    description: "Fastest completed lap time for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.competitor.gap-to-leader": {
    label: "Competitor gap to leader",
    description: "Time or lap gap from each competitor to overall leader.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.competitor.gap-to-ahead": {
    label: "Competitor gap to car ahead",
    description: "Time or lap gap from each competitor to car directly ahead.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "timing.competitor.current-lap-number": {
    label: "Competitor current lap number",
    description: "Current or last-crossed lap number for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "count",
    shape: "structured",
  },
  "timing.competitor.best-lap-number": {
    label: "Competitor best lap number",
    description: "Lap number on which each competitor set fastest time.",
    parentId: "race.competitor.timing",
    canonicalUnit: "count",
    shape: "structured",
  },
  "timing.competitor.total-time": {
    label: "Competitor session time",
    description: "Elapsed or classified session time for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "race.competitor.pit-status": {
    label: "Competitor pit status",
    description: "Current pit state for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "enum",
    shape: "structured",
  },
  "race.competitor.pit-stops": {
    label: "Competitor pit-stop count",
    description: "Completed pit-stop count for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.penalties": {
    label: "Competitor penalties",
    description: "Accumulated penalty value for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.incidents": {
    label: "Competitor incidents",
    description: "Incident count for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.laps-complete": {
    label: "Competitor laps complete",
    description: "Completed lap count for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.laps-led": {
    label: "Competitor laps led",
    description: "Number of laps led by each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "tires.competitor.compound": {
    label: "Competitor tire compound",
    description: "Current or classified tire compound for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "text",
    shape: "structured",
  },
  "tires.competitor.age": {
    label: "Competitor tire age",
    description: "Current tire stint age for each competitor.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "inputs.competitor.gear": {
    label: "Competitor gear",
    description: "Current transmission gear for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "index",
    shape: "structured",
  },
  "engine.competitor-rpm": {
    label: "Competitor engine RPM",
    description: "Current engine speed for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "rpm",
    shape: "structured",
  },
  "inputs.competitor-steering-angle": {
    label: "Competitor steering angle",
    description: "Current steering-wheel angle for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "rad",
    shape: "structured",
  },
  "timing.competitor.lap-fraction": {
    label: "Competitor lap fraction",
    description: "Current distance around lap for each competitor.",
    parentId: "race.competitor.timing",
    canonicalUnit: "fraction",
    shape: "structured",
  },
  "timing.lap-fraction": {
    label: "Lap fraction",
    description: "Current distance around lap on normalized 0-1 scale.",
    parentId: "timing",
    canonicalUnit: "fraction",
    shape: "scalar",
  },
  "identity.player-car-index": {
    label: "Player car index",
    description: "Source index identifying current player vehicle.",
    parentId: "identity",
    canonicalUnit: "index",
    shape: "scalar",
  },
  "identity.player-driver-id": {
    label: "Player driver ID",
    description: "Source account identifier for current player driver.",
    parentId: "identity",
    canonicalUnit: "id",
    shape: "scalar",
  },
  "identity.player-car-version": {
    label: "Player car version",
    description: "Source version identifier for current player vehicle definition.",
    parentId: "identity",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "race.pace-car-index": {
    label: "Pace-car index",
    description: "Source vehicle index identifying pace or safety car.",
    parentId: "race",
    canonicalUnit: "index",
    shape: "scalar",
  },
  "race.pit-stall-lap-fraction": {
    label: "Pit-stall lap fraction",
    description: "Lap fraction where player pit stall is located.",
    parentId: "race",
    canonicalUnit: "fraction",
    shape: "scalar",
  },
  "motion.driver-head-position.x": {
    label: "Driver head position X",
    description: "Driver head position on source X axis.",
    parentId: "motion.driver-head-position",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "motion.driver-head-position.y": {
    label: "Driver head position Y",
    description: "Driver head position on source Y axis.",
    parentId: "motion.driver-head-position",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "motion.driver-head-position.z": {
    label: "Driver head position Z",
    description: "Driver head position on source Z axis.",
    parentId: "motion.driver-head-position",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "identity.player-car-class-id": {
    label: "Player car-class ID",
    description: "Source class identifier for current player vehicle.",
    parentId: "identity",
    canonicalUnit: "id",
    shape: "scalar",
  },
  "race.player-class-position": {
    label: "Player class position",
    description: "Current player position within vehicle class.",
    parentId: "race",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "race.pit-speed-limit": {
    label: "Pit speed limit",
    description: "Configured pit-lane speed limit.",
    parentId: "race",
    canonicalUnit: "km/h",
    shape: "scalar",
  },
  "race.incident-flags": {
    label: "Player incident flags",
    description: "Native incident event bit flags reported for current player.",
    parentId: "race",
    canonicalUnit: "flags",
    shape: "scalar",
  },
  "race.player-incident-count": {
    label: "Player incident count",
    description: "Incident points assigned personally to current player.",
    parentId: "race",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "race.driver-incident-count": {
    label: "Current-driver incident count",
    description: "Incident points assigned to current driver in team session.",
    parentId: "race",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "race.team-incident-count": {
    label: "Team incident count",
    description: "Incident points assigned to current player team.",
    parentId: "race",
    canonicalUnit: "count",
    shape: "scalar",
  },
  "session.session-id": {
    label: "Session ID",
    description: "Native event-session identifier.",
    parentId: "session",
    canonicalUnit: "id",
    shape: "scalar",
  },
  "session.subsession-id": {
    label: "Subsession ID",
    description: "Native subsession or server-instance identifier.",
    parentId: "session",
    canonicalUnit: "id",
    shape: "scalar",
  },
  "tires.wheel-linear-speed": {
    label: "Wheel linear speed",
    description: "Per-wheel linear tread speed before radius conversion.",
    parentId: "tires",
    canonicalUnit: "m/s",
    shape: "per-wheel",
  },
  "tires.wheel-force.lateral": {
    label: "Lateral wheel force",
    description: "Per-wheel lateral tire force.",
    parentId: "tires",
    canonicalUnit: "N",
    shape: "per-wheel",
  },
  "tires.wheel-force.longitudinal": {
    label: "Longitudinal wheel force",
    description: "Per-wheel longitudinal tire force.",
    parentId: "tires",
    canonicalUnit: "N",
    shape: "per-wheel",
  },
  "tires.wheel-force.vertical": {
    label: "Vertical wheel force",
    description: "Per-wheel vertical tire load reported by source.",
    parentId: "tires",
    canonicalUnit: "N",
    shape: "per-wheel",
  },
  "tires.tire-slip-angle": {
    label: "Tire slip angle",
    description: "Per-wheel angular difference between wheel heading and travel direction.",
    parentId: "tires",
    canonicalUnit: "rad",
    shape: "per-wheel",
  },
  "tires.normalized-tire-slip-angle": {
    label: "Normalized tire slip-angle signal",
    description:
      "Per-wheel source-normalized lateral slip signal; not a physical angle and not directly convertible to radians.",
    parentId: "tires",
    canonicalUnit: "ratio",
    shape: "per-wheel",
  },
  "suspension.cg-height": {
    label: "Center-of-gravity height",
    description: "Vehicle center-of-gravity height above ground.",
    parentId: "suspension",
    canonicalUnit: "m",
    shape: "scalar",
  },
  "inputs.front-wheel-angle": {
    label: "Front wheel angle",
    description: "Physical front-wheel steering angle.",
    parentId: "inputs",
    canonicalUnit: "rad",
    shape: "scalar",
  },
  "motion.velocity-x": {
    label: "Velocity X",
    description: "Vehicle velocity on RaceIQ X axis.",
    parentId: "motion",
    canonicalUnit: "m/s",
    shape: "scalar",
  },
  "motion.velocity-y": {
    label: "Velocity Y",
    description: "Vehicle velocity on RaceIQ Y axis.",
    parentId: "motion",
    canonicalUnit: "m/s",
    shape: "scalar",
  },
  "motion.velocity-z": {
    label: "Velocity Z",
    description: "Vehicle velocity on RaceIQ Z axis.",
    parentId: "motion",
    canonicalUnit: "m/s",
    shape: "scalar",
  },
  "tires.wheel-rotation-speed": {
    label: "Wheel rotation speed",
    description: "Per-wheel angular velocity.",
    parentId: "tires",
    canonicalUnit: "rad/s",
    shape: "per-wheel",
  },
  "tires.tire-combined-slip": {
    label: "Tire combined slip",
    description: "Per-wheel combined slip magnitude.",
    parentId: "tires",
    canonicalUnit: "ratio",
    shape: "per-wheel",
  },
  "tires.surface-rumble": {
    label: "Surface rumble",
    description: "Per-wheel force-feedback surface-rumble intensity.",
    parentId: "tires",
    canonicalUnit: "unitless",
    shape: "per-wheel",
  },
  "timing.competitor.estimated-time": {
    label: "Competitor estimated lap-position time",
    description: "Estimated session time at each competitor's current track location.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    shape: "structured",
  },
  "weather.wind-speed": {
    label: "Current wind speed",
    description: "Current ambient wind speed.",
    parentId: "weather",
    canonicalUnit: "m/s",
    shape: "scalar",
  },
  "weather.wind-direction": {
    label: "Current wind direction",
    description: "Current ambient wind direction.",
    parentId: "weather",
    canonicalUnit: "deg",
    shape: "scalar",
  },
  "weather.fog-level": {
    label: "Current fog level",
    description: "Current ambient fog level.",
    parentId: "weather",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "weather.air-pressure": {
    label: "Current air pressure",
    description: "Current ambient atmospheric pressure.",
    parentId: "weather",
    canonicalUnit: "kPa",
    shape: "scalar",
  },
  "weather.track-cleanup-mode": {
    label: "Track cleanup mode",
    description: "Configured cleanup behavior for accumulated track state.",
    parentId: "weather",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "weather.dynamic-track-mode": {
    label: "Dynamic track mode",
    description: "Configured dynamic-track behavior for session.",
    parentId: "weather",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "weather.relative-humidity": {
    label: "Current relative humidity",
    description: "Current ambient relative humidity.",
    parentId: "weather",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "weather.skies": {
    label: "Current skies",
    description: "Current sky-condition category.",
    parentId: "weather",
    canonicalUnit: "enum",
    shape: "scalar",
  },
  "weather.weather-type": {
    label: "Current weather type",
    description: "Current source weather-condition category.",
    parentId: "weather",
    canonicalUnit: "enum",
    shape: "scalar",
  },
  "weather.configured.fog-level": {
    label: "Configured fog level",
    description: "Session weather configuration for fog level.",
    parentId: "weather.configured",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "weather.configured.relative-humidity": {
    label: "Configured relative humidity",
    description: "Session weather configuration for relative humidity.",
    parentId: "weather.configured",
    canonicalUnit: "%",
    shape: "scalar",
  },
  "weather.configured.skies": {
    label: "Configured skies",
    description: "Session weather configuration for sky conditions.",
    parentId: "weather.configured",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "weather.configured.temperature": {
    label: "Configured weather temperature",
    description: "Session weather configuration for ambient temperature.",
    parentId: "weather.configured",
    canonicalUnit: "°C",
    shape: "scalar",
  },
  "weather.configured.weather-type": {
    label: "Configured weather type",
    description: "Session weather generation mode or weather type.",
    parentId: "weather.configured",
    canonicalUnit: "text",
    shape: "scalar",
  },
  "weather.configured.wind-direction": {
    label: "Configured wind direction",
    description: "Session weather configuration for wind direction.",
    parentId: "weather.configured",
    canonicalUnit: "deg",
    shape: "scalar",
  },
  "weather.configured.wind-speed": {
    label: "Configured wind speed",
    description: "Session weather configuration for wind speed.",
    parentId: "weather.configured",
    canonicalUnit: "m/s",
    shape: "scalar",
  },
  "race.competitor.driver-incident-count": {
    label: "Competitor current-driver incident count",
    description: "Current-driver incident points for each competitor entry.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.team-incident-count": {
    label: "Competitor team incident count",
    description: "Team incident points for each competitor entry.",
    parentId: "race.competitor.results",
    canonicalUnit: "count",
    shape: "structured",
  },
  "race.competitor.driver-abbreviated-name": semanticDefinition(
    "Competitor abbreviated name",
    "Abbreviated display name for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.driver-initials": semanticDefinition(
    "Competitor initials",
    "Driver initials for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.rating": semanticDefinition(
    "Competitor rating",
    "Source skill or matchmaking rating for each competitor.",
    "race.competitor.identity",
    "count",
    "structured",
  ),
  "race.competitor.license-level": semanticDefinition(
    "Competitor license level",
    "Source license level for each competitor.",
    "race.competitor.identity",
    "count",
    "structured",
  ),
  "race.competitor.license-sublevel": semanticDefinition(
    "Competitor license sublevel",
    "Source license progression sublevel for each competitor.",
    "race.competitor.identity",
    "count",
    "structured",
  ),
  "race.competitor.license-name": semanticDefinition(
    "Competitor license name",
    "Source display string for each competitor license.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.license-color": semanticDefinition(
    "Competitor license color",
    "Source display color for each competitor license.",
    "race.competitor.identity",
    "color",
    "structured",
  ),
  "race.competitor.club-name": semanticDefinition(
    "Competitor club name",
    "Club or regional affiliation for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.division-name": semanticDefinition(
    "Competitor division name",
    "Competition division for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.is-spectator": semanticDefinition(
    "Competitor spectator status",
    "Whether each registered competitor entry is spectating.",
    "race.competitor.identity",
    "boolean",
    "structured",
  ),
  "race.competitor.car-number": semanticDefinition(
    "Competitor car number",
    "Displayed car number for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.car-number-raw": semanticDefinition(
    "Competitor raw car number",
    "Unformatted source car-number value for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.car-path": semanticDefinition(
    "Competitor car path",
    "Source vehicle-definition path for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.is-ai": semanticDefinition(
    "Competitor AI status",
    "Whether each competitor is controlled by simulator AI.",
    "race.competitor.identity",
    "boolean",
    "structured",
  ),
  "race.competitor.is-pace-car": semanticDefinition(
    "Competitor pace-car status",
    "Whether each competitor entry represents pace or safety car.",
    "race.competitor.identity",
    "boolean",
    "structured",
  ),
  "race.competitor.car-class-color": semanticDefinition(
    "Competitor car-class color",
    "Source display color for each competitor car class.",
    "race.competitor.identity",
    "color",
    "structured",
  ),
  "race.competitor.car-class-license-level": semanticDefinition(
    "Competitor class license level",
    "Required or assigned license level for each competitor car class.",
    "race.competitor.identity",
    "count",
    "structured",
  ),
  "race.competitor.class-max-fuel-percentage": semanticDefinition(
    "Competitor class maximum fuel percentage",
    "Maximum allowed fuel percentage for each competitor car class.",
    "race.competitor.identity",
    "%",
    "structured",
  ),
  "race.competitor.class-power-adjust": semanticDefinition(
    "Competitor class power adjustment",
    "Balance-of-performance power adjustment for each competitor car class.",
    "race.competitor.identity",
    "%",
    "structured",
  ),
  "race.competitor.class-relative-speed": semanticDefinition(
    "Competitor class relative speed",
    "Relative speed factor for each competitor car class.",
    "race.competitor.identity",
    "ratio",
    "structured",
  ),
  "race.competitor.class-weight-penalty": semanticDefinition(
    "Competitor class weight penalty",
    "Balance-of-performance weight penalty for each competitor car class.",
    "race.competitor.identity",
    "kg",
    "structured",
  ),
  "race.competitor.class-dry-tire-set-limit": semanticDefinition(
    "Competitor class dry-tire set limit",
    "Dry-tire set limit for each competitor car class.",
    "race.competitor.identity",
    "count",
    "structured",
  ),
  "race.competitor.car-design": semanticDefinition(
    "Competitor car design",
    "Source livery or car-design descriptor for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.car-number-design": semanticDefinition(
    "Competitor car-number design",
    "Source car-number styling descriptor for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.helmet-design": semanticDefinition(
    "Competitor helmet design",
    "Source helmet-design descriptor for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.suit-design": semanticDefinition(
    "Competitor suit design",
    "Source driver-suit design descriptor for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.primary-sponsor": semanticDefinition(
    "Competitor primary sponsor",
    "Primary sponsor identifier for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "race.competitor.secondary-sponsor": semanticDefinition(
    "Competitor secondary sponsor",
    "Secondary sponsor identifier for each competitor.",
    "race.competitor.identity",
    "text",
    "structured",
  ),
  "session.schedule.names": {
    label: "Session schedule names",
    description: "Names of sessions in current event schedule.",
    parentId: "session",
    canonicalUnit: "text",
    shape: "structured",
  },
  "session.schedule.numbers": {
    label: "Session schedule numbers",
    description: "Source session numbers for current event schedule.",
    parentId: "session",
    canonicalUnit: "count",
    shape: "structured",
  },
  "identity.camera-focus-car-index": semanticDefinition(
    "Camera focus car index",
    "Vehicle index currently targeted by active simulator camera.",
    "identity",
    "index",
  ),
  "diagnostics.radio.transmitting-car-index": semanticDefinition(
    "Radio transmitting car index",
    "Vehicle index associated with person currently transmitting on radio.",
    "diagnostics.radio",
    "index",
  ),
  "race.competitor.fast-repairs-used": semanticDefinition(
    "Competitor fast repairs used",
    "Count of fast repairs consumed by each competitor.",
    "race.competitor.results",
    "count",
    "structured",
  ),
  "race.competitor.push-to-pass-count": semanticDefinition(
    "Competitor push-to-pass count",
    "Push-to-pass uses consumed or remaining for each competitor, according to session rules.",
    "race.competitor.results",
    "count",
    "structured",
  ),
  "race.competitor.push-to-pass-active": semanticDefinition(
    "Competitor push-to-pass active",
    "Whether push-to-pass is active for each competitor.",
    "race.competitor.results",
    "boolean",
    "structured",
  ),
  "race.competitor.pace-flags": semanticDefinition(
    "Competitor pacing flags",
    "Source pacing-state flags for each competitor.",
    "race.competitor.results",
    "bitfield",
    "structured",
  ),
  "race.competitor.pace-line": semanticDefinition(
    "Competitor pace line",
    "Pacing line assignment for each competitor, or source sentinel when not pacing.",
    "race.competitor.results",
    "index",
    "structured",
  ),
  "race.competitor.pace-row": semanticDefinition(
    "Competitor pace row",
    "Pacing row assignment for each competitor, or source sentinel when not pacing.",
    "race.competitor.results",
    "index",
    "structured",
  ),
  "tires.competitor.qualifying-compound": semanticDefinition(
    "Competitor qualifying tire compound",
    "Qualifying tire-compound code for each competitor.",
    "tires",
    "id",
    "structured",
  ),
  "tires.competitor.qualifying-compound-locked": semanticDefinition(
    "Competitor qualifying compound locked",
    "Whether qualifying tire compound is locked for each competitor.",
    "tires",
    "boolean",
    "structured",
  ),
  "race.competitor.session-flags": semanticDefinition(
    "Competitor session flags",
    "Session flag bitfield associated with each competitor.",
    "race.competitor.results",
    "bitfield",
    "structured",
  ),
  "race.competitor.track-location": semanticDefinition(
    "Competitor track location",
    "Track-location classification for each competitor.",
    "race.competitor.results",
    "enum",
    "structured",
  ),
  "race.competitor.track-surface-material": semanticDefinition(
    "Competitor track-surface material",
    "Surface-material classification beneath each competitor.",
    "race.competitor.results",
    "enum",
    "structured",
  ),
  "session.driver-change.drivers-used": semanticDefinition(
    "Team drivers used",
    "Count of team drivers who have completed a stint in current session.",
    "session",
    "count",
  ),
  "race.driver-change-lap-status": semanticDefinition(
    "Driver-change lap status",
    "Status of driver-change lap requirements.",
    "race",
    "enum",
  ),
  "inputs.starter-trigger": semanticDefinition(
    "Starter trigger",
    "In-car starter control trigger state.",
    "inputs",
    "boolean",
  ),
  "timing.delta-to-session-last-lap": semanticDefinition(
    "Delta to session last lap",
    "Current lap-time delta against session last-lap reference.",
    "timing",
    "s",
  ),
  "timing.delta-to-session-last-lap-rate": semanticDefinition(
    "Delta rate to session last lap",
    "Rate of change of lap-time delta against session last-lap reference.",
    "timing",
    "s/s",
  ),
  "timing.delta-to-session-last-lap-valid": semanticDefinition(
    "Delta to session last lap valid",
    "Whether session last-lap delta is currently valid.",
    "timing",
    "boolean",
  ),
  "timing.lap-delta-to-best-lap-rate": semanticDefinition(
    "Delta rate to best lap",
    "Rate of change of lap-time delta against player best lap.",
    "timing",
    "s/s",
  ),
  "timing.lap-delta-to-best-lap-valid": semanticDefinition(
    "Delta to best lap valid",
    "Whether lap-time delta against player best lap is valid.",
    "timing",
    "boolean",
  ),
  "timing.lap-delta-to-optimal-lap-rate": semanticDefinition(
    "Delta rate to optimal lap",
    "Rate of change of lap-time delta against player optimal lap.",
    "timing",
    "s/s",
  ),
  "timing.lap-delta-to-optimal-lap-valid": semanticDefinition(
    "Delta to optimal lap valid",
    "Whether lap-time delta against player optimal lap is valid.",
    "timing",
    "boolean",
  ),
  "timing.lap-delta-to-session-best-lap-rate": semanticDefinition(
    "Delta rate to session best lap",
    "Rate of change of lap-time delta against session best lap.",
    "timing",
    "s/s",
  ),
  "timing.lap-delta-to-session-best-lap-valid": semanticDefinition(
    "Delta to session best lap valid",
    "Whether lap-time delta against session best lap is valid.",
    "timing",
    "boolean",
  ),
  "timing.lap-delta-to-session-optimal-lap-rate": semanticDefinition(
    "Delta rate to session optimal lap",
    "Rate of change of lap-time delta against session optimal lap.",
    "timing",
    "s/s",
  ),
  "timing.lap-delta-to-session-optimal-lap-valid": semanticDefinition(
    "Delta to session optimal lap valid",
    "Whether lap-time delta against session optimal lap is valid.",
    "timing",
    "boolean",
  ),
  "timing.n-lap-average.clean-lap-count": semanticDefinition(
    "N-lap average clean-lap count",
    "Consecutive clean laps completed toward current N-lap average.",
    "timing",
    "count",
  ),
  "timing.n-lap-average.current-time": semanticDefinition(
    "Current N-lap average time",
    "Player current rolling N-lap average time.",
    "timing",
    "s",
  ),
  "timing.n-lap-average.best-ending-lap": semanticDefinition(
    "Best N-lap average ending lap",
    "Last lap number included in player best N-lap average.",
    "timing",
    "count",
  ),
  "timing.n-lap-average.best-time": semanticDefinition(
    "Best N-lap average time",
    "Player best N-lap average time.",
    "timing",
    "s",
  ),
  "timing.best-lap-number": semanticDefinition(
    "Best lap number",
    "Lap number containing player best completed lap time.",
    "timing",
    "count",
  ),
  "timing.last-completed-lap-number": semanticDefinition(
    "Last completed lap number",
    "Most recent lap number completed by player.",
    "timing",
    "count",
  ),
  "session.laps-remaining": semanticDefinition(
    "Session laps remaining",
    "Number of laps remaining before current session ends.",
    "session",
    "count",
  ),
  "diagnostics.car-number-texture-loading": semanticDefinition(
    "Car-number texture loading",
    "Whether simulator will load car-number texture assets.",
    "diagnostics",
    "boolean",
  ),
  "diagnostics.texture-reload-allowed": semanticDefinition(
    "Texture reload allowed",
    "Whether car textures may be reloaded at current time.",
    "diagnostics",
    "boolean",
  ),
  "race.player.push-to-pass-count": semanticDefinition(
    "Player push-to-pass count",
    "Push-to-pass uses consumed or remaining for player car, according to session rules.",
    "race",
    "count",
  ),
  "race.player.push-to-pass-active": semanticDefinition(
    "Player push-to-pass active",
    "Whether push-to-pass is active on player car.",
    "race",
    "boolean",
  ),
  "race.pit-service.status": semanticDefinition(
    "Pit-service status",
    "Current player-car pit-service status flags.",
    "race.pit-service",
    "bitfield",
  ),
  "race.pit-service.flags": semanticDefinition(
    "Requested pit-service flags",
    "Bitfield of requested pit-service actions.",
    "race.pit-service",
    "bitfield",
  ),
  "race.pit-service.fuel-add-amount": semanticDefinition(
    "Pit-service fuel add amount",
    "Fuel or battery energy requested at next pit service.",
    "race.pit-service",
    "L or kWh",
  ),
  "race.pit-service.tire-pressure": semanticDefinition(
    "Requested pit-service tire pressure",
    "Cold pressure requested for each tire at next pit service.",
    "race.pit-service",
    "kPa",
    "per-wheel",
  ),
  "race.pit-service.tire-compound": semanticDefinition(
    "Requested pit-service tire compound",
    "Tire-compound code requested at next pit service.",
    "race.pit-service",
    "id",
  ),
  "race.pit-service.mandatory-repair-time-remaining": semanticDefinition(
    "Mandatory repair time remaining",
    "Mandatory pit-repair time remaining while repairs are active.",
    "race.pit-service",
    "s",
  ),
  "race.pit-service.optional-repair-time-remaining": semanticDefinition(
    "Optional repair time remaining",
    "Optional pit-repair time remaining while repairs are active.",
    "race.pit-service",
    "s",
  ),
  "diagnostics.camera.group-name": semanticDefinition(
    "Camera group name",
    "Display name of each simulator camera group.",
    "diagnostics.camera",
    "text",
    "structured",
  ),
  "diagnostics.camera.active-camera-number": semanticDefinition(
    "Active camera number",
    "Source number identifying active simulator camera.",
    "diagnostics.camera",
    "index",
  ),
  "diagnostics.camera.active-group-number": semanticDefinition(
    "Active camera group number",
    "Source number identifying active simulator camera group.",
    "diagnostics.camera",
    "index",
  ),
  "diagnostics.camera.state-flags": semanticDefinition(
    "Camera state flags",
    "Bitfield describing active simulator camera system state.",
    "diagnostics.camera",
    "bitfield",
  ),
  "diagnostics.camera.group-number": semanticDefinition(
    "Camera group number",
    "Source number identifying each simulator camera group.",
    "diagnostics.camera",
    "index",
    "structured",
  ),
  "diagnostics.camera.group-scenic": semanticDefinition(
    "Camera group scenic",
    "Whether each simulator camera group is scenic.",
    "diagnostics.camera",
    "boolean",
    "structured",
  ),
  "diagnostics.camera.name": semanticDefinition(
    "Camera name",
    "Display name of each camera definition.",
    "diagnostics.camera",
    "text",
    "structured",
  ),
  "diagnostics.camera.number": semanticDefinition(
    "Camera number",
    "Source number identifying each camera definition.",
    "diagnostics.camera",
    "index",
    "structured",
  ),
  "diagnostics.radio.selected-radio-number": semanticDefinition(
    "Selected radio number",
    "Source radio number currently selected by player.",
    "diagnostics.radio",
    "index",
  ),
  "diagnostics.radio.hop-count": semanticDefinition(
    "Radio hop count",
    "Hop count configured for each simulator radio.",
    "diagnostics.radio",
    "count",
    "structured",
  ),
  "diagnostics.radio.frequency-count": semanticDefinition(
    "Radio frequency count",
    "Number of frequency entries configured for each simulator radio.",
    "diagnostics.radio",
    "count",
    "structured",
  ),
  "diagnostics.radio.number": semanticDefinition(
    "Radio number",
    "Source number identifying each simulator radio.",
    "diagnostics.radio",
    "index",
    "structured",
  ),
  "diagnostics.radio.scanning": semanticDefinition(
    "Radio scanning",
    "Whether scanning is active for each simulator radio.",
    "diagnostics.radio",
    "boolean",
    "structured",
  ),
  "diagnostics.radio.tuned-frequency-number": semanticDefinition(
    "Tuned frequency number",
    "Frequency number currently tuned on each simulator radio.",
    "diagnostics.radio",
    "index",
    "structured",
  ),
  "diagnostics.radio.frequency-can-scan": semanticDefinition(
    "Radio frequency can scan",
    "Whether each frequency entry can participate in scanning.",
    "diagnostics.radio",
    "boolean",
    "structured",
  ),
  "diagnostics.radio.frequency-can-squawk": semanticDefinition(
    "Radio frequency can transmit",
    "Whether player can transmit on each frequency entry.",
    "diagnostics.radio",
    "boolean",
    "structured",
  ),
  "diagnostics.radio.frequency-club-id": semanticDefinition(
    "Radio frequency club ID",
    "Club identifier associated with each frequency entry.",
    "diagnostics.radio",
    "id",
    "structured",
  ),
  "diagnostics.radio.frequency-entry-index": semanticDefinition(
    "Radio frequency entry index",
    "Source index identifying each frequency entry.",
    "diagnostics.radio",
    "index",
    "structured",
  ),
  "diagnostics.radio.frequency-name": semanticDefinition(
    "Radio frequency name",
    "Display name of each frequency entry.",
    "diagnostics.radio",
    "text",
    "structured",
  ),
  "diagnostics.radio.frequency-number": semanticDefinition(
    "Radio frequency number",
    "Source number identifying each frequency entry.",
    "diagnostics.radio",
    "index",
    "structured",
  ),
  "diagnostics.radio.frequency-deletable": semanticDefinition(
    "Radio frequency deletable",
    "Whether each frequency entry may be deleted.",
    "diagnostics.radio",
    "boolean",
    "structured",
  ),
  "diagnostics.radio.frequency-mutable": semanticDefinition(
    "Radio frequency mutable",
    "Whether each frequency entry may be edited.",
    "diagnostics.radio",
    "boolean",
    "structured",
  ),
  "diagnostics.radio.frequency-muted": semanticDefinition(
    "Radio frequency muted",
    "Whether each frequency entry is muted.",
    "diagnostics.radio",
    "boolean",
    "structured",
  ),
  "diagnostics.radio.frequency-priority": semanticDefinition(
    "Radio frequency priority",
    "Priority assigned to each frequency entry.",
    "diagnostics.radio",
    "count",
    "structured",
  ),
  "diagnostics.radio.transmitting-frequency-index": semanticDefinition(
    "Transmitting radio frequency index",
    "Frequency index used by person currently transmitting on radio.",
    "diagnostics.radio",
    "index",
  ),
  "diagnostics.radio.transmitting-radio-index": semanticDefinition(
    "Transmitting radio index",
    "Radio index used by person currently transmitting on radio.",
    "diagnostics.radio",
    "index",
  ),
  "diagnostics.radio.frequency-car-index": {
    label: "Radio frequency car index",
    description: "Vehicle index associated with each radio frequency entry.",
    parentId: "diagnostics.radio",
    canonicalUnit: "index",
    shape: "structured",
  },
};

function ast(source: string): AstNode {
  return parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
    attachComment: true,
  }) as unknown as AstNode;
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  const record = node as AstNode;
  if (typeof record.type === "string") visit(record);
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "loc" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

function propertyName(node: AstNode): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") {
    return String(node.value);
  }
  return undefined;
}

function objectProperties(node: AstNode): Map<string, AstNode> {
  const result = new Map<string, AstNode>();
  if (node?.type !== "ObjectExpression") return result;
  for (const property of node.properties ?? []) {
    if (property.type !== "ObjectProperty") continue;
    const name = propertyName(property.key);
    if (name) result.set(name, property.value);
  }
  return result;
}

function objectCandidate(
  tree: AstNode,
  variableName: string,
): Map<string, AstNode> {
  let best = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.id.name === variableName &&
      node.init?.type === "ObjectExpression"
    ) {
      const candidate = objectProperties(node.init);
      if (candidate.size > best.size) best = candidate;
    }
  });
  return best;
}

function largestReturnObject(tree: AstNode): Map<string, AstNode> {
  let best = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (node.type !== "ReturnStatement" || node.argument?.type !== "ObjectExpression") {
      return;
    }
    const candidate = objectProperties(node.argument);
    if (candidate.size > best.size) best = candidate;
  });
  return best;
}

function variableInitializers(tree: AstNode): Map<string, AstNode> {
  const result = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      node.init
    ) {
      result.set(node.id.name, node.init);
    }
  });
  return result;
}

async function parserOutput(gameId: GameId): Promise<ParserOutput> {
  const source = await readFile(resolve(ROOT, PARSER_FILES[gameId]), "utf8");
  const tree = ast(source);
  const properties =
    gameId === "iracing"
      ? largestReturnObject(tree)
      : objectCandidate(tree, "packet");
  if (properties.size < 90) {
    throw new Error(`${gameId} packet object extraction found only ${properties.size} fields`);
  }
  return { source, properties, variables: variableInitializers(tree) };
}

function cleanComment(value: string): string {
  return value
    .replace(/^\*+|\*+$/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldDescription(node: AstNode, name: string): string | undefined {
  const comments = node.leadingComments as
    | { value?: string; loc?: { start?: { line?: number } } }[]
    | undefined;
  const trailing = node.trailingComments as
    | { value?: string; loc?: { start?: { line?: number } } }[]
    | undefined;
  const nodeEndLine = node.loc?.end?.line;
  const value =
    trailing?.find((comment) => comment.loc?.start?.line === nodeEndLine)?.value ??
    comments?.at(-1)?.value;
  if (!value) return undefined;
  const cleaned = cleanComment(value);
  if (!cleaned || cleaned.length > 500) return undefined;
  return cleaned.replaceAll("`", "");
}

function typeText(source: string, node: AstNode): string {
  if (!node.typeAnnotation?.typeAnnotation) return "unknown";
  const type = node.typeAnnotation.typeAnnotation;
  return source.slice(type.start, type.end);
}

function interfaceFields(
  source: string,
  tree: AstNode,
  interfaceName: string,
): FieldInfo[] {
  let declaration: AstNode | undefined;
  walk(tree, (node) => {
    if (
      !declaration &&
      node.type === "TSInterfaceDeclaration" &&
      node.id?.name === interfaceName
    ) {
      declaration = node;
    }
  });
  if (!declaration) throw new Error(`Missing interface ${interfaceName}`);
  return (declaration.body.body as AstNode[])
    .filter((node) => node.type === "TSPropertySignature")
    .map((node) => ({
      name: propertyName(node.key) ?? "unknown",
      type: typeText(source, node),
      description: fieldDescription(node, propertyName(node.key) ?? ""),
    }));
}

function interfaceLeafFields(
  source: string,
  tree: AstNode,
  interfaceName: string,
  opaqueReferences = new Set<string>(),
): FieldInfo[] {
  const declarations = new Map<string, AstNode>();
  walk(tree, (node) => {
    if (node.type === "TSInterfaceDeclaration" && node.id?.name) {
      declarations.set(node.id.name, node);
    }
  });
  const declaration = declarations.get(interfaceName);
  if (!declaration) throw new Error(`Missing interface ${interfaceName}`);

  function referencedMembers(type: AstNode): {
    members: AstNode[];
    array: boolean;
  } | undefined {
    if (type.type === "TSTypeLiteral") {
      return { members: type.members ?? [], array: false };
    }
    if (type.type === "TSArrayType") {
      const nested = referencedMembers(type.elementType);
      return nested ? { ...nested, array: true } : undefined;
    }
    if (type.type === "TSTypeReference") {
      const referenceName =
        type.typeName?.type === "Identifier" ? type.typeName.name : undefined;
      if (
        referenceName &&
        !opaqueReferences.has(referenceName) &&
        declarations.has(referenceName)
      ) {
        const reference = declarations.get(referenceName);
        if (!reference) return undefined;
        return {
          members: reference.body.body ?? [],
          array: false,
        };
      }
      const parameters =
        type.typeParameters?.params ?? type.typeArguments?.params ?? [];
      for (const parameter of parameters) {
        const nested = referencedMembers(parameter);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  function expand(members: AstNode[], prefix: string, seen: Set<string>): FieldInfo[] {
    const result: FieldInfo[] = [];
    for (const node of members) {
      if (node.type !== "TSPropertySignature") continue;
      const name = propertyName(node.key);
      const type = node.typeAnnotation?.typeAnnotation;
      if (!name || !type) continue;
      const path = prefix ? `${prefix}.${name}` : name;
      const nested = referencedMembers(type);
      const cycleKey = `${path}:${source.slice(type.start, type.end)}`;
      if (nested && !seen.has(cycleKey)) {
        const nextSeen = new Set(seen).add(cycleKey);
        result.push(
          ...expand(
            nested.members,
            nested.array ? `${path}[]` : path,
            nextSeen,
          ),
        );
        continue;
      }
      result.push({
        name: path,
        type: source.slice(type.start, type.end),
        description: fieldDescription(node, name),
      });
    }
    return result;
  }

  return expand(declaration.body.body ?? [], "", new Set());
}

function humanize(value: string): string {
  return value
    .replace(/\[\]/g, "")
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\bRpm\b/gi, "RPM")
    .replace(/\bDrs\b/gi, "DRS")
    .replace(/\bErs\b/gi, "ERS")
    .replace(/\bAbs\b/gi, "ABS")
    .replace(/\bTc\b/gi, "TC")
    .replace(/\bFia\b/gi, "FIA")
    .replace(/\bFl\b/g, "front left")
    .replace(/\bFr\b/g, "front right")
    .replace(/\bRl\b/g, "rear left")
    .replace(/\bRr\b/g, "rear right")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function categoryFor(name: string): string {
  const lower = humanize(name).toLowerCase();
  if (
    /^(accel|brake|clutch|handbrake|gear|steer|norm driving line|norm ai brake diff)$/.test(lower)
  ) {
    return "inputs";
  }
  if (/^position [xyz]$/.test(lower)) return "motion";
  if (
    /^race position$/.test(lower) ||
    /\b(car idx position|car idx class position|player car class position)\b/.test(lower)
  ) {
    return "race";
  }
  if (
    /\b(mem page|page fault|cpu usage|gpu usage|latency|clock skew|frame rate|channel quality|chan quality)\b/.test(
      lower,
    )
  ) {
    return "diagnostics";
  }
  if (/\b(load num textures|texture reload)\b/.test(lower)) {
    return "diagnostics";
  }
  if (
    /\b(steer|steering|clutch|handbrake|input|shifter|gear|brake raw|throttle raw)\b/.test(
      lower,
    )
  ) {
    return "inputs";
  }
  if (
    /\b(wheel load|suspension|susp|shock|spring|heave|cg height|corner weight)\b/.test(
      lower,
    )
  ) {
    return "suspension";
  }
  if (/\b(tire|tyre|wheel|compound|puddle|rumble|slip|tread)\b/.test(lower)) return "tires";
  if (/\b(damage|fault|blister|broken|wear|life)\b/.test(lower)) return "damage";
  if (/\b(setup|wing|camber|toe|anti roll|ride height|differential|spring perch)\b/.test(lower)) return "setup";
  if (/\b(load)\b/.test(lower)) return "suspension";
  if (/\b(brake|disc|pad)\b/.test(lower)) return "brakes";
  if (/\b(fuel|ers|mgu|energy|harvest|deploy|battery)\b/.test(lower)) return "fuel";
  if (/\b(engine|rpm|torque|power|boost|oil|water|exhaust|cylinder|gearbox|throttle|manifold)\b/.test(lower)) return "engine";
  if (/\b(weather|rain|air temp|air density|air pressure|track temp|road temp|wind|wet|grip|precipitation|humidity|fog|skies)\b/.test(lower)) return "weather";
  if (/\b(position|lap|sector|time|delta|distance|gap|speed trap|odometer)\b/.test(lower)) return "timing";
  if (/\b(accel|acceleration|velocity|yaw|pitch|roll|heading|orientation|rotation|force|location|speed)\b/.test(lower)) return "motion";
  if (/\b(drs|aero|diffuser|sidepod|floor|downforce)\b/.test(lower)) return "aero";
  if (/\b(tc|abs|map|limiter|assist|aid|traction control)\b/.test(lower)) return "electronics";
  if (/\b(flag|pit|race|penalty|penalties|warning|incident|status|online|wrong way|grid|caution)\b/.test(lower)) return "race";
  if (/\b(car|track|driver|class|ordinal|drivetrain|team|model|name|version|build)\b/.test(lower)) return "identity";
  if (/\b(session|packet|tick|uid|frame|replay)\b/.test(lower)) return "session";
  return "diagnostics";
}

function unitFor(name: string, type = ""): string {
  const lower = `${name} ${type}`.toLowerCase();
  const normalizedName = name.split(".").at(-1)?.toLowerCase() ?? lower;
  const exactUnits: Record<string, string> = {
    sessionuid: "text",
    israceon: "boolean",
    accel: "0–255",
    brake: "0–255",
    clutch: "0–255",
    handbrake: "0–255",
    gear: "index",
    steer: "-128–127",
    normdrivingline: "-128–127",
    normaibrakediff: "-128–127",
    boost: "psi",
    carordinal: "id",
    trackordinal: "id",
    carclass: "id",
    drivetraintype: "id",
    tyrecompound: "id",
    weathertype: "enum",
    drsactive: "boolean",
    ersstoreenergy: "J",
    ersdeployed: "J",
    ersharvested: "J",
    ersdeployedthislap: "J",
    ersharvestedthislap: "J",
    ersdeploymode: "enum",
  };
  if (exactUnits[normalizedName]) return exactUnits[normalizedName];
  if (/bool(?:ean)?/.test(type)) return "boolean";
  if (/string|char/.test(type)) return "text";
  if (/^tirewear|^tyrewear/.test(normalizedName)) return "fraction";
  if (/^wheelonrumblestrip/.test(normalizedName)) return "boolean";
  if (/^wheelinpuddledepth/.test(normalizedName)) return "fraction";
  if (/^normsuspensiontravel/.test(normalizedName)) return "ratio";
  if (/fuel.*laps.*remain|laps.*possible.*fuel/.test(lower)) return "count";
  if (/wheelrotationspeed|rotation.*speed/.test(lower)) return "rad/s";
  if (/velocity/.test(lower)) return "m/s";
  if (/force|load/.test(lower)) return "N";
  if (/speedtrap|pitspeedlimit/.test(lower)) return "km/h";
  if (/energy|harvest|deployed/.test(lower)) return "J";
  if (/(^|[^a-z])is[A-Z]|active|allowed|enabled|available/.test(name)) return "boolean";
  if (/temperature|temp/.test(lower)) return "°C";
  if (/pressurebar|oilpressure/.test(lower)) return "bar";
  if (/pressure/.test(lower)) return /brakepressure/.test(lower) ? "%" : "psi";
  if (/rpm/.test(lower)) return "rpm";
  if (/power|bhp/.test(lower)) return /bhp/.test(lower) ? "bhp" : "W";
  if (/torque/.test(lower)) return "N·m";
  if (/angle|yaw|pitch|roll|camber|toe|heading|direction/.test(lower)) return /setup/.test(lower) ? "°" : "rad";
  if (/angularvelocity|rate/.test(lower)) return "rad/s";
  if (/acceleration|gforce|accel[xyz]/.test(lower)) return "m/s²";
  if (/speed/.test(lower)) return "m/s";
  if (/time.*ms|timestampms|timems|ms$/.test(lower)) return "ms";
  if (/sessioncurrentlap|lapnumber|total.*laps/.test(lower)) return "count";
  if (/time|bestlap|lastlap|currentlap|gap|(?:best|last)s[123]/.test(lower)) return "s";
  if (/distance|travel|position[xyz]|tracklength|height|radius|defl/.test(lower)) return "m";
  if (/fuel.*percent|rainpercent|percent|bias|damage|wear|health|life/.test(lower)) return "%";
  if (/fuel|litre|liter/.test(lower)) return "L";
  if (/ratio|normalized|norm|fraction|throttle|brake|clutch|steer/.test(lower)) return "ratio";
  if (/(?:^|[.\s-])(lap|position|count|number|age|warning|incident|penalt|ordinal|id|index|sector)/.test(lower)) return "count";
  if (/\[\]|array|record|\{/.test(type)) return "structured";
  return "unitless";
}

function wheelFieldSets(fields: string[]): FieldSet[] {
  const remaining = new Set(fields);
  const sets: FieldSet[] = [];
  const patterns: [RegExp, Record<string, string>][] = [
    [/(.*)(FL|FR|RL|RR)$/, { FL: "FL", FR: "FR", RL: "RL", RR: "RR" }],
    [
      /(.*)(FrontLeft|FrontRight|RearLeft|RearRight)$/,
      {
        FrontLeft: "FL",
        FrontRight: "FR",
        RearLeft: "RL",
        RearRight: "RR",
      },
    ],
    [/(.*)M(FL|FR|RL|RR)$/, { FL: "FL", FR: "FR", RL: "RL", RR: "RR" }],
  ];

  for (const field of fields) {
    if (!remaining.has(field)) continue;
    let grouped = false;
    for (const [pattern, wheelMap] of patterns) {
      const match = field.match(pattern);
      if (!match) continue;
      const base = match[1];
      const candidates: Record<string, string> = {};
      for (const [suffix, wheel] of Object.entries(wheelMap)) {
        const candidate =
          pattern.source.startsWith("(.*)M")
            ? `${base}M${suffix}`
            : `${base}${suffix}`;
        candidates[wheel] = candidate;
      }
      if (Object.values(candidates).every((candidate) => remaining.has(candidate))) {
        const ordered = ["FL", "FR", "RL", "RR"].map((wheel) => candidates[wheel]);
        for (const candidate of ordered) remaining.delete(candidate);
        sets.push({ key: base, fields: ordered, shape: "per-wheel", wheelFields: candidates });
        grouped = true;
        break;
      }
    }
    if (!grouped && remaining.has(field)) {
      remaining.delete(field);
      sets.push({ key: field, fields: [field], shape: "scalar" });
    }
  }
  return sets;
}

function unavailable(
  reason: UnavailableLink["reason"],
  description: string,
): UnavailableLink {
  return { kind: "unavailable", reason, description };
}

function isStaticPlaceholder(node: AstNode | undefined): boolean {
  if (!node) return true;
  if (node.type === "NumericLiteral" && node.value === 0) return true;
  if (node.type === "BooleanLiteral" && node.value === false) return true;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument?.type === "NumericLiteral" &&
    node.argument.value === 1
  ) {
    return true;
  }
  return false;
}

function memberPath(node: AstNode): string | undefined {
  const parts: string[] = [];
  let current: AstNode | undefined = node;
  while (current?.type === "MemberExpression" || current?.type === "OptionalMemberExpression") {
    const property = propertyName(current.property);
    if (!property) return undefined;
    parts.unshift(property);
    current = current.object;
  }
  if (current?.type !== "Identifier") return undefined;
  parts.unshift(current.name);
  return parts.join(".");
}

const SOURCE_ROOTS: Partial<Record<GameId, Record<string, string>>> = {
  "f1-2025": {
    m: "F1.Motion",
    ct: "F1.CarTelemetry",
    ld: "F1.LapData",
    cs: "F1.CarStatus",
    cd: "F1.CarDamage",
    mx: "F1.MotionEx",
    sess: "F1.Session",
    header: "F1.Header",
  },
  acc: {
    PHYSICS: "ACC.Physics",
    GRAPHICS: "ACC.Graphics",
    STATIC: "ACC.Static",
  },
  "ac-evo": {
    PHYSICS: "AC-Evo.Physics",
    GRAPHICS: "AC-Evo.Graphics",
    STATIC: "AC-Evo.Static",
    PHYSICS_EVO: "AC-Evo.Physics",
    GRAPHICS_EVO: "AC-Evo.Graphics",
    STATIC_EVO: "AC-Evo.Static",
  },
  iracing: {
    session: "iRacing.SessionInfo",
    source: "iRacing.SourceFrame",
  },
};

const PACKET_SOURCE_OVERRIDES: Partial<
  Record<GameId, Record<string, string[]>>
> = {
  "f1-2025": {
    CarOrdinal: ["F1.Participants.player.teamId"],
    NumCylinders: ["RaceIQ.ParserConstant.NumCylinders"],
  },
  acc: {
    CarOrdinal: ["ACC.Static.carModel"],
    TrackOrdinal: ["ACC.Static.track"],
  },
  "ac-evo": {
    CarOrdinal: ["AC-Evo.Graphics.car_model"],
    TrackOrdinal: [
      "AC-Evo.Static.track",
      "AC-Evo.Static.track_configuration",
    ],
  },
};

const UNAVAILABLE_PACKET_FIELDS: Partial<
  Record<GameId, Record<string, string>>
> = {
  "f1-2025": {
    DrivetrainType:
      "F1 parser emits a fixed drivetrain enum rather than a simulator-provided vehicle value.",
    IsRaceOn:
      "F1 parser emits constant 1 rather than a distinct simulator race-active value.",
  },
  acc: {
    DrivetrainType:
      "ACC parser assumes rear-wheel drive rather than reading drivetrain from shared memory.",
  },
  "ac-evo": {
    DrivetrainType:
      "AC Evo parser assumes rear-wheel drive rather than reading drivetrain from shared memory.",
  },
  iracing: {
    DrivetrainType:
      "iRacing normalizer emits a fixed drivetrain enum rather than a source-frame value.",
  },
};

function nativeSources(
  gameId: GameId,
  node: AstNode | undefined,
  variables: Map<string, AstNode>,
  seen = new Set<string>(),
): string[] {
  if (!node) return [];
  const sources = new Set<string>();
  const roots = SOURCE_ROOTS[gameId] ?? {};

  function resolveVariableMember(
    root: string,
    members: readonly string[],
  ): AstNode | undefined {
    let current = variables.get(root);
    for (const member of members) {
      while (
        current &&
        [
          "TSAsExpression",
          "TSSatisfiesExpression",
          "TypeCastExpression",
          "ParenthesizedExpression",
        ].includes(current.type)
      ) {
        current = current.expression;
      }
      if (current?.type !== "ObjectExpression") return undefined;
      current = objectProperties(current).get(member);
    }
    return current;
  }

  function inspect(current: unknown): void {
    if (!current || typeof current !== "object") return;
    const value = current as AstNode;

    if (
      value.type === "CallExpression" &&
      value.callee?.type === "Identifier" &&
      ["scalar", "booleanValue", "bool"].includes(value.callee.name) &&
      value.arguments?.[1]?.type === "StringLiteral"
    ) {
      sources.add(`iRacing.${value.arguments[1].value}`);
    }

    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      const path = memberPath(value);
      if (path) {
        const [root, ...rest] = path.split(".");
        if (roots[root] && rest.length > 0) {
          sources.add(`${roots[root]}.${rest.join(".").replace(/\.offset$/, "")}`);
          return;
        }
        if (rest.length > 0) {
          const resolved = resolveVariableMember(root, rest);
          if (resolved) {
            inspect(resolved);
            return;
          }
        }
      }
    }

    if (value.type === "Identifier" && variables.has(value.name) && !seen.has(value.name)) {
      seen.add(value.name);
      inspect(variables.get(value.name));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments" ||
        key === "innerComments"
      ) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) inspect(item);
      } else {
        inspect(child);
      }
    }
  }

  inspect(node);
  return [...sources].filter(
    (source) =>
      !source.endsWith(".offset") &&
      !/\.(readFloatLE|readInt32LE|readUInt)/.test(source),
  );
}

function specialIRacingSources(field: string): string[] | undefined {
  const rawWheel = field.match(
    /(FL|FR|RL|RR|FrontLeft|FrontRight|RearLeft|RearRight)$/,
  )?.[1];
  const wheel = rawWheel
    ? {
        FL: "FL",
        FR: "FR",
        RL: "RL",
        RR: "RR",
        FrontLeft: "FL",
        FrontRight: "FR",
        RearLeft: "RL",
        RearRight: "RR",
      }[rawWheel]
    : undefined;
  if (!wheel) return undefined;
  const corner = { FL: "LF", FR: "RF", RL: "LR", RR: "RR" }[wheel];
  if (field.startsWith("TireWear")) {
    return ["L", "M", "R"].map((band) => `iRacing.${corner}wear${band}`);
  }
  if (field.startsWith("TirePressure")) {
    return [`iRacing.${corner}coldPressure`];
  }
  if (field.startsWith("TireTemp") || field.startsWith("TireCarcassTemp")) {
    const band = field.includes("Left")
      ? ["L"]
      : field.includes("Middle")
        ? ["M"]
        : field.includes("Right")
          ? ["R"]
          : ["L", "M", "R"];
    return band.map((part) => `iRacing.${corner}tempC${part}`);
  }
  return undefined;
}

function expressionText(output: ParserOutput, node: AstNode): string {
  if (typeof node.start !== "number" || typeof node.end !== "number") return "";
  return output.source.slice(node.start, node.end).replace(/\s+/g, " ").trim();
}

function expandedExpressionText(
  output: ParserOutput,
  node: AstNode,
  seen = new Set<string>(),
): string {
  const expressions = [expressionText(output, node)];
  let candidate = node;
  while (
    candidate &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TypeCastExpression",
      "ParenthesizedExpression",
    ].includes(candidate.type)
  ) {
    candidate = candidate.expression;
  }
  if (candidate?.type === "Identifier") {
    const initializer = output.variables.get(candidate.name);
    if (initializer && !seen.has(candidate.name)) {
      seen.add(candidate.name);
      expressions.push(expandedExpressionText(output, initializer, seen));
    }
  }
  return [...new Set(expressions.filter(Boolean))].join(" => ");
}

function packetNativeMetadata(
  gameId: GameId,
  key: string,
  canonicalUnit: string,
): { nativeUnit: string; normalization?: string } {
  if (gameId === "fm-2023" && key.startsWith("TireTemp")) {
    return {
      nativeUnit: "°F",
      normalization: "(fahrenheit - 32) * 5 / 9",
    };
  }
  if (gameId === "f1-2025" && key === "Speed") {
    return { nativeUnit: "km/h", normalization: "kilometres per hour / 3.6" };
  }
  if ((gameId === "acc" || gameId === "ac-evo") && key === "Speed") {
    return { nativeUnit: "km/h", normalization: "kilometres per hour / 3.6" };
  }
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    ["BestLap", "LastLap", "CurrentLap"].includes(key)
  ) {
    return { nativeUnit: "ms", normalization: "milliseconds / 1000" };
  }
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    ["Accel", "Brake", "Steer"].includes(key)
  ) {
    return {
      nativeUnit: "ratio",
      normalization: key === "Steer" ? "ratio * 127 and round" : "ratio * 255 and round",
    };
  }
  if (gameId === "f1-2025" && ["Accel", "Brake", "Steer"].includes(key)) {
    return {
      nativeUnit: "ratio",
      normalization: key === "Steer" ? "ratio * 127 and round" : "ratio * 255 and round",
    };
  }
  if (gameId === "f1-2025" && key === "Clutch") {
    return { nativeUnit: "%", normalization: "percentage * 2.55 and round" };
  }
  if (gameId === "iracing" && ["Accel", "Brake", "Clutch"].includes(key)) {
    return { nativeUnit: "%", normalization: "0-1 SDK value * 255 and round" };
  }
  if (gameId === "iracing" && key === "Speed") {
    return {
      nativeUnit: "m/s",
      normalization: "clamp native m/s speed to non-negative canonical m/s",
    };
  }
  if (gameId === "iracing" && key === "Steer") {
    return {
      nativeUnit: "rad",
      normalization: "steering angle / steering maximum, clamp to -1..1, then * 127",
    };
  }
  if (gameId === "iracing" && key === "TireWear") {
    return {
      nativeUnit: "% tread remaining",
      normalization: "1 - minimum(left, middle, right tread remaining)",
    };
  }
  if (gameId === "iracing" && key === "TirePressure") {
    return { nativeUnit: "kPa", normalization: "kilopascals * 0.1450377377" };
  }
  return { nativeUnit: canonicalUnit };
}


function isPacketSemanticDerivation(
  gameId: GameId,
  key: string,
  expressions: readonly string[],
): boolean {
  if (
    gameId === "iracing" &&
    (key === "CurrentLap" || key === "DistanceTraveled" || key === "TireWear")
  ) {
    return true;
  }
  if (
    gameId === "f1-2025" &&
    (key === "Power" || key === "TireCombinedSlip")
  ) {
    return true;
  }
  return expressions.some((expression) =>
    /integrateDistance|tireWear|sector boundary|lap start/i.test(
      expression,
    ),
  );
}

function isPacketRepresentationNormalization(
  gameId: GameId,
  key: string,
  native: { normalization?: string },
  expressions: readonly string[],
): boolean {
  if (native.normalization) return true;
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    (key === "CarOrdinal" || key === "TrackOrdinal")
  ) {
    return true;
  }
  return expressions.some((expression) =>
    /input255|canonicalGear|clamp|Math\.(?:round|trunc)|Boolean\(|===|!==|\?/.test(
      expression,
    ),
  );
}

function classifyPacketMapping(
  gameId: GameId,
  key: string,
  native: { normalization?: string },
  expressions: readonly string[],
): AvailableLink["kind"] {
  if (
    (gameId === "iracing" &&
      (key === "TireTemp" || key === "TireCarcassTemp")) ||
    (gameId === "acc" && key === "WeatherType") ||
    (gameId === "f1-2025" && key === "WheelRotationSpeed")
  ) {
    return "simplified";
  }
  if (isPacketSemanticDerivation(gameId, key, expressions)) return "derived";
  if (
    isPacketRepresentationNormalization(gameId, key, native, expressions)
  ) {
    return "normalized";
  }
  if (
    expressions.some((expression) =>
      /[+\-*/?:]|Math\./.test(expression),
    )
  ) {
    return "derived";
  }
  return "direct";
}

function packetGameLink(
  gameId: GameId,
  set: FieldSet,
  output: ParserOutput,
  unit: string,
): GameLink {
  const explicitlyUnavailable = UNAVAILABLE_PACKET_FIELDS[gameId]?.[set.key];
  if (explicitlyUnavailable) {
    return unavailable("parser-placeholder", explicitlyUnavailable);
  }
  if (
    (gameId === "acc" || gameId === "ac-evo") &&
    set.key === "CurrentRaceTime"
  ) {
    return unavailable(
      "parser-placeholder",
      `${gameId} currently copies current-lap time into CurrentRaceTime; no distinct session elapsed time is populated.`,
    );
  }
  if (
    gameId === "ac-evo" &&
    /^TireSurfaceTemp(Inner|Middle|Outer)$/.test(set.key)
  ) {
    return unavailable(
      "source-not-populated",
      "AC Evo v0.6 reserves matching fields, but fixture-backed pages report zero instead of live surface-band temperatures.",
    );
  }
  const fields = set.fields;
  if (fields.every((field) => isStaticPlaceholder(output.properties.get(field)))) {
    return unavailable(
      "parser-placeholder",
      `${gameId} parser fills this value with a placeholder because source does not provide it.`,
    );
  }

  const sourceOverride = PACKET_SOURCE_OVERRIDES[gameId]?.[set.key];
  const sourcesByField = fields.map((field) => {
    if (sourceOverride) return sourceOverride;
    if (gameId === "fm-2023") return [`ForzaDataOut.${field}`];
    if (gameId === "iracing") {
      const special = specialIRacingSources(field);
      if (special) return special;
    }
    return nativeSources(
      gameId,
      output.properties.get(field),
      output.variables,
    );
  });
  let allSources = [...new Set(sourcesByField.flat())];
  if (allSources.length === 0) {
    allSources = fields.map((field) =>
      field === "TimestampMS"
        ? "RaceIQ.SystemClock"
        : `RaceIQ.ParserState.${field}`,
    );
    for (const [index, sources] of sourcesByField.entries()) {
      if (sources.length === 0) sources.push(allSources[index]);
    }
  }
  const expressions = fields.map((field) => {
    const value = output.properties.get(field);
    return value ? expandedExpressionText(output, value) : "";
  });
  const native = packetNativeMetadata(gameId, set.key, unit);
  const directIRacingCarcassBand =
    gameId === "iracing" &&
    /^TireCarcassTemp(Left|Middle|Right)$/.test(set.key);
  const mappingKind = directIRacingCarcassBand
    ? "direct"
    : classifyPacketMapping(gameId, set.key, native, expressions);
  const sourceShape =
    set.shape === "per-wheel"
      ? Object.fromEntries(
          ["FL", "FR", "RL", "RR"].map((wheel, index) => [
            wheel,
            sourcesByField[index],
          ]),
        )
      : allSources;
  const tireAverageSimplification =
    mappingKind === "simplified" &&
    gameId === "iracing" &&
    (set.key === "TireTemp" || set.key === "TireCarcassTemp");
  const normalization = tireAverageSimplification
    ? "average available left, middle, and right carcass temperatures per tire"
    : native.normalization ?? [...new Set(expressions)].join(" | ");
  let description =
    allSources.length > 0
      ? `${gameId} maps ${allSources.length} native source channel${allSources.length === 1 ? "" : "s"} into this value.`
      : `${gameId} provides this value from parser/session state.`;
  let limitations: readonly string[] | undefined;
  if (tireAverageSimplification) {
    description =
      "Averages available iRacing left, middle, and right carcass-temperature bands per tire.";
    limitations = [
      "Averaging removes across-tread temperature-gradient detail.",
    ];
  } else if (gameId === "acc" && set.key === "WeatherType") {
    description =
      "Infers wet weather from rain-tyre selection rather than observing weather directly.";
    limitations = [
      "Rain-tyre selection is a lossy weather proxy and cannot distinguish dry conditions or weather intensity.",
    ];
  } else if (gameId === "f1-2025" && set.key === "WheelRotationSpeed") {
    description =
      "Estimates wheel angular speed using an assumed 0.36 m radius and falls back to vehicle speed when per-wheel motion is unavailable.";
    limitations = [
      "Assumed wheel radius and vehicle-speed fallback cannot preserve actual per-wheel rotation.",
    ];
  }

  return {
    kind: mappingKind,
    nativeUnit: native.nativeUnit,
    sources: sourceShape,
    freshness:
      gameId === "f1-2025" && set.key === "NumCylinders"
        ? "static"
        : gameId === "iracing" && /Tire.*Temp|TireWear|TirePressure/.test(set.key)
        ? "pit-snapshot"
        : "continuous",
    ...(normalization && mappingKind !== "direct" ? { normalization } : {}),
    description,
    ...(limitations ? { limitations } : {}),
  };
}

function nativeFuelUnit(gameId: GameId): string {
  if (gameId === "fm-2023" || gameId === "f1-2025") return "fraction";
  return "L";
}

function ensureCategoryGroups(groups: Map<string, CatalogGroup>): void {
  for (const [id, [label, description]] of Object.entries(CATEGORY_META)) {
    groups.set(id, { id, label, description, children: [] });
  }
  groups.set("tire.temperature", {
    id: "tire.temperature",
    label: "Tire temperature",
    description:
      "Temperature measurements for each tire, from representative values down to carcass and tread-surface detail.",
    parentId: "tires",
    canonicalUnit: "°C",
    children: [],
  });
  groups.set("tire.temperature.carcass", {
    id: "tire.temperature.carcass",
    label: "Carcass temperature",
    description:
      "Internal tire temperatures. Sources may provide one core value or multiple carcass bands.",
    parentId: "tire.temperature",
    canonicalUnit: "°C",
    children: [],
  });
  groups.set("tire.temperature.surface", {
    id: "tire.temperature.surface",
    label: "Surface temperature",
    description:
      "Tread-surface temperatures, either representative or split into inner, middle, and outer bands.",
    parentId: "tire.temperature",
    canonicalUnit: "°C",
    children: [],
  });
  groups.set("weather.configured", {
    id: "weather.configured",
    label: "Configured weather",
    description: "Weather values configured for session, distinct from current measured conditions.",
    parentId: "weather",
    children: [],
  });
  groups.set("engine.shift-light", {
    id: "engine.shift-light",
    label: "Shift-light thresholds",
    description: "Engine-speed thresholds controlling staged shift-light indicators.",
    parentId: "engine",
    canonicalUnit: "rpm",
    children: [],
  });
  groups.set("motion.driver-head-position", {
    id: "motion.driver-head-position",
    label: "Driver head position",
    description: "Driver head location relative to vehicle reference frame.",
    parentId: "motion",
    canonicalUnit: "m",
    children: [],
  });
  groups.set("diagnostics.camera", {
    id: "diagnostics.camera",
    label: "Camera state",
    description: "Simulator camera groups, definitions, and active focus state.",
    parentId: "diagnostics",
    children: [],
  });
  groups.set("diagnostics.radio", {
    id: "diagnostics.radio",
    label: "Radio state",
    description: "Simulator radio selection, channels, permissions, and transmit state.",
    parentId: "diagnostics",
    children: [],
  });
  groups.set("identity.track", {
    id: "identity.track",
    label: "Track identity",
    description: "Track name, configuration, dimensions, and source identifiers.",
    parentId: "identity",
    children: [],
  });
  groups.set("race.competitor", {
    id: "race.competitor",
    label: "Competitors",
    description: "Per-competitor identity, live timing, and classified results.",
    parentId: "race",
    children: [],
  });
  groups.set("race.competitor.identity", {
    id: "race.competitor.identity",
    label: "Competitor identity",
    description: "Driver, team, vehicle, and class fields for each competitor.",
    parentId: "race.competitor",
    children: [],
  });
  groups.set("race.competitor.results", {
    id: "race.competitor.results",
    label: "Competitor results",
    description: "Running and classified race-result fields for each competitor.",
    parentId: "race.competitor",
    children: [],
  });
  groups.set("race.competitor.timing", {
    id: "race.competitor.timing",
    label: "Competitor timing",
    description: "Lap times, gaps, and split times for each competitor.",
    parentId: "race.competitor",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("race.pit-service", {
    id: "race.pit-service",
    label: "Pit service",
    description: "Requested pit work, tire changes, fuel addition, and repair state.",
    parentId: "race",
    children: [],
  });
  groups.set("timing.sector", {
    id: "timing.sector",
    label: "Sector timing",
    description:
      "Native sector detail and comparable RaceIQ sector values, preserving variable sector counts.",
    parentId: "timing",
    children: [],
  });
  groups.set("timing.sector.layout", {
    id: "timing.sector.layout",
    label: "Sector layout",
    description: "Ordered sector identifiers and lap-position boundaries.",
    parentId: "timing.sector",
    children: [],
  });
  groups.set("timing.sector.current-lap", {
    id: "timing.sector.current-lap",
    label: "Current lap sectors",
    description: "Sector timing values for lap currently in progress.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.last-lap", {
    id: "timing.sector.last-lap",
    label: "Last lap sectors",
    description: "Sector timing values for most recently completed lap.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.lap-history", {
    id: "timing.sector.lap-history",
    label: "Per-lap sector history",
    description: "Sector timing keyed to specific completed lap numbers.",
    parentId: "timing.sector",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.competitor-best", {
    id: "timing.sector.competitor-best",
    label: "Competitor best sectors",
    description: "Best sector times for every competitor in field.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    children: [],
  });
  groups.set("timing.sector.competitor-last", {
    id: "timing.sector.competitor-last",
    label: "Competitor last sectors",
    description: "Most recent sector times for every competitor in field.",
    parentId: "race.competitor.timing",
    canonicalUnit: "s",
    children: [],
  });
  for (const group of SETUP_GROUP_DEFINITIONS) {
    groups.set(group.id, {
      ...group,
      children: [],
    });
  }
}

function attachChild(groups: Map<string, CatalogGroup>, parentId: string, childId: string): void {
  const parent = groups.get(parentId);
  if (!parent) throw new Error(`Missing parent group ${parentId}`);
  if (!parent.children.includes(childId)) parent.children.push(childId);
}

const NORMALIZED_SEMANTIC_ALIASES: Record<string, string> = {
  TyreCompound: "tires.tire-compound",
  NumCylinders: "engine.cylinder-count",
  SurfaceRumbleFL_2: "tires.surface-rumble",
  SurfaceRumbleFR_2: "tires.surface-rumble",
  SurfaceRumbleRL_2: "tires.surface-rumble",
  SurfaceRumbleRR_2: "tires.surface-rumble",
  TireSlipCombinedFL_2: "tires.normalized-tire-slip-angle",
};

function normalizedSemantic(
  set: FieldSet,
): { id: string; parentId: string; label: string } {
  const tire = TIRE_IDS[set.key];
  if (tire) return { id: tire[0], parentId: tire[1], label: tire[2] };
  const category = categoryFor(set.key);
  const id =
    NORMALIZED_SEMANTIC_ALIASES[set.key] ??
    `${category}.${slug(set.key)}`;
  const definition = SEMANTIC_DEFINITIONS[id];
  return {
    id,
    parentId: definition?.parentId ?? category,
    label: definition?.label ?? humanize(set.key),
  };
}

function addSource(
  inventories: Record<GameId, SourceVariable[]>,
  gameId: GameId,
  source: SourceVariable,
): void {
  const existing = inventories[gameId].find((item) => item.path === source.path);
  if (!existing) inventories[gameId].push(source);
}

function extensionFields(
  fields: FieldInfo[],
  prefix: string,
): { path: string; name: string; type: string; description?: string }[] {
  return fields.map((field) => ({
    path: `${prefix}.${field.name}`,
    name: field.name,
    type: field.type,
    description: field.description,
  }));
}

function extensionFieldSets(
  fields: { path: string; name: string; type: string; description?: string }[],
): ExtensionFieldSet[] {
  const byParent = new Map<
    string,
    { path: string; name: string; type: string; description?: string }[]
  >();
  for (const field of fields) {
    const dot = field.path.lastIndexOf(".");
    const parent = dot >= 0 ? field.path.slice(0, dot) : "";
    const list = byParent.get(parent) ?? [];
    list.push(field);
    byParent.set(parent, list);
  }

  const result: ExtensionFieldSet[] = [];
  for (const [parent, children] of byParent) {
    const byName = new Map(children.map((field) => [field.name.split(".").at(-1) ?? field.name, field]));
    const sets = wheelFieldSets([...byName.keys()]);
    for (const set of sets) {
      const members = set.fields.map((name) => byName.get(name)).filter(Boolean) as typeof children;
      const paths = members.map((member) => member.path);
      const parentParts = parent.split(".");
      const contextParts =
        parentParts[0] === "f1"
          ? parentParts.slice(1)
          : parentParts[0] === "iracing"
            ? parentParts.slice(1)
          : parentParts[0] === "acc" && parentParts[1] === "acEvo"
            ? parentParts.slice(2)
            : parentParts[0] === "acc"
              ? parentParts.slice(1)
              : parentParts;
      const context = contextParts.join(".").replaceAll("[]", "");
      result.push({
        key: set.key,
        semanticKey: context ? `${context}.${set.key}` : set.key,
        paths,
        type: members[0]?.type ?? "unknown",
        description: members[0]?.description,
        shape: set.shape,
        ...(set.wheelFields
          ? {
              wheelPaths: Object.fromEntries(
                Object.entries(set.wheelFields).map(([wheel, name]) => [
                  wheel,
                  `${parent}.${name}`,
                ]),
              ),
            }
          : {}),
      });
    }
  }
  return result;
}

const EXTENSION_ALIASES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(SETUP_PARSER_SOURCE_MAPPINGS).map(([path, mapping]) => [
      path,
      mapping.semanticId,
    ]),
  ),
  "f1.drsActivated": "aero.drs-active",
  "f1.ersStoreEnergy": "fuel.ers-store-energy",
  "f1.ersDeployMode": "fuel.ers-deploy-mode",
  "f1.ersDeployedThisLap": "fuel.ers-deployed",
  "f1.ersHarvestedThisLap": "fuel.ers-harvested",
  "f1.tyreCompound": "tires.tire-compound-name",
  "f1.tyreVisualCompound": "tires.tire-compound-code",
  "f1.trackLength": "timing.track-length",
  "f1.pitSpeedLimit": "race.pit-speed-limit",
  "f1.weather": "weather.weather-type",
  "f1.trackTemperature": "weather.track-temp",
  "f1.airTemperature": "weather.air-temp",
  "f1.rainPercentage": "weather.rain-percent",
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
  "acc.tireCoreTemp": "tire.temperature.carcass.average",
  "acc.tireInnerTemp": "tire.temperature.surface.inner",
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
        ...(mapping.normalization
          ? { normalization: mapping.normalization }
          : {}),
        freshness: "static" as const,
      },
    ]),
  ),
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
  },
  "f1.pitSpeedLimit": {
    unit: "km/h",
    description: "F1 session packet pit-lane speed limit.",
  },
  "f1.fuelRemainingLaps": {
    unit: "count",
    description: "F1 estimated laps remaining at current fuel usage.",
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
    description:
      "Variable-length sector start fractions parsed from SessionInfo SplitTimeInfo.",
    freshness: "session-update",
  },
};

const UNAVAILABLE_EXTENSION_SOURCES: Partial<
  Record<GameId, Record<string, UnavailableExtensionSource>>
> = {
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
      description:
        "AC Evo v0.6 reserves inner surface temperatures but current shared-memory pages report zero placeholders.",
    },
    "acc.tireMiddleTemp": {
      reason: "source-not-populated",
      description:
        "AC Evo v0.6 reserves middle surface temperatures but current shared-memory pages report zero placeholders.",
    },
    "acc.acEvo.tyreMiddleTempC": {
      reason: "source-not-populated",
      description:
        "AC Evo v0.6 native middle-temperature array currently mirrors zero placeholder offsets.",
    },
    "acc.tireOuterTemp": {
      reason: "source-not-populated",
      description:
        "AC Evo v0.6 reserves outer surface temperatures but current shared-memory pages report zero placeholders.",
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

function unavailableExtensionSource(
  gameId: GameId,
  path: string,
): UnavailableExtensionSource | undefined {
  return UNAVAILABLE_EXTENSION_SOURCES[gameId]?.[path];
}

function extensionMetadata(path: string): ExtensionMetadata | undefined {
  const semanticId = EXTENSION_ALIASES[path] ?? EXTENSION_ALIASES[path.replace(/(FL|FR|RL|RR)$/, "")];
  if (!semanticId) return undefined;
  const metadata =
    EXTENSION_METADATA[path] ??
    EXTENSION_METADATA[path.replace(/(FL|FR|RL|RR)$/, "")] ??
    {};
  return { semanticId, ...metadata };
}

function extensionAlias(path: string): string | undefined {
  return extensionMetadata(path)?.semanticId;
}

function unavailableGames(description: string): Record<GameId, GameLink> {
  return Object.fromEntries(
    GAME_IDS.map((gameId) => [
      gameId,
      unavailable("source-not-provided", description),
    ]),
  ) as Record<GameId, GameLink>;
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

function addExtensionVariable(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
  gameId: GameId,
  field: ExtensionFieldSet,
): void {
  const metadata = extensionMetadata(field.paths[0]);
  const alias = metadata?.semanticId;
  const category = categoryFor(field.semanticKey);
  const id = alias ?? `${category}.${slug(field.semanticKey)}`;
  const definition = SEMANTIC_DEFINITIONS[id];
  const unit = metadata?.unit ?? unitFor(field.semanticKey, field.type);
  const sourceDescription =
    metadata?.description ??
    (field.description && field.description.length > 15
      ? field.description
      : `${humanize(field.semanticKey)} source value reported by ${gameId} in ${unit}.`);
  const variableDescription =
    definition?.description ?? sourceDescription;
  let variable = variables.get(id);

  if (!variable) {
    variable = {
      id,
      label: definition?.label ?? humanize(field.semanticKey),
      description: variableDescription,
      parentId: definition?.parentId ?? category,
      canonicalUnit: definition?.canonicalUnit ?? unit,
      shape:
        definition?.shape ??
        (field.shape === "per-wheel"
          ? "per-wheel"
          : field.paths.some((path) => path.includes("[]")) ||
              /\[\]|Array|Record|\{/.test(field.type)
            ? "structured"
            : "scalar"),
      games: unavailableGames(
        "This parser does not expose an equivalent source value.",
      ),
    };
    variables.set(id, variable);
    attachChild(groups, variable.parentId, id);
  }

  const availablePaths = field.paths.filter(
    (path) => !unavailableExtensionSource(gameId, path),
  );
  const unavailablePaths = field.paths.filter((path) =>
    unavailableExtensionSource(gameId, path),
  );
  const existing = variable.games[gameId];
  const sourceValue: AvailableLink["sources"] = field.wheelPaths
    ? Object.fromEntries(
        Object.entries(field.wheelPaths).map(([wheel, path]) => [
          wheel,
          unavailableExtensionSource(gameId, path) ? [] : [path],
        ]),
      )
    : [...availablePaths];
  if (existing.kind === "unavailable") {
    const unavailableSource = unavailablePaths
      .map((path) => unavailableExtensionSource(gameId, path))
      .find(Boolean);
    const f1SectorLayoutPlaceholder =
      gameId === "f1-2025" &&
      field.paths.some((path) =>
        [
          "f1.sector2LapDistanceStart",
          "f1.sector3LapDistanceStart",
        ].includes(path),
      );
    variable.games[gameId] = availablePaths.length === 0 && unavailableSource
      ? unavailable(unavailableSource.reason, unavailableSource.description)
      : f1SectorLayoutPlaceholder
        ? unavailable(
            "parser-placeholder",
            "F1 2025 packet parser reserves this field but source packet does not provide sector boundary distances.",
          )
      : {
          kind: metadata?.kind ?? "direct",
          nativeUnit: unit,
          sources: sourceValue,
          freshness:
            metadata?.freshness ??
            (/setup|version|name|radius/i.test(field.paths.join(" "))
              ? "static"
              : "continuous"),
          ...(metadata?.normalization
            ? { normalization: metadata.normalization }
            : {}),
          description: `${gameId} parser exposes ${field.paths.length} linked field${field.paths.length === 1 ? "" : "s"}.`,
        };
  } else if (Array.isArray(existing.sources)) {
    for (const sourcePath of availablePaths) {
      if (!existing.sources.includes(sourcePath)) existing.sources.push(sourcePath);
    }
  }

  for (const sourcePath of field.paths) {
    addSource(inventories, gameId, {
      path: sourcePath,
      label: humanize(sourcePath.split(".").at(-1) ?? sourcePath),
      unit,
      dataType: field.type,
      ...(!/\[\]|Array|Record|\{/.test(field.type) ? { count: 1 } : {}),
      description:
        unavailableExtensionSource(gameId, sourcePath)?.description ??
        sourceDescription,
      semanticId: id,
      sourceKind: "extension",
      recordedByRaceIQ: true,
      retention: "exact",
    });
  }
}

function iRacingFreshness(name: string): AvailableLink["freshness"] {
  return /tempC[LMR]$|wear[LMR]$|coldPressure$/.test(name)
    ? "pit-snapshot"
    : "continuous";
}

function generalizeIRacingDescription(description: string): string {
  return description
    .replace(/^(LF|RF|LR|RR)\s+tire\s+/i, "")
    .replace(/^(LF|RF|LR|RR)\s+/i, "")
    .replace(/^./, (char) => char.toUpperCase());
}

function canonicalIRacingUnit(unit: string): string {
  const aliases: Record<string, string> = {
    C: "°C",
    RPM: "rpm",
    "revs/min": "rpm",
    "N*m": "N·m",
    l: "L",
    "l or kWh": "L or kWh",
    "m/s^2": "m/s²",
    "m/s at 360 Hz": "m/s",
  };
  return aliases[unit] ?? unit;
}

function inferredIRacingUnit(
  raw: { name: string; type: string; unit: string },
  semantic?: CatalogVariable,
): string {
  if (raw.unit) return raw.unit;
  if (raw.type === "bool") return "boolean";
  if (semantic && semantic.canonicalUnit !== "text") {
    return semantic.canonicalUnit;
  }
  const inferred = unitFor(humanize(raw.name), raw.type);
  return inferred === "unitless" && /char|string/i.test(raw.type)
    ? "text"
    : inferred;
}

const IRACING_SDK_ALIASES: Record<string, string> = {
  CamCameraNumber: "diagnostics.camera.active-camera-number",
  CamCameraState: "diagnostics.camera.state-flags",
  CamCarIdx: "identity.camera-focus-car-index",
  CamGroupNumber: "diagnostics.camera.active-group-number",
  CarIdxBestLapNum: "timing.competitor.best-lap-number",
  CarIdxBestLapTime: "timing.competitor.best-lap-time",
  CarIdxClass: "race.competitor.car-class-id",
  CarIdxClassPosition: "race.competitor.class-position",
  CarIdxEstTime: "timing.competitor.estimated-time",
  CarIdxF2Time: "timing.competitor.gap-to-leader",
  CarIdxFastRepairsUsed: "race.competitor.fast-repairs-used",
  CarIdxGear: "inputs.competitor.gear",
  CarIdxLap: "timing.competitor.current-lap-number",
  CarIdxLapCompleted: "race.competitor.laps-complete",
  CarIdxLapDistPct: "timing.competitor.lap-fraction",
  CarIdxLastLapTime: "timing.competitor.last-lap-time",
  CarIdxOnPitRoad: "race.competitor.pit-status",
  CarIdxP2P_Count: "race.competitor.push-to-pass-count",
  CarIdxP2P_Status: "race.competitor.push-to-pass-active",
  CarIdxPaceFlags: "race.competitor.pace-flags",
  CarIdxPaceLine: "race.competitor.pace-line",
  CarIdxPaceRow: "race.competitor.pace-row",
  CarIdxPosition: "race.competitor.position",
  CarIdxQualTireCompound: "tires.competitor.qualifying-compound",
  CarIdxQualTireCompoundLocked:
    "tires.competitor.qualifying-compound-locked",
  CarIdxRPM: "engine.competitor-rpm",
  CarIdxSteer: "inputs.competitor-steering-angle",
  CarIdxSessionFlags: "race.competitor.session-flags",
  CarIdxTireCompound: "tires.competitor.compound",
  CarIdxTrackSurface: "race.competitor.track-location",
  CarIdxTrackSurfaceMaterial:
    "race.competitor.track-surface-material",
  DCDriversSoFar: "session.driver-change.drivers-used",
  DCLapStatus: "race.driver-change-lap-status",
  LapBestLap: "timing.best-lap-number",
  LapBestNLapLap: "timing.n-lap-average.best-ending-lap",
  LapBestNLapTime: "timing.n-lap-average.best-time",
  LapCompleted: "timing.last-completed-lap-number",
  LapDeltaToSessionLastlLap: "timing.delta-to-session-last-lap",
  LapDeltaToSessionLastlLap_DD:
    "timing.delta-to-session-last-lap-rate",
  LapDeltaToSessionLastlLap_OK:
    "timing.delta-to-session-last-lap-valid",
  LapDeltaToBestLap_DD: "timing.lap-delta-to-best-lap-rate",
  LapDeltaToBestLap_OK: "timing.lap-delta-to-best-lap-valid",
  LapDeltaToOptimalLap_DD: "timing.lap-delta-to-optimal-lap-rate",
  LapDeltaToOptimalLap_OK: "timing.lap-delta-to-optimal-lap-valid",
  LapDeltaToSessionBestLap_DD:
    "timing.lap-delta-to-session-best-lap-rate",
  LapDeltaToSessionBestLap_OK:
    "timing.lap-delta-to-session-best-lap-valid",
  LapDeltaToSessionOptimalLap_DD:
    "timing.lap-delta-to-session-optimal-lap-rate",
  LapDeltaToSessionOptimalLap_OK:
    "timing.lap-delta-to-session-optimal-lap-valid",
  LapLasNLapSeq: "timing.n-lap-average.clean-lap-count",
  LapLastNLapTime: "timing.n-lap-average.current-time",
  LoadNumTextures: "diagnostics.car-number-texture-loading",
  LapDistPct: "timing.lap-fraction",
  PlayerCarIdx: "identity.player-car-index",
  PlayerCarClass: "identity.player-car-class-id",
  PlayerCarClassPosition: "race.player-class-position",
  SessionUniqueID: "session.session-id",
  PlayerIncidents: "race.incident-flags",
  PlayerCarDriverIncidentCount: "race.driver-incident-count",
  PlayerCarMyIncidentCount: "race.player-incident-count",
  PlayerCarTeamIncidentCount: "race.team-incident-count",
  PlayerTireCompound: "tires.tire-compound-code",
  FuelLevelPct: "fuel.fuel-percent",
  WaterTemp: "engine.coolant-temperature",
  OilTemp: "engine.oil-temperature",
  OilPress: "engine.oil-pressure",
  OkToReloadTextures: "diagnostics.texture-reload-allowed",
  PitOptRepairLeft: "race.pit-service.optional-repair-time-remaining",
  PitRepairLeft: "race.pit-service.mandatory-repair-time-remaining",
  PitSvFlags: "race.pit-service.flags",
  PitSvFuel: "race.pit-service.fuel-add-amount",
  PitSvLFP: "race.pit-service.tire-pressure",
  PitSvLRP: "race.pit-service.tire-pressure",
  PitSvRFP: "race.pit-service.tire-pressure",
  PitSvRRP: "race.pit-service.tire-pressure",
  PitSvTireCompound: "race.pit-service.tire-compound",
  PlayerCarPitSvStatus: "race.pit-service.status",
  P2P_Count: "race.player.push-to-pass-count",
  P2P_Status: "race.player.push-to-pass-active",
  RadioTransmitCarIdx: "diagnostics.radio.transmitting-car-index",
  RadioTransmitFrequencyIdx:
    "diagnostics.radio.transmitting-frequency-index",
  RadioTransmitRadioIdx: "diagnostics.radio.transmitting-radio-index",
  SessionLapsRemain: "session.laps-remaining",
  SessionLapsRemainEx: "session.laps-remaining",
  SessionLapsTotal: "timing.total-laps",
  dcStarter: "inputs.starter-trigger",
};

const IRACING_YAML_ALIASES: Record<string, string> = {
  "WeekendInfo.TrackName": "identity.track-name",
  "WeekendInfo.TrackDisplayName": "identity.track-name",
  "WeekendInfo.TrackDisplayShortName": "identity.track-name",
  "WeekendInfo.TrackID": "identity.track-ordinal",
  "WeekendInfo.TrackLength": "timing.track-length",
  "WeekendInfo.TrackLengthOfficial": "timing.official-track-length",
  "WeekendInfo.TrackVersion": "diagnostics.track-content-version",
  "WeekendInfo.TrackAltitude": "identity.track.altitude",
  "WeekendInfo.TrackCity": "identity.track.city",
  "WeekendInfo.TrackCleanup": "weather.track-cleanup-mode",
  "WeekendInfo.TrackConfigName": "identity.track.configuration-name",
  "WeekendInfo.TrackCountry": "identity.track.country",
  "WeekendInfo.TrackDirection": "identity.track.direction",
  "WeekendInfo.TrackDynamicTrack": "weather.dynamic-track-mode",
  "WeekendInfo.TrackLatitude": "identity.track.latitude",
  "WeekendInfo.TrackLongitude": "identity.track.longitude",
  "WeekendInfo.TrackNorthOffset": "identity.track.north-offset",
  "WeekendInfo.TrackNumTurns": "identity.track.turn-count",
  "WeekendInfo.TrackType": "identity.track.type",
  "WeekendInfo.SessionID": "session.session-id",
  "WeekendInfo.SubSessionID": "session.subsession-id",
  "WeekendInfo.TrackPitSpeedLimit": "race.pit-speed-limit",
  "WeekendInfo.TrackAirTemp": "weather.air-temp",
  "WeekendInfo.TrackAirPressure": "weather.air-pressure",
  "WeekendInfo.TrackFogLevel": "weather.fog-level",
  "WeekendInfo.TrackRelativeHumidity": "weather.relative-humidity",
  "WeekendInfo.TrackSkies": "weather.skies",
  "WeekendInfo.TrackSurfaceTemp": "weather.track-temp",
  "WeekendInfo.TrackWeatherType": "weather.weather-type",
  "WeekendInfo.TrackPrecipitation": "weather.rain-percent",
  "WeekendInfo.TrackWindVel": "weather.wind-speed",
  "WeekendInfo.TrackWindDir": "weather.wind-direction",
  "WeekendInfo.BuildVersion": "diagnostics.sim-build-version",
  "WeekendInfo.BuildTarget": "diagnostics.sim-build-target",
  "WeekendInfo.BuildType": "diagnostics.sim-build-type",
  "WeekendInfo.Category": "session.category",
  "WeekendInfo.DCRuleSet": "session.driver-change-rule-set",
  "WeekendInfo.EventType": "session.event-type",
  "WeekendInfo.HeatRacing": "session.heat-racing",
  "WeekendInfo.LeagueID": "session.league-id",
  "WeekendInfo.MaxDrivers": "session.maximum-drivers",
  "WeekendInfo.MinDrivers": "session.minimum-drivers",
  "WeekendInfo.NumCarClasses": "session.car-class-count",
  "WeekendInfo.NumCarTypes": "session.car-type-count",
  "WeekendInfo.Official": "session.official",
  "WeekendInfo.QualifierMustStartRace":
    "session.qualifier-must-start-race",
  "WeekendInfo.RaceWeek": "session.race-week",
  "WeekendInfo.SeasonID": "session.season-id",
  "WeekendInfo.SeriesID": "session.series-id",
  "WeekendInfo.SimMode": "session.sim-mode",
  "WeekendInfo.TeamRacing": "session.team-racing",
  "WeekendInfo.TelemetryOptions.TelemetryDiskFile":
    "diagnostics.telemetry.disk-file",
  "WeekendInfo.WeekendOptions.CommercialMode":
    "session.configuration.commercial-mode",
  "WeekendInfo.WeekendOptions.CourseCautions":
    "session.configuration.course-cautions",
  "WeekendInfo.WeekendOptions.Date": "session.configuration.date",
  "WeekendInfo.WeekendOptions.EarthRotationSpeedupFactor":
    "session.configuration.earth-rotation-speedup-factor",
  "WeekendInfo.WeekendOptions.FastRepairsLimit":
    "session.configuration.fast-repair-limit",
  "WeekendInfo.WeekendOptions.GreenWhiteCheckeredLimit":
    "session.configuration.green-white-checkered-limit",
  "WeekendInfo.WeekendOptions.HardcoreLevel":
    "session.configuration.hardcore-level",
  "WeekendInfo.WeekendOptions.HasOpenRegistration":
    "session.configuration.open-registration",
  "WeekendInfo.WeekendOptions.IncidentLimit":
    "session.configuration.incident-limit",
  "WeekendInfo.WeekendOptions.NightMode":
    "session.configuration.night-mode",
  "WeekendInfo.WeekendOptions.NumJokerLaps":
    "session.configuration.joker-lap-count",
  "WeekendInfo.WeekendOptions.NumStarters":
    "session.configuration.starter-count",
  "WeekendInfo.WeekendOptions.QualifyScoring":
    "session.configuration.qualifying-scoring",
  "WeekendInfo.WeekendOptions.Restarts":
    "session.configuration.restarts",
  "WeekendInfo.WeekendOptions.ShortParadeLap":
    "session.configuration.short-parade-lap",
  "WeekendInfo.WeekendOptions.StandingStart":
    "session.configuration.standing-start",
  "WeekendInfo.WeekendOptions.StartingGrid":
    "session.configuration.starting-grid",
  "WeekendInfo.WeekendOptions.StrictLapsChecking":
    "session.configuration.strict-lap-checking",
  "WeekendInfo.WeekendOptions.TimeOfDay":
    "session.configuration.time-of-day",
  "WeekendInfo.WeekendOptions.Unofficial":
    "session.configuration.unofficial",
  "WeekendInfo.WeekendOptions.FogLevel": "weather.configured.fog-level",
  "WeekendInfo.WeekendOptions.RelativeHumidity":
    "weather.configured.relative-humidity",
  "WeekendInfo.WeekendOptions.Skies": "weather.configured.skies",
  "WeekendInfo.WeekendOptions.WeatherTemp":
    "weather.configured.temperature",
  "WeekendInfo.WeekendOptions.WeatherType":
    "weather.configured.weather-type",
  "WeekendInfo.WeekendOptions.WindDirection":
    "weather.configured.wind-direction",
  "WeekendInfo.WeekendOptions.WindSpeed": "weather.configured.wind-speed",
  "SessionInfo.Sessions[].SessionType": "session.session-type",
  "SessionInfo.Sessions[].SessionLaps": "timing.total-laps",
  "SessionInfo.Sessions[].SessionName": "session.schedule.names",
  "SessionInfo.Sessions[].SessionNum": "session.schedule.numbers",
  "SessionInfo.Sessions[].SessionNumLapsToAvg":
    "session.schedule.laps-to-average",
  "SessionInfo.Sessions[].SessionRunGroupsUsed":
    "session.schedule.run-groups-used",
  "SessionInfo.Sessions[].SessionSkipped": "session.schedule.skipped",
  "SessionInfo.Sessions[].SessionSubType": "session.schedule.subtype",
  "SessionInfo.Sessions[].SessionTime": "session.schedule.time-limit",
  "SessionInfo.Sessions[].SessionTrackRubberState":
    "weather.track-rubber-state",
  "SessionInfo.Sessions[].SessionEnforceTireCompoundChange":
    "session.configuration.enforce-tire-compound-change",
  "SessionInfo.Sessions[].ResultsAverageLapTime":
    "timing.session-average-lap-time",
  "SessionInfo.Sessions[].ResultsLapsComplete":
    "race.session-summary.laps-complete",
  "SessionInfo.Sessions[].ResultsNumCautionFlags":
    "race.session-summary.caution-flags",
  "SessionInfo.Sessions[].ResultsNumCautionLaps":
    "race.session-summary.caution-laps",
  "SessionInfo.Sessions[].ResultsNumLeadChanges":
    "race.session-summary.lead-changes",
  "SessionInfo.Sessions[].ResultsOfficial":
    "race.session-summary.official",
  "SessionInfo.Sessions[].ResultsFastestLap[].CarIdx":
    "race.competitor.car-index",
  "SessionInfo.Sessions[].ResultsFastestLap[].FastestLap":
    "timing.session-fastest-lap.number",
  "SessionInfo.Sessions[].ResultsFastestLap[].FastestTime":
    "timing.session-fastest-lap.time",
  "SessionInfo.Sessions[].ResultsPositions[].Position":
    "race.competitor.position",
  "SessionInfo.Sessions[].ResultsPositions[].ClassPosition":
    "race.competitor.class-position",
  "SessionInfo.Sessions[].ResultsPositions[].CarIdx":
    "race.competitor.car-index",
  "SessionInfo.Sessions[].ResultsPositions[].Lap":
    "timing.competitor.current-lap-number",
  "SessionInfo.Sessions[].ResultsPositions[].Time":
    "timing.competitor.total-time",
  "SessionInfo.Sessions[].ResultsPositions[].FastestLap":
    "timing.competitor.best-lap-number",
  "SessionInfo.Sessions[].ResultsPositions[].FastestTime":
    "timing.competitor.best-lap-time",
  "SessionInfo.Sessions[].ResultsPositions[].LastTime":
    "timing.competitor.last-lap-time",
  "SessionInfo.Sessions[].ResultsPositions[].Incidents":
    "race.competitor.incidents",
  "SessionInfo.Sessions[].ResultsPositions[].LapsComplete":
    "race.competitor.laps-complete",
  "SessionInfo.Sessions[].ResultsPositions[].LapsLed":
    "race.competitor.laps-led",
  "SessionInfo.Sessions[].ResultsPositions[].JokerLapsComplete":
    "race.competitor.joker-laps-complete",
  "SessionInfo.Sessions[].ResultsPositions[].LapsDriven":
    "race.competitor.laps-driven",
  "SessionInfo.Sessions[].ResultsPositions[].ReasonOutId":
    "race.competitor.reason-out-id",
  "SessionInfo.Sessions[].ResultsPositions[].ReasonOutStr":
    "race.competitor.reason-out-text",
  "QualifyResultsInfo.Results[].Position": "race.competitor.position",
  "QualifyResultsInfo.Results[].ClassPosition":
    "race.competitor.class-position",
  "QualifyResultsInfo.Results[].CarIdx": "race.competitor.car-index",
  "QualifyResultsInfo.Results[].FastestLap":
    "timing.competitor.best-lap-number",
  "QualifyResultsInfo.Results[].FastestTime":
    "timing.competitor.best-lap-time",
  "DriverInfo.DriverCarIdleRPM": "engine.engine-idle-rpm",
  "DriverInfo.DriverCarRedLine": "engine.engine-max-rpm",
  "DriverInfo.DriverCarFuelMaxLtr": "fuel.fuel-capacity",
  "DriverInfo.DriverCarGearNeutral":
    "inputs.gearbox.neutral-position-count",
  "DriverInfo.DriverCarGearNumForward": "inputs.gearbox.forward-gear-count",
  "DriverInfo.DriverCarGearReverse":
    "inputs.gearbox.reverse-position-count",
  "DriverInfo.DriverCarIsElectric": "identity.player-car-electric",
  "DriverInfo.DriverUserID": "identity.player-driver-id",
  "DriverInfo.PaceCarIdx": "race.pace-car-index",
  "DriverInfo.DriverHeadPosX": "motion.driver-head-position.x",
  "DriverInfo.DriverHeadPosY": "motion.driver-head-position.y",
  "DriverInfo.DriverHeadPosZ": "motion.driver-head-position.z",
  "DriverInfo.DriverCarFuelKgPerLtr": "fuel.density",
  "DriverInfo.DriverCarMaxFuelPct": "fuel.maximum-fill-percentage",
  "DriverInfo.DriverCarSLFirstRPM": "engine.shift-light.first-rpm",
  "DriverInfo.DriverCarSLShiftRPM": "engine.shift-light.shift-rpm",
  "DriverInfo.DriverCarSLLastRPM": "engine.shift-light.last-rpm",
  "DriverInfo.DriverCarSLBlinkRPM": "engine.shift-light.blink-rpm",
  "DriverInfo.DriverCarVersion": "identity.player-car-version",
  "DriverInfo.DriverPitTrkPct": "race.pit-stall-lap-fraction",
  "DriverInfo.DriverCarEngCylinderCount": "engine.cylinder-count",
  "DriverInfo.DriverCarIdx": "identity.player-car-index",
  "DriverInfo.DriverIncidentCount": "race.driver-incident-count",
  "DriverInfo.DriverCarEstLapTime": "timing.predicted-lap-time",
  "DriverInfo.DriverSetupName": "setup.metadata.name",
  "DriverInfo.DriverSetupIsModified": "setup.metadata.modified",
  "DriverInfo.DriverSetupLoadTypeName": "setup.metadata.load-type",
  "DriverInfo.DriverSetupPassedTech": "setup.metadata.passed-tech",
  "WeekendInfo.WeekendOptions.IsFixedSetup": "setup.metadata.fixed",
  "DriverInfo.Drivers[].CarIdx": "race.competitor.car-index",
  "DriverInfo.Drivers[].UserID": "race.competitor.driver-id",
  "DriverInfo.Drivers[].UserName": "race.competitor.driver-name",
  "DriverInfo.Drivers[].TeamID": "race.competitor.team-id",
  "DriverInfo.Drivers[].TeamName": "race.competitor.team-name",
  "DriverInfo.Drivers[].CarID": "race.competitor.car-id",
  "DriverInfo.Drivers[].CarScreenName": "race.competitor.car-name",
  "DriverInfo.Drivers[].CarScreenNameShort": "race.competitor.car-name",
  "DriverInfo.Drivers[].CarClassID": "race.competitor.car-class-id",
  "DriverInfo.Drivers[].CarClassShortName":
    "race.competitor.car-class-name",
  "DriverInfo.Drivers[].AbbrevName":
    "race.competitor.driver-abbreviated-name",
  "DriverInfo.Drivers[].Initials": "race.competitor.driver-initials",
  "DriverInfo.Drivers[].IRating": "race.competitor.rating",
  "DriverInfo.Drivers[].LicLevel": "race.competitor.license-level",
  "DriverInfo.Drivers[].LicSubLevel": "race.competitor.license-sublevel",
  "DriverInfo.Drivers[].LicString": "race.competitor.license-name",
  "DriverInfo.Drivers[].LicColor": "race.competitor.license-color",
  "DriverInfo.Drivers[].ClubName": "race.competitor.club-name",
  "DriverInfo.Drivers[].DivisionName": "race.competitor.division-name",
  "DriverInfo.Drivers[].IsSpectator": "race.competitor.is-spectator",
  "DriverInfo.Drivers[].CarNumber": "race.competitor.car-number",
  "DriverInfo.Drivers[].CarNumberRaw": "race.competitor.car-number-raw",
  "DriverInfo.Drivers[].CarPath": "race.competitor.car-path",
  "DriverInfo.Drivers[].CarIsAI": "race.competitor.is-ai",
  "DriverInfo.Drivers[].CarIsPaceCar": "race.competitor.is-pace-car",
  "DriverInfo.Drivers[].CarClassColor":
    "race.competitor.car-class-color",
  "DriverInfo.Drivers[].CarClassLicenseLevel":
    "race.competitor.car-class-license-level",
  "DriverInfo.Drivers[].CarClassMaxFuelPct":
    "race.competitor.class-max-fuel-percentage",
  "DriverInfo.Drivers[].CarClassPowerAdjust":
    "race.competitor.class-power-adjust",
  "DriverInfo.Drivers[].CarClassRelSpeed":
    "race.competitor.class-relative-speed",
  "DriverInfo.Drivers[].CarClassWeightPenalty":
    "race.competitor.class-weight-penalty",
  "DriverInfo.Drivers[].CarClassDryTireSetLimit":
    "race.competitor.class-dry-tire-set-limit",
  "DriverInfo.Drivers[].CarClassEstLapTime":
    "timing.competitor.class-estimated-lap-time",
  "DriverInfo.Drivers[].CarIsElectric": "race.competitor.car-electric",
  "DriverInfo.Drivers[].ClubID": "race.competitor.club-id",
  "DriverInfo.Drivers[].DivisionID": "race.competitor.division-id",
  "DriverInfo.Drivers[].CarDesignStr": "race.competitor.car-design",
  "DriverInfo.Drivers[].CarNumberDesignStr":
    "race.competitor.car-number-design",
  "DriverInfo.Drivers[].HelmetDesignStr":
    "race.competitor.helmet-design",
  "DriverInfo.Drivers[].SuitDesignStr": "race.competitor.suit-design",
  "DriverInfo.Drivers[].CarSponsor_1":
    "race.competitor.primary-sponsor",
  "DriverInfo.Drivers[].CarSponsor_2":
    "race.competitor.secondary-sponsor",
  "DriverInfo.Drivers[].CurDriverIncidentCount":
    "race.competitor.driver-incident-count",
  "DriverInfo.Drivers[].TeamIncidentCount":
    "race.competitor.team-incident-count",
  "CameraInfo.Groups[].GroupName": "diagnostics.camera.group-name",
  "CameraInfo.Groups[].GroupNum": "diagnostics.camera.group-number",
  "CameraInfo.Groups[].IsScenic": "diagnostics.camera.group-scenic",
  "CameraInfo.Groups[].Cameras[].CameraName": "diagnostics.camera.name",
  "CameraInfo.Groups[].Cameras[].CameraNum": "diagnostics.camera.number",
  "RadioInfo.SelectedRadioNum": "diagnostics.radio.selected-radio-number",
  "RadioInfo.Radios[].HopCount": "diagnostics.radio.hop-count",
  "RadioInfo.Radios[].NumFrequencies": "diagnostics.radio.frequency-count",
  "RadioInfo.Radios[].RadioNum": "diagnostics.radio.number",
  "RadioInfo.Radios[].ScanningIsOn": "diagnostics.radio.scanning",
  "RadioInfo.Radios[].TunedToFrequencyNum":
    "diagnostics.radio.tuned-frequency-number",
  "RadioInfo.Radios[].Frequencies[].CanScan":
    "diagnostics.radio.frequency-can-scan",
  "RadioInfo.Radios[].Frequencies[].CanSquawk":
    "diagnostics.radio.frequency-can-squawk",
  "RadioInfo.Radios[].Frequencies[].CarIdx":
    "diagnostics.radio.frequency-car-index",
  "RadioInfo.Radios[].Frequencies[].ClubID":
    "diagnostics.radio.frequency-club-id",
  "RadioInfo.Radios[].Frequencies[].EntryIdx":
    "diagnostics.radio.frequency-entry-index",
  "RadioInfo.Radios[].Frequencies[].FrequencyName":
    "diagnostics.radio.frequency-name",
  "RadioInfo.Radios[].Frequencies[].FrequencyNum":
    "diagnostics.radio.frequency-number",
  "RadioInfo.Radios[].Frequencies[].IsDeletable":
    "diagnostics.radio.frequency-deletable",
  "RadioInfo.Radios[].Frequencies[].IsMutable":
    "diagnostics.radio.frequency-mutable",
  "RadioInfo.Radios[].Frequencies[].Muted":
    "diagnostics.radio.frequency-muted",
  "RadioInfo.Radios[].Frequencies[].Priority":
    "diagnostics.radio.frequency-priority",
  "SplitTimeInfo.Sectors[].SectorNum": "timing.sector.layout.indexes",
  "SplitTimeInfo.Sectors[].SectorStartPct":
    "timing.sector.layout.start-fractions",
};

function addIRacingYamlField(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
  field: (typeof IRACING_SESSION_INFO_CATALOG_FIELDS)[number],
): void {
  const semanticId =
    field.semanticId ??
    IRACING_YAML_ALIASES[field.path] ??
    `${categoryFor(`${field.path} ${field.description}`)}.${slug(field.path)}`;
  const definition = SEMANTIC_DEFINITIONS[semanticId];
  const category = categoryFor(`${field.path} ${field.description}`);
  const semanticRoot = semanticId.split(".")[0];
  let variable = variables.get(semanticId);

  if (!variable) {
    variable = {
      id: semanticId,
      label: definition?.label ?? field.label,
      description: definition?.description ?? field.description,
      parentId:
        definition?.parentId ?? (groups.has(semanticRoot) ? semanticRoot : category),
      canonicalUnit: definition?.canonicalUnit ?? field.unit,
      shape:
        definition?.shape ??
        (field.path.includes("[]") || field.path.endsWith(".**")
          ? "structured"
          : "scalar"),
      games: unavailableGames(
        "No equivalent source value is currently identified for this parser.",
      ),
    };
    variables.set(semanticId, variable);
    attachChild(groups, variable.parentId, semanticId);
  }

  const sourcePath = `iRacing.SessionInfo.${field.path}`;
  const requiresCurrentSessionSelection = [
    "SessionInfo.Sessions[].SessionType",
    "SessionInfo.Sessions[].SessionLaps",
  ].includes(field.path);
  const existing = variable.games.iracing;
  if (existing.kind === "unavailable") {
    variable.games.iracing = {
      kind:
        !requiresCurrentSessionSelection &&
        (field.unit === variable.canonicalUnit || field.unit === "structured")
          ? "direct"
          : "normalized",
      nativeUnit: field.unit,
      sources: [sourcePath],
      freshness: "session-update",
      ...(requiresCurrentSessionSelection
        ? {
            normalization: "select YAML entry matching current session number",
          }
        : field.unit !== variable.canonicalUnit && field.unit !== "structured"
          ? {
              normalization: `parse YAML ${field.unit} as ${variable.canonicalUnit}`,
            }
        : {}),
      description:
        field.retention === "exact"
          ? "Complete SessionInfo YAML is preserved verbatim by iRacing source-frame v3."
          : field.retention === "normalized"
            ? "iRacing YAML field is normalized into the source-frame session summary."
            : "iRacing YAML field is catalogued but not retained by the source frame.",
    };
  } else if (Array.isArray(existing.sources)) {
    if (!existing.sources.includes(sourcePath)) existing.sources.push(sourcePath);
    if (requiresCurrentSessionSelection) {
      existing.kind = "normalized";
      appendNormalization(
        existing,
        "select YAML entry matching current session number",
      );
    } else if (
      field.unit === "value-with-unit" &&
      field.unit !== variable.canonicalUnit
    ) {
      existing.kind = "normalized";
      appendNormalization(
        existing,
        `parse YAML value-with-unit as ${variable.canonicalUnit}`,
      );
    }
  }

  addSource(inventories, "iracing", {
    path: `SessionInfo.${field.path}`,
    label: field.label,
    unit: field.unit,
    dataType: "yaml",
    ...(!field.path.includes("[]") && !field.path.endsWith(".**")
      ? { count: 1 }
      : {}),
    description: field.description,
    semanticId,
    sourceKind: "yaml",
    recordedByRaceIQ: field.retention === "exact",
    retention: field.retention,
  });
}

function addIRacingRawYamlSource(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
): void {
  const field = IRACING_SESSION_INFO_RAW_SOURCE;
  const semanticId = field.semanticId!;
  const games = unavailableGames(
    "No equivalent raw SessionInfo YAML source is provided by this parser.",
  );
  games.iracing = {
    kind: "direct",
    nativeUnit: field.unit,
    sources: ["iRacing.SessionInfo"],
    freshness: "session-update",
    description:
      "Complete SessionInfo YAML is preserved verbatim by iRacing source-frame v3.",
  };
  variables.set(semanticId, {
    id: semanticId,
    label: field.label,
    description: field.description,
    parentId: "diagnostics",
    canonicalUnit: field.unit,
    shape: "structured",
    games,
  });
  attachChild(groups, "diagnostics", semanticId);

  addSource(inventories, "iracing", {
    path: field.path,
    label: field.label,
    unit: field.unit,
    dataType: "string",
    count: 1,
    description: field.description,
    semanticId,
    sourceKind: "yaml",
    recordedByRaceIQ: true,
    retention: field.retention,
  });
}

function addSetupFileVariable(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
  gameId: "acc" | "ac-evo",
  field: ReturnType<typeof getSchemaForGame>[number]["fields"][number],
): void {
  const mapping = SETUP_FILE_SOURCE_MAPPINGS[field.path];
  if (!mapping) {
    throw new Error(`Missing setup-file semantic mapping for ${field.path}`);
  }
  const definition = SEMANTIC_DEFINITIONS[mapping.semanticId];
  if (!definition) {
    throw new Error(`Missing setup semantic definition ${mapping.semanticId}`);
  }

  let variable = variables.get(mapping.semanticId);
  if (!variable) {
    variable = {
      id: mapping.semanticId,
      ...definition,
      games: unavailableGames(
        "No equivalent setup source is currently identified for this game.",
      ),
    };
    variables.set(mapping.semanticId, variable);
    attachChild(groups, definition.parentId, mapping.semanticId);
  }

  const sourcePath = `${gameId === "acc" ? "ACC" : "ACEvo"}.SetupFile.${field.path}`;
  const existing = variable.games[gameId];
  if (existing.kind === "unavailable") {
    variable.games[gameId] = {
      kind: mapping.kind ?? "direct",
      nativeUnit: mapping.nativeUnit,
      sources: [sourcePath],
      freshness: "static",
      ...(mapping.normalization
        ? { normalization: mapping.normalization }
        : {}),
      description: `${gameId} setup file exposes this ${field.arity} value.`,
    };
  } else if (Array.isArray(existing.sources)) {
    if (!existing.sources.includes(sourcePath)) {
      existing.sources.push(sourcePath);
    }
  }

  addSource(inventories, gameId, {
    path: sourcePath,
    label: field.label,
    unit: mapping.nativeUnit,
    dataType: "setup-value",
    count: 1,
    description: `${field.label} from ${gameId} setup file${field.hint ? `; ${field.hint}` : ""}.`,
    semanticId: mapping.semanticId,
    sourceKind: "setup",
    recordedByRaceIQ: false,
    retention: "not-recorded",
  });
}

function addDefinedVariable(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  id: string,
  games: Record<GameId, GameLink>,
): void {
  if (variables.has(id)) return;
  const definition = SEMANTIC_DEFINITIONS[id];
  if (!definition) throw new Error(`Missing semantic definition ${id}`);
  variables.set(id, {
    id,
    ...definition,
    games,
  });
  attachChild(groups, definition.parentId, id);
}

function derivedLink(
  nativeUnit: string,
  sources: string[],
  normalization: string,
  description: string,
  freshness: AvailableLink["freshness"] = "continuous",
): AvailableLink {
  return {
    kind: "derived",
    nativeUnit,
    sources,
    freshness,
    normalization,
    description,
  };
}

function normalizedLink(
  nativeUnit: string,
  sources: string[],
  normalization: string,
  description: string,
  freshness: AvailableLink["freshness"] = "continuous",
): AvailableLink {
  return {
    kind: "normalized",
    nativeUnit,
    sources,
    freshness,
    normalization,
    description,
  };
}

function addSectorDerivedVariables(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
): void {
  const currentIndex = variables.get("timing.sector.current-index");
  if (!currentIndex) throw new Error("Missing current-sector semantic variable");
  currentIndex.games["fm-2023"] = derivedLink(
    "m",
    ["TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
    "select sector containing current lap distance",
    "RaceIQ derives sector index from curated track boundaries.",
  );
  currentIndex.games["ac-evo"] = derivedLink(
    "m",
    ["TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
    "select sector containing current lap distance",
    "AC Evo sector fields are placeholders, so RaceIQ uses curated track boundaries.",
  );
  currentIndex.games.iracing = derivedLink(
    "fraction",
    ["iracing.lapDistancePct", "iracing.sectorStarts"],
    "select greatest sector start not above current lap fraction",
    "RaceIQ derives current sector from native iRacing SplitTimeInfo layout.",
  );

  const layoutIndexes = variables.get("timing.sector.layout.indexes");
  if (layoutIndexes) {
    for (const gameId of GAME_IDS) {
      if (layoutIndexes.games[gameId].kind !== "unavailable") continue;
      layoutIndexes.games[gameId] = derivedLink(
        "count",
        gameId === "iracing"
          ? ["iracing.sectorStarts"]
          : ["RaceIQ.Track.sectorStarts"],
        "generate sequential zero-based indexes for each sector boundary",
        `${gameId} sector indexes follow ordered sector boundary list.`,
        "static",
      );
    }
  }

  const layoutStarts = variables.get("timing.sector.layout.start-fractions");
  if (layoutStarts) {
    for (const gameId of ["fm-2023", "f1-2025", "acc", "ac-evo"] as const) {
      layoutStarts.games[gameId] = derivedLink(
        "fraction",
        ["RaceIQ.Track.sectorStarts"],
        "use curated track-specific sector start fractions",
        gameId === "f1-2025"
          ? "F1 packets provide authoritative times but not boundary distances; RaceIQ layout is display/derivation metadata."
          : `${gameId} uses RaceIQ curated track-sector boundaries.`,
        "static",
      );
    }
  }

  const unavailableByDefault = (description: string) =>
    unavailableGames(description);

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.current-time",
    {
      "fm-2023": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "RaceIQ.Track.sectorStarts"],
        "current lap time - time at current sector entry",
        "RaceIQ times curated sector-boundary crossings.",
      ),
      "f1-2025": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "f1.currentSector", "f1.sector1Time", "f1.sector2Time"],
        "subtract completed current-lap sector times from lap elapsed time",
        "RaceIQ derives running F1 sector time from native completed splits.",
      ),
      acc: derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "acc.currentSectorIndex"],
        "current lap time - time at native sector-index transition",
        "RaceIQ times ACC native sector transitions.",
      ),
      "ac-evo": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
        "current lap time - time at curated sector boundary",
        "RaceIQ derives AC Evo sector timing from lap distance.",
      ),
      iracing: derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "iracing.lapDistancePct", "iracing.sectorStarts"],
        "current lap time - time at native sector boundary",
        "RaceIQ times crossings of iRacing native variable-length sector layout.",
      ),
    },
  );

  for (const sector of ["s1", "s2", "s3"] as const) {
    const currentId = `timing.sector.current-lap.${sector}`;
    if (!variables.has(currentId)) {
      addDefinedVariable(
        variables,
        groups,
        currentId,
        unavailableGames("No native fixed-sector field is exposed."),
      );
    }
    const current = variables.get(currentId)!;
    for (const gameId of GAME_IDS) {
      if (current.games[gameId].kind !== "unavailable") continue;
      current.games[gameId] = derivedLink(
        "s",
        ["LiveSectorData.currentTimes"],
        `select sector index ${Number(sector.slice(1)) - 1}`,
        `${gameId} fixed ${sector.toUpperCase()} projection is derived from current variable-length sector array.`,
      );
    }

    const lastId = `timing.sector.last-lap.${sector}`;
    if (!variables.has(lastId)) {
      addDefinedVariable(
        variables,
        groups,
        lastId,
        unavailableGames("No native fixed-sector field is exposed."),
      );
    }
    const last = variables.get(lastId)!;
    for (const gameId of GAME_IDS) {
      if (last.games[gameId].kind !== "unavailable") continue;
      last.games[gameId] = derivedLink(
        "s",
        ["LapMeta.sectorTimes"],
        `select sector index ${Number(sector.slice(1)) - 1}`,
        `${gameId} fixed ${sector.toUpperCase()} projection is derived from persisted variable-length sector array.`,
        "static",
      );
    }
  }

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.current-lap.times",
    {
      "fm-2023": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
        "accumulate elapsed time between curated sector boundaries",
        "RaceIQ assembles current Forza sector array.",
      ),
      "f1-2025": derivedLink(
        "s",
        ["f1.sector1Time", "f1.sector2Time", "TelemetryPacket.CurrentLap"],
        "[S1, S2, current S3 running time]",
        "RaceIQ assembles current F1 three-sector array from native splits.",
      ),
      acc: derivedLink(
        "ms",
        ["acc.currentSectorIndex", "acc.lastSectorTime", "TelemetryPacket.CurrentLap"],
        "append native completed sector milliseconds and running sector seconds",
        "RaceIQ assembles current ACC sector array from native transitions.",
      ),
      "ac-evo": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
        "accumulate elapsed time between curated sector boundaries",
        "RaceIQ assembles current AC Evo sector array.",
      ),
      iracing: derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "iracing.lapDistancePct", "iracing.sectorStarts"],
        "accumulate elapsed time between native variable-length sector boundaries",
        "RaceIQ assembles current iRacing sector array.",
      ),
    },
  );

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.last-lap.times",
    {
      "fm-2023": derivedLink(
        "s",
        ["LapMeta.sectorTimes", "TelemetryPacket.LastLap"],
        "persist sector-boundary timings and derive final sector from lap total",
        "RaceIQ stores last completed Forza sector array.",
      ),
      "f1-2025": derivedLink(
        "s",
        ["f1.lapSectors.s1", "f1.lapSectors.s2", "f1.lapSectors.s3"],
        "select most recently completed lap from lap-number-keyed SessionHistory records",
        "RaceIQ selects definitive F1 splits for most recently completed lap.",
      ),
      acc: derivedLink(
        "ms",
        ["acc.currentSectorIndex", "acc.lastSectorTime", "TelemetryPacket.LastLap"],
        "assemble native completed sectors; final sector = lap time - prior sectors",
        "RaceIQ stores completed ACC sector array.",
      ),
      "ac-evo": derivedLink(
        "s",
        ["LapMeta.sectorTimes", "TelemetryPacket.LastLap"],
        "persist curated-boundary timings and derive final sector from lap total",
        "RaceIQ stores completed AC Evo sector array.",
      ),
      iracing: derivedLink(
        "s",
        ["iracing.sectorStarts", "iracing.lapDistancePct", "TelemetryPacket.CurrentLap", "TelemetryPacket.LastLap"],
        "time native boundary crossings; final sector = lap time - prior sectors",
        "RaceIQ stores variable-length iRacing sector array.",
      ),
    },
  );

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.best-times",
    Object.fromEntries(
      GAME_IDS.map((gameId) => [
        gameId,
        derivedLink(
          "s",
          ["LapMeta.sectorTimes"],
          "minimum valid time at each sector index across completed laps",
          `${gameId} best sectors are derived from RaceIQ persisted lap-sector arrays.`,
          "static",
        ),
      ]),
    ) as Record<GameId, GameLink>,
  );

  const lastCompleted = variables.get("timing.sector.last-completed-time");
  if (lastCompleted) {
    lastCompleted.games["f1-2025"] = derivedLink(
      "s",
      ["f1.currentSector", "f1.sector1Time", "f1.sector2Time", "f1.lastS3"],
      "select split belonging to most recently completed sector",
      "RaceIQ selects last completed F1 split from native sector-specific fields.",
    );
    lastCompleted.games["fm-2023"] = derivedLink(
      "s",
      ["LiveSectorData.currentTimes"],
      "select most recently completed entry",
      "RaceIQ derives from curated boundary timing.",
    );
    lastCompleted.games["ac-evo"] = derivedLink(
      "s",
      ["LiveSectorData.currentTimes"],
      "select most recently completed entry",
      "RaceIQ derives from curated boundary timing.",
    );
    lastCompleted.games.iracing = derivedLink(
      "s",
      ["LiveSectorData.currentTimes"],
      "select most recently completed entry",
      "RaceIQ derives from native iRacing sector boundaries.",
    );
  }

  // Ensure all custom mappings still satisfy every-game catalog contract.
  for (const id of [
    "timing.sector.current-time",
    "timing.sector.current-lap.times",
    "timing.sector.last-lap.times",
    "timing.sector.best-times",
  ]) {
    const variable = variables.get(id);
    if (!variable) continue;
    for (const gameId of GAME_IDS) {
      variable.games[gameId] ??= unavailableByDefault(
        "No equivalent sector value is currently available.",
      )[gameId];
    }
  }
}

function addCrossSourceProjections(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
): void {
  const physicalSlipAngle = variables.get("tires.tire-slip-angle");
  const normalizedSlipAngle = variables.get(
    "tires.normalized-tire-slip-angle",
  );
  if (physicalSlipAngle && normalizedSlipAngle) {
    physicalSlipAngle.games["fm-2023"] = unavailable(
      "source-not-provided",
      "Forza exposes a normalized lateral-slip signal, not a physical slip angle in radians.",
    );
    const forzaSlipFields = [
      "TireSlipAngleFL",
      "TireSlipAngleFR",
      "TireSlipAngleRL",
      "TireSlipAngleRR",
    ];
    normalizedSlipAngle.packetFields = [
      ...new Set([
        ...(normalizedSlipAngle.packetFields ?? []),
        ...forzaSlipFields,
      ]),
    ];
    normalizedSlipAngle.games["fm-2023"] = {
      kind: "direct",
      nativeUnit: "ratio",
      sources: Object.fromEntries(
        ["FL", "FR", "RL", "RR"].map((wheel, index) => [
          wheel,
          [`ForzaDataOut.${forzaSlipFields[index]}`],
        ]),
      ),
      freshness: "continuous",
      description:
        "Forza provides source-normalized per-wheel lateral slip rather than a physical angle.",
    };
  }

  const lapsRemaining = variables.get("session.laps-remaining");
  if (lapsRemaining) {
    lapsRemaining.games.iracing = normalizedLink(
      "count",
      ["iRacing.SessionLapsRemainEx", "iRacing.SessionLapsRemain"],
      "prefer improved SessionLapsRemainEx; fallback to deprecated SessionLapsRemain",
      "RaceIQ can use improved iRacing laps-remaining value with legacy fallback.",
    );
  }

  const pitServicePressure = variables.get("race.pit-service.tire-pressure");
  if (pitServicePressure) {
    pitServicePressure.games.iracing = {
      kind: "direct",
      nativeUnit: "kPa",
      sources: {
        FL: ["iRacing.PitSvLFP"],
        FR: ["iRacing.PitSvRFP"],
        RL: ["iRacing.PitSvLRP"],
        RR: ["iRacing.PitSvRRP"],
      },
      freshness: "continuous",
      description:
        "iRacing exposes requested cold pressure separately for each pit-service tire.",
    };
  }

  const lapFraction = variables.get("timing.lap-fraction");
  if (lapFraction) {
    lapFraction.games["f1-2025"] = derivedLink(
      "m",
      ["TelemetryPacket.DistanceTraveled", "f1.trackLength"],
      "clamp current-lap distance / track length to 0-1",
      "RaceIQ can derive F1 lap fraction from native lap distance and track length.",
    );
    lapFraction.games["ac-evo"] = derivedLink(
      "m and km",
      ["TelemetryPacket.DistanceTraveled", "acc.acEvo.lapLengthKm"],
      "(session distance modulo (lap length km * 1000)) / (lap length km * 1000)",
      "RaceIQ can derive AC Evo lap fraction from integrated distance and lap length.",
    );
  }

  const compound = variables.get("tires.tire-compound");
  if (compound) {
    compound.games.acc = {
      kind: "simplified",
      nativeUnit: "text",
      sources: ["acc.tireCompound"],
      freshness: "continuous",
      normalization: "retain source compound name as common representation",
      description: "ACC common compound is projected from detailed source name.",
    };
    compound.games["ac-evo"] = {
      kind: "simplified",
      nativeUnit: "text",
      sources: ["acc.tireCompound"],
      freshness: "continuous",
      normalization: "retain source compound name as common representation",
      description: "AC Evo common compound is projected from detailed source name.",
    };
    compound.games.iracing = {
      kind: "simplified",
      nativeUnit: "id",
      sources: ["iRacing.PlayerTireCompound"],
      freshness: "continuous",
      normalization: "retain source compound code as common representation",
      description: "iRacing common compound is projected from detailed source code.",
    };
  }

  addDefinedVariable(variables, groups, "fuel.remaining-volume", {
    "fm-2023": unavailable(
      "source-not-provided",
      "Forza packet provides fuel fraction but no tank capacity, so litres cannot be derived safely.",
    ),
    "f1-2025": derivedLink(
      "fraction and L",
      ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
      "fuel fraction * fuel capacity",
      "RaceIQ derives F1 fuel volume from native fraction and capacity.",
    ),
    acc: {
      kind: "direct",
      nativeUnit: "L",
      sources: ["TelemetryPacket.Fuel"],
      freshness: "continuous",
      description: "ACC normalized packet retains source fuel litres.",
    },
    "ac-evo": {
      kind: "direct",
      nativeUnit: "L",
      sources: ["TelemetryPacket.Fuel"],
      freshness: "continuous",
      description: "AC Evo normalized packet retains source fuel litres.",
    },
    iracing: {
      kind: "direct",
      nativeUnit: "L",
      sources: ["TelemetryPacket.Fuel"],
      freshness: "continuous",
      description: "iRacing normalized packet retains SDK fuel litres.",
    },
  });

  const fuelPercent = variables.get("fuel.fuel-percent");
  if (fuelPercent) {
    fuelPercent.games["fm-2023"] = normalizedLink(
      "fraction",
      ["TelemetryPacket.Fuel"],
      "fraction * 100",
      "RaceIQ converts Forza fuel fraction to percentage.",
    );
    fuelPercent.games["f1-2025"] = normalizedLink(
      "fraction",
      ["TelemetryPacket.Fuel"],
      "fraction * 100",
      "RaceIQ converts F1 fuel fraction to percentage.",
    );
    for (const gameId of ["acc", "ac-evo"] as const) {
      fuelPercent.games[gameId] = derivedLink(
        "L",
        ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
        "fuel litres / capacity litres * 100",
        `RaceIQ derives ${gameId} fuel percentage from volume and capacity.`,
      );
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function telemetryCatalogSourceHash(source: string): string {
  return contentHash(source.replace(/\r\n?/g, "\n"));
}

const ENUM_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  "fuel.ers-deploy-mode": ["0", "1", "2", "3", "4"],
  "race.driver-change-lap-status": ["0", "1", "2", "3"],
  "setup.tires.compound": ["0", "1"],
  "tires.tire-compound": [
    "7",
    "8",
    "16",
    "17",
    "18",
    "dry_compound",
    "wet_compound",
  ],
  "weather.skies": [
    "0",
    "1",
    "2",
    "3",
    "clear",
    "partly cloudy",
    "mostly cloudy",
    "overcast",
  ],
  "weather.weather-type": [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "constant",
    "dynamic",
  ],
};


function dimensionForUnit(unit: string): readonly string[] {
  const normalized = unit.trim().toLowerCase();
  if (
    [
      "boolean",
      "bool",
      "text",
      "string",
      "structured",
      "id",
      "identifier",
      "code",
      "flags",
      "bitmask",
      "count",
      "index",
      "ratio",
      "fraction",
      "%",
      "percent",
      "0-1",
      "0-100",
      "0-255",
      "-128-127",
      "game-native",
      "value-with-unit",
      "unknown",
    ].includes(normalized)
  ) {
    return ["dimensionless"];
  }
  if (/^(s|ms|min|h)$/.test(normalized)) return ["time"];
  if (/^(m|mm|cm|km|ft|in)$/.test(normalized)) return ["length"];
  if (/^(m\/s|km\/h|mph)$/.test(normalized)) return ["length", "time^-1"];
  if (/^(m\/s(?:\^?2|²)|g)$/.test(normalized)) {
    return ["length", "time^-2"];
  }
  if (/^(rad|deg|°)$/.test(normalized)) return ["angle"];
  if (/^(rad\/s|deg\/s|rpm)$/.test(normalized)) {
    return ["angle", "time^-1"];
  }
  if (/^(°c|°f|c|f|k)$/.test(normalized)) return ["temperature"];
  if (/^(pa|kpa|bar|psi)$/.test(normalized)) {
    return ["mass", "length^-1", "time^-2"];
  }
  if (/^(l|ml|gal)$/.test(normalized)) return ["length^3"];
  if (/^(kg|g)$/.test(normalized)) return ["mass"];
  if (/^(n)$/.test(normalized)) return ["mass", "length", "time^-2"];
  if (/^(nm)$/.test(normalized)) return ["mass", "length^2", "time^-2"];
  if (/^(j|kj|mj)$/.test(normalized)) {
    return ["mass", "length^2", "time^-2"];
  }
  if (/^(w|kw|hp)$/.test(normalized)) {
    return ["mass", "length^2", "time^-3"];
  }
  if (/^(a)$/.test(normalized)) return ["electric-current"];
  if (/^(v)$/.test(normalized)) {
    return ["mass", "length^2", "time^-3", "electric-current^-1"];
  }
  if (/^(kg\/m\^?3)$/.test(normalized)) return ["mass", "length^-3"];
  return [`unit:${normalized}`];
}

function scalarValueTypeFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): Exclude<ValueType, "structured"> {
  const unit = variable.canonicalUnit.toLowerCase();
  const sourceTypes = sourceVariables
    .map((source) => source.dataType?.toLowerCase() ?? "")
    .filter(Boolean);
  if (unit === "boolean" || sourceTypes.some((type) => /\bbool/.test(type))) {
    return "boolean";
  }
  if (
    unit === "text" ||
    unit === "string" ||
    sourceTypes.some((type) => /\bstring\b/.test(type))
  ) {
    return "string";
  }
  if (unit === "enum" || sourceTypes.some((type) => /\benum\b/.test(type))) {
    return "enum";
  }
  return "number";
}

function valueTypeFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): ValueType {
  return variable.shape === "structured"
    ? "structured"
    : scalarValueTypeFor(variable, sourceVariables);
}

function structuredSchemaFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): StructuredValueSchema {
  const mappingSources = GAME_IDS.flatMap((gameId) => {
    const mapping = variable.games[gameId];
    if (mapping.kind === "unavailable") return [];
    return Array.isArray(mapping.sources)
      ? mapping.sources
      : Object.values(mapping.sources).flat();
  });
  const sourceMax = Math.max(
    0,
    ...sourceVariables.map((source) => source.count ?? 0),
  );
  let indices: StructuredIndexSchema[];
  if (variable.id.includes(".competitor.")) {
    indices = [
      {
        id: "competitor-index",
        cardinality: { kind: "variable", min: 0, max: Math.max(64, sourceMax) },
        ordering: "numeric-ascending",
      },
    ];
  } else if (variable.id.includes(".lap-history.")) {
    indices = [
      {
        id: "lap-number",
        cardinality: { kind: "variable", min: 0 },
        ordering: "numeric-ascending",
      },
    ];
  } else if (
    variable.id === "setup.tires.last-temperature-bands" ||
    variable.id === "setup.tires.tread-remaining"
  ) {
    indices = [
      {
        id: "wheel-position",
        cardinality: { kind: "fixed", count: 4 },
        ordering: "semantic-order",
      },
    ];
  } else if (variable.id === "setup.brakes.pad-compound") {
    indices = [
      {
        id: "axle-position",
        cardinality: { kind: "fixed", count: 2 },
        ordering: "semantic-order",
      },
    ];
  } else {
    const sourceIndices = [
      ...new Set(
        mappingSources.flatMap((source) =>
          [...source.matchAll(/([A-Za-z][A-Za-z0-9]*)\[\]/g)].map(
            (match) => `${slug(match[1].replace(/s$/i, ""))}-index`,
          ),
        ),
      ),
    ];
    indices =
      sourceIndices.length > 0
        ? sourceIndices.map((id) => ({
            id,
            cardinality: { kind: "variable" as const, min: 0 },
            ordering: "source-order" as const,
          }))
        : [
            {
              id: "source-path",
              cardinality:
                sourceMax > 1
                  ? { kind: "variable" as const, min: 0, max: sourceMax }
                  : { kind: "variable" as const, min: 0 },
              ordering: "source-order" as const,
            },
          ];
  }
  const scalarType = scalarValueTypeFor(variable, sourceVariables);
  const enumDomain = ENUM_DOMAINS[variable.id];
  const valueType =
    scalarType === "enum" && !enumDomain
      ? sourceVariables.some((source) =>
          /\bstring\b/i.test(source.dataType ?? ""),
        )
        ? ("string" as const)
        : ("number" as const)
      : scalarType;
  const fields: StructuredFieldSchema[] =
    variable.id === "setup.metadata.unmapped-source-values"
      ? [
          {
            id: "source-path",
            valueType: "string",
            dimensions: ["dimensionless"],
          },
          {
            id: "value",
            valueType: "string",
            dimensions: ["dimensionless"],
          },
        ]
      : [
          {
            id: "value",
            valueType,
            dimensions: dimensionForUnit(variable.canonicalUnit),
            ...(valueType === "enum" ? { enumDomain } : {}),
          },
        ];
  return { indices, fields };
}

function cardinalityFor(
  variable: CatalogVariable,
  sourceVariables: readonly SourceVariable[],
): Pick<CatalogVariable, "cardinality" | "ordering" | "structuredSchema"> {
  switch (variable.shape) {
    case "per-wheel":
      return {
        cardinality: { kind: "fixed", count: 4 },
        ordering: ["FL", "FR", "RL", "RR"],
      };
    case "vector":
      return {
        cardinality: { kind: "fixed", count: 3 },
        ordering: ["x", "y", "z"],
      };
    case "array":
      return {
        cardinality: { kind: "variable", min: 0 },
        ordering: ["source-order"],
      };
    case "structured": {
      const structuredSchema = structuredSchemaFor(variable, sourceVariables);
      const [primaryIndex] = structuredSchema.indices;
      const ordering =
        primaryIndex.id === "wheel-position"
          ? ["FL", "FR", "RL", "RR"]
          : primaryIndex.id === "axle-position"
            ? ["front", "rear"]
            : [`${primaryIndex.id}:${primaryIndex.ordering}`];
      return {
        cardinality: primaryIndex.cardinality,
        ordering,
        structuredSchema,
      };
    }
    default:
      return { cardinality: { kind: "scalar" } };
  }
}

function rangeForUnit(
  unit: string,
): CatalogVariable["range"] | undefined {
  switch (unit.toLowerCase()) {
    case "fraction":
    case "ratio":
    case "0-1":
      return { min: 0, max: 1 };
    case "%":
    case "percent":
    case "0-100":
      return { min: 0, max: 100 };
    case "0-255":
      return { min: 0, max: 255 };
    case "-128-127":
      return { min: -128, max: 127 };
    default:
      return undefined;
  }
}

function mappingArtifact(
  gameId: GameId,
  sources: readonly string[],
): Pick<MappingProvenance, "origin" | "artifact"> {
  if (
    sources.some(
      (source) =>
        source === "iRacing.SessionInfo" ||
        source.includes(".SessionInfo."),
    )
  ) {
    return {
      origin: "yaml",
      artifact: "shared/games/iracing/session-info/catalog.ts",
    };
  }
  if (sources.some((source) => source.includes(".SetupFile."))) {
    return { origin: "schema", artifact: "shared/setups/schema.ts" };
  }
  if (
    sources.some((source) =>
      /^(RaceIQ\.|LiveSectorData\.|LapMeta\.)/.test(source),
    )
  ) {
    return {
      origin: "derivation",
      artifact: "scripts/generate-telemetry-catalog.ts",
    };
  }
  return { origin: "parser", artifact: PARSER_FILES[gameId] };
}

function enrichCatalogContracts(
  variables: Map<string, CatalogVariable>,
  inventories: Record<GameId, SourceVariable[]>,
  provenanceCommits: Readonly<Record<string, string>>,
): void {
  const allSources = GAME_IDS.flatMap((gameId) => inventories[gameId]);
  for (const variable of variables.values()) {
    const sourceVariables = allSources.filter(
      (source) => source.semanticId === variable.id,
    );
    variable.valueType ??= valueTypeFor(variable, sourceVariables);
    variable.dimensions ??= dimensionForUnit(variable.canonicalUnit);
    const cardinality = cardinalityFor(variable, sourceVariables);
    variable.cardinality ??= cardinality.cardinality;
    variable.ordering ??= cardinality.ordering;
    variable.structuredSchema ??= cardinality.structuredSchema;
    if (variable.valueType === "enum") {
      variable.enumDomain ??= ENUM_DOMAINS[variable.id];
      if (!variable.enumDomain?.length) {
        throw new Error(`Missing authoritative enum domain for ${variable.id}`);
      }
    }
    variable.range ??= rangeForUnit(variable.canonicalUnit);
    variable.limitations ??= [];

    for (const gameId of GAME_IDS) {
      const mapping = variable.games[gameId];
      if (mapping.kind === "unavailable") continue;
      const sources = Array.isArray(mapping.sources)
        ? mapping.sources
        : Object.values(mapping.sources).flat();
      if (
        mapping.kind === "direct" &&
        mapping.nativeUnit !== variable.canonicalUnit
      ) {
        mapping.kind = "normalized";
        mapping.normalization ??=
          `convert ${mapping.nativeUnit} to ${variable.canonicalUnit}`;
      }
      if (mapping.kind === "normalized" && !mapping.normalization) {
        throw new Error(
          `Normalized telemetry mapping ${gameId}:${variable.id} requires normalization metadata`,
        );
      }
      const artifact =
        mapping.kind === "simplified"
          ? {
              origin: "projection" as const,
              artifact: "scripts/generate-telemetry-catalog.ts",
            }
          : mappingArtifact(gameId, sources);
      mapping.provenance ??= {
        ...artifact,
        commit:
          provenanceCommits[artifact.artifact] ??
          provenanceCommits["scripts/generate-telemetry-catalog.ts"]!,
      };
      mapping.limitations ??=
        mapping.kind === "simplified"
          ? [
              "Reduced-detail representation; unsuitable when direct semantic fidelity is required.",
            ]
          : [];
      if (mapping.kind !== "direct") {
        const execution = {
          kind:
            mapping.kind === "normalized"
              ? ("conversion" as const)
              : mapping.kind === "derived"
                ? ("derivation" as const)
                : ("simplification" as const),
          id: `${gameId}:${variable.id}:${mapping.kind}`,
          version: DERIVATION_VERSION,
          deterministic: true,
          declaredInputs: sources,
          missingDataPolicy:
            /available|fallback|prefer/i.test(mapping.normalization ?? "")
              ? ("drop-missing" as const)
              : ("require-all" as const),
        };
        mapping.execution ??= {
          ...execution,
          codeHash: contentHash({
            ...execution,
            normalization: mapping.normalization,
          }),
        };
      }
    }
  }
}

export async function buildTelemetryCatalog(): Promise<BuiltTelemetryCatalog> {
  const iracingSessionInfoCaptures =
    await readIRacingSessionInfoCaptures(
      IRACING_SESSION_INFO_CAPTURE_DIRECTORY,
    );
  assertIRacingSessionInfoCaptureCoverage(
    iracingSessionInfoCaptures,
    IRACING_SESSION_INFO_CATALOG_FIELDS,
  );
  const iracingSessionInfoCaptureArtifacts =
    iracingSessionInfoCaptures.map(
      ({ fileName }) =>
        `data/diagnostics/iracing-session-info/${fileName}`,
    );
  const [
    typesSource,
    f1TypesSource,
    kunosTypesSource,
    iracingTypesSource,
  ] = await Promise.all(
    TELEMETRY_TYPE_SOURCE_FILES.map((path) =>
      readFile(resolve(ROOT, path), "utf8"),
    ),
  );
  const typesTree = ast(typesSource);
  const f1TypesTree = ast(f1TypesSource);
  const kunosTypesTree = ast(kunosTypesSource);
  const iracingTypesTree = ast(iracingTypesSource);
  const packetFields = interfaceFields(
    typesSource,
    typesTree,
    "TelemetryPacket",
  ).filter((field) => !["gameId", "f1", "acc", "iracing"].includes(field.name));
  const packetFieldNames = packetFields.map((field) => field.name);
  const packetSets = wheelFieldSets(packetFieldNames);

  const parserOutputs = Object.fromEntries(
    await Promise.all(
      GAME_IDS.map(async (gameId) => [gameId, await parserOutput(gameId)]),
    ),
  ) as Record<GameId, ParserOutput>;

  const groups = new Map<string, CatalogGroup>();
  const variables = new Map<string, CatalogVariable>();
  ensureCategoryGroups(groups);

  const inventories: Record<GameId, SourceVariable[]> = {
    "fm-2023": [],
    "f1-2025": [],
    acc: [],
    "ac-evo": [],
    iracing: [],
  };

  for (const set of packetSets) {
    const semantic = normalizedSemantic(set);
    const semanticDefinition = SEMANTIC_DEFINITIONS[semantic.id];
    const fieldInfo = packetFields.find((field) => field.name === set.fields[0]);
    const inferredUnit =
      set.key === "Fuel"
        ? "game-native"
        : unitFor(set.key, fieldInfo?.type);
    const unit = semanticDefinition?.canonicalUnit ?? inferredUnit;
    const description =
      semanticDefinition?.description ??
      (TIRE_IDS[set.key]?.[0] === "tire.temperature.average"
        ? "Common one-value-per-tire temperature. Mapping may be native or a documented average of detailed channels."
        : DESCRIPTION_OVERRIDES[set.key] ??
          fieldInfo?.description ??
          `${humanize(set.key)} reported by normalized RaceIQ telemetry.`);
    const gameLinks = Object.fromEntries(
      GAME_IDS.map((gameId) => {
        const link = packetGameLink(
          gameId,
          set,
          parserOutputs[gameId],
          set.key === "Fuel" ? nativeFuelUnit(gameId) : unit,
        );
        return [gameId, link];
      }),
    ) as Record<GameId, GameLink>;

    const variable: CatalogVariable = {
      id: semantic.id,
      label: semantic.label,
      description,
      parentId: semanticDefinition?.parentId ?? semantic.parentId,
      canonicalUnit: unit,
      shape: semanticDefinition?.shape ?? set.shape,
      packetFields: set.fields,
      games: gameLinks,
    };
    const existingPacketFields = variables.get(variable.id)?.packetFields ?? [];
    variable.packetFields = [
      ...new Set([...existingPacketFields, ...(variable.packetFields ?? [])]),
    ];
    variables.set(variable.id, variable);
    attachChild(groups, variable.parentId, variable.id);

    for (const gameId of GAME_IDS) {
      for (const field of set.fields) {
        if (!parserOutputs[gameId].properties.has(field)) continue;
        addSource(inventories, gameId, {
          path: `TelemetryPacket.${field}`,
          label: humanize(field),
          unit:
            gameId === "fm-2023" && set.key.startsWith("TireTemp")
              ? "°F"
              : unit,
          dataType: fieldInfo?.type ?? "unknown",
          count: 1,
          description:
            DESCRIPTION_OVERRIDES[set.key] ??
            fieldInfo?.description ??
            `${humanize(field)} emitted by ${gameId} parser.`,
          semanticId:
            gameId === "fm-2023" && set.key === "TireSlipAngle"
              ? "tires.normalized-tire-slip-angle"
              : variable.id,
          sourceKind: "packet",
          recordedByRaceIQ: true,
          retention: "exact",
        });
      }
    }
  }

  const f1Fields = extensionFieldSets(extensionFields(
    interfaceLeafFields(f1TypesSource, f1TypesTree, "F1ExtendedData"),
    "f1",
  ));
  const accFields = extensionFieldSets(extensionFields(
    interfaceLeafFields(
      kunosTypesSource,
      kunosTypesTree,
      "KunosExtendedData",
      new Set(["AcEvoExtendedData"]),
    ).filter(
      (field) => field.name !== "acEvo",
    ),
    "acc",
  ));
  const acEvoFields = extensionFieldSets(extensionFields(
    interfaceLeafFields(
      kunosTypesSource,
      kunosTypesTree,
      "AcEvoExtendedData",
    ),
    "acc.acEvo",
  ));
  const iracingFields = extensionFieldSets(extensionFields(
    interfaceLeafFields(
      iracingTypesSource,
      iracingTypesTree,
      "IRacingExtendedData",
    ),
    "iracing",
  ));

  for (const field of f1Fields) {
    addExtensionVariable(variables, groups, inventories, "f1-2025", field);
  }
  for (const field of accFields) {
    addExtensionVariable(variables, groups, inventories, "acc", field);
    addExtensionVariable(variables, groups, inventories, "ac-evo", field);
  }
  for (const field of acEvoFields) {
    addExtensionVariable(variables, groups, inventories, "ac-evo", field);
  }
  for (const field of iracingFields) {
    addExtensionVariable(variables, groups, inventories, "iracing", field);
  }
  for (const gameId of ["acc", "ac-evo"] as const) {
    for (const section of getSchemaForGame(gameId)) {
      for (const field of section.fields) {
        addSetupFileVariable(
          variables,
          groups,
          inventories,
          gameId,
          field,
        );
      }
    }
  }

  const diagnostic = JSON.parse(await readFile(IRACING_DIAGNOSTIC, "utf8")) as {
    format: string;
    variables: {
      name: string;
      type: string;
      count: number;
      unit: string;
      description: string;
      recordedByRaceIQ?: boolean;
    }[];
    raceIQSelected?: { present?: string[] };
  };
  if (diagnostic.format !== "raceiq-iracing-all-vars-v1") {
    throw new Error(`Unexpected iRacing diagnostic format ${diagnostic.format}`);
  }
  const selected = new Set(diagnostic.raceIQSelected?.present ?? []);
  const existingIRacingSources = new Map<string, string>();
  for (const variable of variables.values()) {
    const link = variable.games.iracing;
    if (link.kind === "unavailable") continue;
    const sources = Array.isArray(link.sources)
      ? link.sources
      : Object.values(link.sources).flat();
    for (const source of sources) {
      if (source.startsWith("iRacing.")) {
        existingIRacingSources.set(source.slice("iRacing.".length), variable.id);
      }
    }
  }

  const rawByName = new Map(
    diagnostic.variables.map((variable) => [variable.name, variable]),
  );
  const consumed = new Set<string>();
  const wheels = ["LF", "RF", "LR", "RR"] as const;

  for (const raw of diagnostic.variables) {
    if (consumed.has(raw.name)) continue;
    const existingSemantic =
      IRACING_SDK_ALIASES[raw.name] ??
      existingIRacingSources.get(raw.name);
    if (existingSemantic) {
      if (!variables.has(existingSemantic)) {
        const definition = SEMANTIC_DEFINITIONS[existingSemantic];
        if (!definition) {
          throw new Error(
            `Missing semantic definition for iRacing SDK alias ${raw.name}`,
          );
        }
        variables.set(existingSemantic, {
          id: existingSemantic,
          ...definition,
          games: unavailableGames(
            "No equivalent source value is currently identified for this parser.",
          ),
        });
        attachChild(groups, definition.parentId, existingSemantic);
      }
      const semantic = variables.get(existingSemantic)!;
      const link = semantic.games.iracing;
      const sdkSource = `iRacing.${raw.name}`;
      const fuelPercentFraction = raw.name === "FuelLevelPct";
      const lapFraction = raw.name === "LapDistPct";
      const pitRoadBoolean = raw.name === "CarIdxOnPitRoad";
      if (link.kind === "unavailable") {
        const nativeUnit = inferredIRacingUnit(raw, semantic);
        const needsUnitNormalization =
          fuelPercentFraction ||
          lapFraction ||
          pitRoadBoolean ||
          canonicalIRacingUnit(nativeUnit) !== semantic.canonicalUnit;
        semantic.games.iracing = {
          kind: needsUnitNormalization ? "normalized" : "direct",
          nativeUnit,
          sources: [sdkSource],
          freshness: iRacingFreshness(raw.name),
          ...(needsUnitNormalization
            ? {
                normalization: fuelPercentFraction
                  ? "fraction * 100"
                  : lapFraction
                    ? "retain SDK 0-1 value as lap fraction"
                    : pitRoadBoolean
                      ? "true = on pit road; false = not on pit road"
                      : `convert ${nativeUnit} to ${semantic.canonicalUnit}`,
              }
            : {}),
          description: "Native iRacing SDK variable linked to shared semantic value.",
        };
      } else if (Array.isArray(link.sources) && !link.sources.includes(sdkSource)) {
        link.sources.push(sdkSource);
        if (lapFraction) {
          link.kind = "normalized";
          link.nativeUnit = "fraction";
          link.normalization = "clamp SDK 0-1 lap distance to 0-1 fraction";
        }
      }
      consumed.add(raw.name);
      addSource(inventories, "iracing", {
        path: raw.name,
        label: humanize(raw.name),
        unit: inferredIRacingUnit(raw, semantic),
        dataType: raw.type,
        count: raw.count,
        description: raw.description,
        semanticId: existingSemantic,
        sourceKind: "sdk",
        recordedByRaceIQ: selected.has(raw.name),
        retention: selected.has(raw.name) ? "exact" : "not-recorded",
      });
      continue;
    }

    const corner = raw.name.match(/^(LF|RF|LR|RR)(.+)$/);
    let members = [raw];
    let semanticName = raw.name;
    let shape: CatalogVariable["shape"] =
      raw.count > 1 ? "array" : "scalar";
    let sourceShape: AvailableLink["sources"] = [`iRacing.${raw.name}`];
    if (corner) {
      const suffix = corner[2];
      const candidates = wheels.map((wheel) => rawByName.get(`${wheel}${suffix}`));
      if (candidates.every(Boolean)) {
        members = candidates as typeof diagnostic.variables;
        semanticName = suffix;
        shape = "per-wheel";
        sourceShape = Object.fromEntries(
          wheels.map((wheel, index) => [
            wheel,
            [`iRacing.${members[index].name}`],
          ]),
        );
      }
    }
    for (const member of members) consumed.add(member.name);

    const category = categoryFor(`${semanticName} ${raw.description}`);
    const id = `${category}.${slug(semanticName)}`;
    const description = generalizeIRacingDescription(raw.description);
    const unit = inferredIRacingUnit(raw);
    const canonicalUnit = canonicalIRacingUnit(unit);
    const definition = SEMANTIC_DEFINITIONS[id];
    let variable = variables.get(id);
    if (!variable) {
      variable = {
        id,
        label: definition?.label ?? humanize(semanticName),
        description: definition?.description ?? description,
        parentId: definition?.parentId ?? category,
        canonicalUnit: definition?.canonicalUnit ?? canonicalUnit,
        shape: definition?.shape ?? shape,
        games: unavailableGames(
          "No equivalent source variable is currently identified for this parser.",
        ),
      };
      variables.set(id, variable);
      attachChild(groups, variable.parentId, id);
    }

    const existing = variable.games.iracing;
    if (existing.kind === "unavailable") {
      const needsUnitNormalization = unit !== variable.canonicalUnit;
      variable.games.iracing = {
        kind: needsUnitNormalization ? "normalized" : "direct",
        nativeUnit: unit,
        sources: sourceShape,
        freshness: iRacingFreshness(raw.name),
        ...(needsUnitNormalization
          ? {
              normalization:
                canonicalIRacingUnit(unit) === variable.canonicalUnit
                  ? `normalize unit notation ${unit} to ${variable.canonicalUnit}`
                  : `convert ${unit} to ${variable.canonicalUnit}`,
            }
          : {}),
        description: members.every((member) => selected.has(member.name))
          ? "Native iRacing SDK source recorded by RaceIQ."
          : "Native iRacing SDK source; catalogued but not selected in current RaceIQ source frame.",
      };
    } else if (Array.isArray(existing.sources) && Array.isArray(sourceShape)) {
      for (const source of sourceShape) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      }
    } else if (!Array.isArray(existing.sources) && !Array.isArray(sourceShape)) {
      for (const [key, sources] of Object.entries(sourceShape)) {
        const target = existing.sources[key] ?? [];
        for (const source of sources) {
          if (!target.includes(source)) target.push(source);
        }
        existing.sources[key] = target;
      }
    } else {
      const existingSources = Array.isArray(existing.sources)
        ? existing.sources
        : Object.values(existing.sources).flat();
      const newSources = Array.isArray(sourceShape)
        ? sourceShape
        : Object.values(sourceShape).flat();
      existing.sources = [...new Set([...existingSources, ...newSources])];
    }
    for (const member of members) {
      addSource(inventories, "iracing", {
        path: member.name,
        label: humanize(member.name),
        unit: inferredIRacingUnit(member, variable),
        dataType: member.type,
        count: member.count,
        description: member.description,
        semanticId: id,
        sourceKind: "sdk",
        recordedByRaceIQ: selected.has(member.name),
        retention: selected.has(member.name) ? "exact" : "not-recorded",
      });
    }
  }
  addIRacingRawYamlSource(variables, groups, inventories);

  for (const field of IRACING_SESSION_INFO_CATALOG_FIELDS) {
    addIRacingYamlField(variables, groups, inventories, field);
  }

  addCrossSourceProjections(variables, groups);
  addSectorDerivedVariables(variables, groups);

  for (const group of groups.values()) {
    if (group.parentId) attachChild(groups, group.parentId, group.id);
    group.children.sort();
  }
  for (const gameId of GAME_IDS) {
    inventories[gameId].sort((a, b) => a.path.localeCompare(b.path));
  }

  const sourceCounts = Object.fromEntries(
    GAME_IDS.map((gameId) => [
      gameId,
      {
        total: inventories[gameId].length,
        packet: inventories[gameId].filter((item) => item.sourceKind === "packet").length,
        extension: inventories[gameId].filter((item) => item.sourceKind === "extension").length,
        sdk: inventories[gameId].filter((item) => item.sourceKind === "sdk").length,
        yaml: inventories[gameId].filter((item) => item.sourceKind === "yaml").length,
        setup: inventories[gameId].filter((item) => item.sourceKind === "setup").length,
        recorded: inventories[gameId].filter((item) => item.recordedByRaceIQ).length,
      },
    ]),
  ) as BuiltTelemetryCatalog["coverage"]["sourceCounts"];
  const provenanceArtifacts = [
    ...new Set([
      "scripts/generate-telemetry-catalog.ts",
      "scripts/iracing-session-info-capture.ts",
      ...IRACING_SESSION_INFO_SOURCE_FILES,
      ...TELEMETRY_TYPE_SOURCE_FILES,
      "shared/setups/schema.ts",
      ...Object.values(PARSER_FILES),
    ]),
  ];
  const provenanceCommits = Object.fromEntries(
    await Promise.all(
      provenanceArtifacts.map(async (artifact) => [
        artifact,
        telemetryCatalogSourceHash(
          await readFile(resolve(ROOT, artifact), "utf8"),
        ),
      ]),
    ),
  );
  const generatorCommit =
    provenanceCommits["scripts/generate-telemetry-catalog.ts"];
  if (!generatorCommit) {
    throw new Error("Missing telemetry catalog generator provenance");
  }
  enrichCatalogContracts(variables, inventories, provenanceCommits);

  const metadataWithoutHash: Omit<CatalogMetadata, "contentHash"> = {
    catalogVersion: PACKAGE_VERSION,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generator: {
      name: GENERATOR_NAME,
      version: PACKAGE_VERSION,
      commit: generatorCommit,
    },
    // Reproducible-build timestamp: intentionally independent of wall clock.
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
  const catalogWithoutHash: Omit<BuiltTelemetryCatalog, "metadata"> & {
    metadata: Omit<CatalogMetadata, "contentHash">;
  } = {
    format: CATALOG_FORMAT,
    metadata: metadataWithoutHash,
    generatedFrom: [
      ...TELEMETRY_TYPE_SOURCE_FILES,
      "shared/setups/schema.ts",
      "shared/setups/catalog/groups.ts",
      "shared/setups/catalog/concepts.ts",
      "shared/setups/catalog/parser-source-mappings.ts",
      "shared/setups/catalog/file-source-mappings.ts",
      ...IRACING_SESSION_INFO_SOURCE_FILES,
      "scripts/iracing-session-info-capture.ts",
      ...Object.values(PARSER_FILES),
      "data/diagnostics/iracing-all-vars-2026-07-29T02-06-39-162Z.json",
      ...iracingSessionInfoCaptureArtifacts,
    ],
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)),
    variables: [...variables.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sources: inventories,
    coverage: {
      normalizedPacketFields: packetFieldNames.length,
      semanticVariables: variables.size,
      sourceCounts,
    },
  };

  return {
    ...catalogWithoutHash,
    metadata: {
      ...metadataWithoutHash,
      contentHash: contentHash(catalogWithoutHash),
    },
  };
}


function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function cardinalityLabel(variable: CatalogVariable): string {
  const cardinality = variable.cardinality;
  if (!cardinality) return "missing";
  if (cardinality.kind === "scalar") return "scalar";
  if (cardinality.kind === "fixed") return `fixed:${cardinality.count}`;
  return `variable:${cardinality.min}-${cardinality.max ?? "*"}`;
}

function valueSchemaLabel(variable: CatalogVariable): string {
  if (variable.valueType === "enum") {
    return `domain: ${variable.enumDomain?.join(", ") ?? "missing"}`;
  }
  if (variable.valueType !== "structured" || !variable.structuredSchema) {
    return "";
  }
  const indices = variable.structuredSchema.indices
    .map(
      (index) =>
        `${index.id} (${index.cardinality.kind}:${index.cardinality.kind === "fixed" ? index.cardinality.count : index.cardinality.kind === "variable" ? `${index.cardinality.min}-${index.cardinality.max ?? "*"}` : "1"}, ${index.ordering})`,
    )
    .join("; ");
  const fields = variable.structuredSchema.fields
    .map((field) => `${field.id}:${field.valueType}`)
    .join(", ");
  return `indices: ${indices}; fields: ${fields}`;
}


function renderCatalogMarkdown(catalog: BuiltTelemetryCatalog): string {
  const lines = [
    "# Telemetry catalog",
    "",
    "> Generated by `bun run telemetry:catalog`. Do not edit manually.",
    "",
    "## Manifest",
    "",
    `- Catalog version: \`${catalog.metadata.catalogVersion}\``,
    `- Schema version: \`${catalog.metadata.schemaVersion}\``,
    `- Generator: \`${catalog.metadata.generator.name}@${catalog.metadata.generator.version}\``,
    `- Generator commit: \`${catalog.metadata.generator.commit}\``,
    `- Generated at: \`${catalog.metadata.generatedAt}\` (reproducible-build epoch)`,
    `- Content SHA-256: \`${catalog.metadata.contentHash}\``,
    "",
    "## Coverage",
    "",
    "| Simulator | Sources | Recorded | Packet | Extension | SDK | YAML | Setup |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...GAME_IDS.map((gameId) => {
      const coverage = catalog.coverage.sourceCounts[gameId];
      return `| ${gameId} | ${coverage.total} | ${coverage.recorded} | ${coverage.packet} | ${coverage.extension} | ${coverage.sdk} | ${coverage.yaml} | ${coverage.setup} |`;
    }),
    "",
    "## Semantic variables",
    "",
    "| Semantic ID | Label | Value type | Dimensions | Unit | Cardinality | Ordering | Value schema | Limitations |",
    "|---|---|---|---|---|---|---|---|---|",
    ...catalog.variables.map(
      (variable) =>
        `| \`${markdownCell(variable.id)}\` | ${markdownCell(variable.label)} | ${variable.valueType} | ${markdownCell(variable.dimensions?.join(" × ") ?? "")} | ${markdownCell(variable.canonicalUnit)} | ${cardinalityLabel(variable)} | ${markdownCell(variable.ordering?.join(", ") ?? "")} | ${markdownCell(valueSchemaLabel(variable))} | ${markdownCell(variable.limitations?.join("; ") ?? "")} |`,
    ),
    "",
    "See [`telemetry-catalog-matrix.md`](./telemetry-catalog-matrix.md) for generated cross-simulator mappings.",
  ];
  return `${lines.join("\n")}\n`;
}

function renderMappingCell(mapping: GameLink): string {
  if (mapping.kind === "unavailable") {
    return markdownCell(`unavailable · ${mapping.reason}`);
  }
  const sources = Array.isArray(mapping.sources)
    ? mapping.sources
    : Object.entries(mapping.sources).flatMap(([element, values]) =>
        values.map((source) => `${element}:${source}`),
      );
  const details = [
    mapping.kind,
    mapping.nativeUnit,
    sources.join("<br>"),
    mapping.provenance?.artifact ?? "",
    mapping.execution?.id ?? "",
    mapping.limitations?.join("; ") ?? "",
  ].filter(Boolean);
  return markdownCell(details.join(" · "));
}

function renderCompatibilityMatrix(catalog: BuiltTelemetryCatalog): string {
  const lines = [
    "# Telemetry cross-simulator compatibility matrix",
    "",
    "> Generated by `bun run telemetry:catalog`. Do not edit manually.",
    "",
    `Catalog \`${catalog.metadata.catalogVersion}\`, schema \`${catalog.metadata.schemaVersion}\`, content \`${catalog.metadata.contentHash}\`.`,
    "",
    "| Semantic ID | Type | Dimensions | Unit | Cardinality | FM 2023 | F1 2025 | ACC | AC Evo | iRacing |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...catalog.variables.map(
      (variable) =>
        `| \`${markdownCell(variable.id)}\` | ${variable.valueType} | ${markdownCell(variable.dimensions?.join(" × ") ?? "")} | ${markdownCell(variable.canonicalUnit)} | ${cardinalityLabel(variable)} | ${renderMappingCell(variable.games["fm-2023"])} | ${renderMappingCell(variable.games["f1-2025"])} | ${renderMappingCell(variable.games.acc)} | ${renderMappingCell(variable.games["ac-evo"])} | ${renderMappingCell(variable.games.iracing)} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export async function buildTelemetryCatalogArtifacts(): Promise<
  ReadonlyMap<string, string>
> {
  const catalog = await buildTelemetryCatalog();
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  const generatedTypeScript = [
    "// Generated by scripts/generate-telemetry-catalog.ts. Do not edit.",
    'import catalog from "./telemetry-catalog.generated.json";',
    "",
    `export const TELEMETRY_CATALOG_VERSION = ${JSON.stringify(catalog.metadata.catalogVersion)};`,
    `export const TELEMETRY_CATALOG_SCHEMA_VERSION = ${JSON.stringify(catalog.metadata.schemaVersion)};`,
    `export const TELEMETRY_CATALOG_HASH = ${JSON.stringify(catalog.metadata.contentHash)};`,
    "export const TELEMETRY_CATALOG_GENERATED = catalog;",
    "",
  ].join("\n");
  return new Map([
    [OUTPUT_PATH, json],
    [OUTPUT_TS_PATH, generatedTypeScript],
    [OUTPUT_MARKDOWN_PATH, renderCatalogMarkdown(catalog)],
    [OUTPUT_MATRIX_PATH, renderCompatibilityMatrix(catalog)],
  ]);
}

type CompatibilityCatalogMapping = {
  kind?: unknown;
  compatibilityReview?: unknown;
};

type CompatibilityCatalogVariable = {
  id: string;
  games: Record<string, CompatibilityCatalogMapping>;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compatibilityVariables(
  catalog: unknown,
  label: string,
): readonly CompatibilityCatalogVariable[] {
  const root = recordValue(catalog);
  if (!root || !Array.isArray(root.variables)) {
    throw new Error(`${label} telemetry catalog lacks a variables array`);
  }
  const result: CompatibilityCatalogVariable[] = [];
  const seen = new Set<string>();
  for (const rawVariable of root.variables) {
    const variable = recordValue(rawVariable);
    const games = recordValue(variable?.games);
    if (
      !variable ||
      typeof variable.id !== "string" ||
      variable.id.trim().length === 0 ||
      !games
    ) {
      throw new Error(
        `${label} telemetry catalog contains a variable without id/games`,
      );
    }
    if (seen.has(variable.id)) {
      throw new Error(
        `${label} telemetry catalog contains duplicate variable ${variable.id}`,
      );
    }
    seen.add(variable.id);
    const parsedGames: Record<string, CompatibilityCatalogMapping> = {};
    for (const gameId of GAME_IDS) {
      const mapping = recordValue(games[gameId]);
      if (
        !mapping ||
        !["direct", "normalized", "derived", "simplified", "unavailable"].includes(
          typeof mapping.kind === "string" ? mapping.kind : "",
        )
      ) {
        throw new Error(
          `${label} telemetry catalog variable ${variable.id} has invalid ${gameId} mapping`,
        );
      }
      parsedGames[gameId] = mapping;
    }
    result.push({ id: variable.id, games: parsedGames });
  }
  return result;
}

function hasCompatibilityReview(mapping: CompatibilityCatalogMapping): boolean {
  const review = recordValue(mapping.compatibilityReview);
  return (
    typeof review?.id === "string" &&
    review.id.trim().length > 0 &&
    typeof review.rationale === "string" &&
    review.rationale.trim().length > 0
  );
}

export function assertDirectToSimplifiedCompatibilityReviews(
  currentCatalog: unknown,
  baselineCatalog: unknown,
): void {
  const current = compatibilityVariables(currentCatalog, "Current");
  const baseline = new Map(
    compatibilityVariables(baselineCatalog, "Baseline").map((variable) => [
      variable.id,
      variable,
    ]),
  );
  const missing: string[] = [];
  for (const variable of current) {
    const previous = baseline.get(variable.id);
    if (!previous) continue;
    for (const gameId of GAME_IDS) {
      const currentMapping = variable.games[gameId];
      const previousMapping = previous.games[gameId];
      if (
        previousMapping?.kind === "direct" &&
        currentMapping?.kind === "simplified" &&
        !hasCompatibilityReview(currentMapping)
      ) {
        missing.push(`${variable.id} [${gameId}]`);
      }
    }
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(
      [
        "Direct-to-simplified telemetry mappings require explicit compatibilityReview { id, rationale }:",
        ...missing.map((mapping) => `- ${mapping}`),
      ].join("\n"),
    );
  }
}

function baselineArgument(args: readonly string[]): string | undefined {
  const indexes = args.flatMap((argument, index) =>
    argument === "--baseline" ? [index] : [],
  );
  if (indexes.length > 1) {
    throw new Error("--baseline may only be specified once");
  }
  const index = indexes[0];
  if (index === undefined) return undefined;
  const path = args[index + 1];
  if (!path || path.startsWith("--")) {
    throw new Error("--baseline requires a telemetry catalog JSON path");
  }
  return path;
}

async function readBaselineCatalog(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(resolve(ROOT, path), "utf8");
  } catch (error) {
    throw new Error(`Unable to read telemetry catalog baseline ${path}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid telemetry catalog baseline JSON ${path}`, {
      cause: error,
    });
  }
}

async function verifyArtifacts(
  expected: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [path, content] of expected) {
    let actual: string;
    try {
      actual = await readFile(path, "utf8");
    } catch {
      throw new Error(`Missing generated telemetry catalog artifact ${path}`);
    }
    if (actual !== content) {
      throw new Error(
        `Stale telemetry catalog artifact ${path}; run bun run telemetry:catalog`,
      );
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const repeat = args.includes("--repeat");
  const baselinePath = baselineArgument(args);
  if (baselinePath && !check) {
    throw new Error("--baseline is only valid with --check");
  }
  const artifacts = await buildTelemetryCatalogArtifacts();
  const catalogJson = artifacts.get(OUTPUT_PATH);
  if (!catalogJson) throw new Error("Generated telemetry catalog JSON is missing");
  const catalog = JSON.parse(catalogJson) as BuiltTelemetryCatalog;
  if (repeat) {
    const repeated = await buildTelemetryCatalogArtifacts();
    for (const [path, content] of artifacts) {
      if (repeated.get(path) !== content) {
        throw new Error(`Non-deterministic telemetry catalog artifact ${path}`);
      }
    }
  }
  if (check) {
    if (baselinePath) {
      assertDirectToSimplifiedCompatibilityReviews(
        catalog,
        await readBaselineCatalog(baselinePath),
      );
    }
    await verifyArtifacts(artifacts);
  } else {
    await Promise.all(
      [...artifacts].map(([path, content]) => writeFile(path, content, "utf8")),
    );
  }
  console.log(
    `${check ? "Verified" : "Wrote"} ${catalog.variables.length} semantic variables and ${Object.values(catalog.sources).reduce((sum, list) => sum + list.length, 0)} parser/source links`,
  );
}

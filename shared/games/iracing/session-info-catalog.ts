/**
 * Known iRacing SessionInfo YAML leaves.
 *
 * iRacing does not publish a permanently closed YAML schema. This list covers
 * documented core sections plus stable CarSetup leaves observed across common
 * car schemas. One explicit fallback remains for genuinely car/build-specific
 * leaves. Real-capture leaf discovery belongs to issue #200.
 */

export type IRacingSessionInfoRetention = "normalized" | "not-recorded";

export interface IRacingSessionInfoCatalogField {
  path: string;
  label: string;
  unit: string;
  description: string;
  retention: IRacingSessionInfoRetention;
  semanticId?: string;
}

const SECTIONS: ReadonlyArray<{
  prefix: string;
  context: string;
  fields: readonly string[];
}> = [
  {
    prefix: "WeekendInfo",
    context: "weekend and track metadata",
    fields: [
      "Category",
      "DCRuleSet",
      "EventType",
      "HeatRacing",
      "LeagueID",
      "MaxDrivers",
      "MinDrivers",
      "NumCarClasses",
      "NumCarTypes",
      "Official",
      "QualifierMustStartRace",
      "RaceWeek",
      "SeasonID",
      "SeriesID",
      "SessionID",
      "SimMode",
      "SubSessionID",
      "TeamRacing",
      "TrackAirPressure",
      "TrackAirTemp",
      "TrackAltitude",
      "TrackCity",
      "TrackCleanup",
      "TrackConfigName",
      "TrackCountry",
      "TrackDirection",
      "TrackDisplayName",
      "TrackDisplayShortName",
      "TrackDynamicTrack",
      "TrackFogLevel",
      "TrackID",
      "TrackLatitude",
      "TrackLength",
      "TrackLongitude",
      "TrackName",
      "TrackNorthOffset",
      "TrackNumTurns",
      "TrackPitSpeedLimit",
      "TrackPrecipitation",
      "TrackRelativeHumidity",
      "TrackSkies",
      "TrackSurfaceTemp",
      "TrackType",
      "TrackWeatherType",
      "TrackWindDir",
      "TrackWindVel",
      "BuildType",
      "BuildTarget",
      "BuildVersion",
    ],
  },
  {
    prefix: "WeekendInfo.WeekendOptions",
    context: "configured weekend options",
    fields: [
      "CommercialMode",
      "CourseCautions",
      "Date",
      "EarthRotationSpeedupFactor",
      "FastRepairsLimit",
      "FogLevel",
      "GreenWhiteCheckeredLimit",
      "HardcoreLevel",
      "HasOpenRegistration",
      "IncidentLimit",
      "IsFixedSetup",
      "NightMode",
      "NumJokerLaps",
      "NumStarters",
      "QualifyScoring",
      "RelativeHumidity",
      "Restarts",
      "ShortParadeLap",
      "Skies",
      "StandingStart",
      "StartingGrid",
      "StrictLapsChecking",
      "TimeOfDay",
      "Unofficial",
      "WeatherTemp",
      "WeatherType",
      "WindDirection",
      "WindSpeed",
    ],
  },
  {
    prefix: "WeekendInfo.TelemetryOptions",
    context: "telemetry recording options",
    fields: ["TelemetryDiskFile"],
  },
  {
    prefix: "SessionInfo.Sessions[]",
    context: "session definition and aggregate results",
    fields: [
      "ResultsAverageLapTime",
      "ResultsLapsComplete",
      "ResultsNumCautionFlags",
      "ResultsNumCautionLaps",
      "ResultsNumLeadChanges",
      "ResultsOfficial",
      "SessionLaps",
      "SessionName",
      "SessionNum",
      "SessionNumLapsToAvg",
      "SessionRunGroupsUsed",
      "SessionSkipped",
      "SessionSubType",
      "SessionTime",
      "SessionTrackRubberState",
      "SessionType",
    ],
  },
  {
    prefix: "SessionInfo.Sessions[].ResultsFastestLap[]",
    context: "session fastest-lap result",
    fields: ["CarIdx", "FastestLap", "FastestTime"],
  },
  {
    prefix: "SessionInfo.Sessions[].ResultsPositions[]",
    context: "competitor session result",
    fields: [
      "CarIdx",
      "ClassPosition",
      "FastestLap",
      "FastestTime",
      "Incidents",
      "JokerLapsComplete",
      "Lap",
      "LapsComplete",
      "LapsDriven",
      "LapsLed",
      "LastTime",
      "Position",
      "ReasonOutId",
      "ReasonOutStr",
      "Time",
    ],
  },
  {
    prefix: "QualifyResultsInfo.Results[]",
    context: "qualifying result",
    fields: [
      "CarIdx",
      "ClassPosition",
      "FastestLap",
      "FastestTime",
      "Position",
    ],
  },
  {
    prefix: "CameraInfo.Groups[]",
    context: "camera group",
    fields: ["GroupName", "GroupNum", "IsScenic"],
  },
  {
    prefix: "CameraInfo.Groups[].Cameras[]",
    context: "camera definition",
    fields: ["CameraName", "CameraNum"],
  },
  {
    prefix: "RadioInfo",
    context: "in-sim radio state",
    fields: ["SelectedRadioNum"],
  },
  {
    prefix: "RadioInfo.Radios[]",
    context: "in-sim radio",
    fields: [
      "HopCount",
      "NumFrequencies",
      "RadioNum",
      "ScanningIsOn",
      "TunedToFrequencyNum",
    ],
  },
  {
    prefix: "RadioInfo.Radios[].Frequencies[]",
    context: "radio frequency",
    fields: [
      "CanScan",
      "CanSquawk",
      "CarIdx",
      "ClubID",
      "EntryIdx",
      "FrequencyName",
      "FrequencyNum",
      "IsDeletable",
      "IsMutable",
      "Muted",
      "Priority",
    ],
  },
  {
    prefix: "DriverInfo",
    context: "player and player-car metadata",
    fields: [
      "DriverCarIdx",
      "DriverUserID",
      "PaceCarIdx",
      "DriverHeadPosX",
      "DriverHeadPosY",
      "DriverHeadPosZ",
      "DriverCarIdleRPM",
      "DriverCarRedLine",
      "DriverCarEngCylinderCount",
      "DriverCarFuelKgPerLtr",
      "DriverCarFuelMaxLtr",
      "DriverCarMaxFuelPct",
      "DriverCarSLFirstRPM",
      "DriverCarSLShiftRPM",
      "DriverCarSLLastRPM",
      "DriverCarSLBlinkRPM",
      "DriverCarVersion",
      "DriverPitTrkPct",
      "DriverCarEstLapTime",
      "DriverSetupName",
      "DriverSetupIsModified",
      "DriverSetupLoadTypeName",
      "DriverSetupPassedTech",
      "DriverIncidentCount",
    ],
  },
  {
    prefix: "DriverInfo.Drivers[]",
    context: "registered competitor",
    fields: [
      "AbbrevName",
      "CarClassColor",
      "CarClassDryTireSetLimit",
      "CarClassID",
      "CarClassLicenseLevel",
      "CarClassMaxFuelPct",
      "CarClassPowerAdjust",
      "CarClassRelSpeed",
      "CarClassShortName",
      "CarClassWeightPenalty",
      "CarDesignStr",
      "CarID",
      "CarIdx",
      "CarIsAI",
      "CarIsPaceCar",
      "CarNumber",
      "CarNumberDesignStr",
      "CarNumberRaw",
      "CarPath",
      "CarScreenName",
      "CarScreenNameShort",
      "CarSponsor_1",
      "CarSponsor_2",
      "ClubName",
      "CurDriverIncidentCount",
      "DivisionName",
      "HelmetDesignStr",
      "Initials",
      "IRating",
      "IsSpectator",
      "LicColor",
      "LicLevel",
      "LicString",
      "LicSubLevel",
      "SuitDesignStr",
      "TeamID",
      "TeamIncidentCount",
      "TeamName",
      "UserID",
      "UserName",
    ],
  },
  {
    prefix: "SplitTimeInfo.Sectors[]",
    context: "native track-sector layout",
    fields: ["SectorNum", "SectorStartPct"],
  },
];

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  "WeekendInfo.TrackLength":
    "Official track length with unit embedded in iRacing YAML value.",
  "WeekendInfo.TrackPitSpeedLimit":
    "Configured pit-lane speed limit with unit embedded in YAML value.",
  "SessionInfo.Sessions[].ResultsPositions[].FastestTime":
    "Competitor's fastest completed lap time in this session.",
  "SessionInfo.Sessions[].ResultsPositions[].LastTime":
    "Competitor's most recently completed lap time.",
  "SessionInfo.Sessions[].ResultsPositions[].Time":
    "Competitor's elapsed or result time for this session.",
  "SessionInfo.Sessions[].ResultsFastestLap[].FastestTime":
    "Fastest completed lap time represented by this session result entry.",
  "QualifyResultsInfo.Results[].FastestTime":
    "Competitor's fastest qualifying lap time.",
  "DriverInfo.DriverCarEstLapTime":
    "iRacing's estimated lap time for player car and current track.",
  "DriverInfo.DriverPitTrkPct":
    "Lap fraction where player car's pit stall is located.",
  "SplitTimeInfo.Sectors[].SectorNum":
    "Zero-based order of this native iRacing sector.",
  "SplitTimeInfo.Sectors[].SectorStartPct":
    "Lap fraction where this sector starts and previous sector ends.",
};

const NORMALIZED_PATHS = new Set([
  "WeekendInfo.TrackName",
  "WeekendInfo.TrackID",
  "WeekendInfo.TrackLength",
  "WeekendInfo.TrackDisplayName",
  "WeekendInfo.TrackDisplayShortName",
  "WeekendInfo.SessionID",
  "WeekendInfo.SubSessionID",
  "DriverInfo.DriverCarIdx",
  "DriverInfo.DriverCarIdleRPM",
  "DriverInfo.DriverCarRedLine",
  "DriverInfo.DriverCarEngCylinderCount",
  "DriverInfo.Drivers[].CarIdx",
  "DriverInfo.Drivers[].CarID",
  "DriverInfo.Drivers[].CarPath",
  "DriverInfo.Drivers[].CarScreenName",
  "DriverInfo.Drivers[].CarScreenNameShort",
  "DriverInfo.Drivers[].CarClassID",
  "DriverInfo.Drivers[].CarClassShortName",
  "DriverInfo.Drivers[].CarClassRelSpeed",
  "SplitTimeInfo.Sectors[].SectorNum",
  "SplitTimeInfo.Sectors[].SectorStartPct",
]);

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\bRpm\b/gi, "RPM")
    .replace(/\bId\b/g, "ID")
    .trim();
}

function unitFor(path: string): string {
  const field = path.split(".").at(-1) ?? path;
  const exactUnits: Record<string, string> = {
    TrackDirection: "text",
    NumCarClasses: "count",
    NumCarTypes: "count",
    DriverCarIdx: "index",
    PaceCarIdx: "index",
    DriverCarMaxFuelPct: "value-with-unit",
    CarClassRelSpeed: "value-with-unit",
    ResultsLapsComplete: "count",
    ResultsOfficial: "boolean",
    ResultsNumCautionFlags: "count",
    ResultsNumCautionLaps: "count",
    ResultsNumLeadChanges: "count",
    JokerLapsComplete: "count",
    LapsComplete: "count",
    LapsDriven: "count",
    SessionNumLapsToAvg: "count",
    SessionRunGroupsUsed: "count",
    SessionSkipped: "boolean",
  };
  if (exactUnits[field]) return exactUnits[field];
  if (
    /^(TrackLength|TrackAltitude|TrackPitSpeedLimit|TrackAirPressure|TrackAirTemp|TrackFogLevel|TrackPrecipitation|TrackRelativeHumidity|TrackSurfaceTemp|TrackWindDir|TrackWindVel|WeatherTemp|RelativeHumidity|FogLevel|WindDirection|WindSpeed|CarClassMaxFuelPct|CarClassWeightPenalty|CarClassPowerAdjust|CarClassDryTireSetLimit|SessionLaps|SessionTime|IncidentLimit|FastRepairsLimit)$/.test(
      field,
    )
  ) {
    return "value-with-unit";
  }
  if (/^(FastestTime|LastTime|Time|ResultsAverageLapTime|DriverCarEstLapTime)$/.test(field)) {
    return "s";
  }
  if (/RPM$|RedLine$/.test(field)) return "rpm";
  if (/FuelMaxLtr$/.test(field)) return "L";
  if (/FuelKgPerLtr$/.test(field)) return "kg/L";
  if (/HeadPos[XYZ]$/.test(field)) return "m";
  if (/PitTrkPct$|SectorStartPct$/.test(field)) return "fraction";
  if (field === "SectorNum") return "index";
  if (/Latitude$|Longitude$|NorthOffset$|Direction$/.test(field)) return "deg";
  if (/Color$/.test(field)) return "color";
  if (
    /^(Official|Unofficial|TeamRacing|QualifierMustStartRace|HeatRacing|StandingStart|ShortParadeLap|HasOpenRegistration|IsFixedSetup|IsScenic|ScanningIsOn|CanScan|CanSquawk|IsDeletable|IsMutable|Muted|DriverSetupIsModified|DriverSetupPassedTech|CarIsAI|CarIsPaceCar|IsSpectator)$/.test(
      field,
    )
  ) {
    return "boolean";
  }
  if (/ID$|Id$|UserID$|TeamID$|ClubID$|CarID$|ClassID$|LeagueID$|SeasonID$|SeriesID$|SessionID$|SubSessionID$/.test(field)) {
    return "id";
  }
  if (/Idx$|Num$|Position$|Lap$|Laps$|Count$|Rating$|Level$|Priority$|Turns$|Drivers$|Starters$|Frequencies$|Flags$|Changes$|Week$/.test(field)) {
    return "count";
  }
  return "text";
}

interface SetupLeaf {
  field: string;
  label: string;
  unit: string;
  description: string;
  semanticId: string;
}

const IRACING_SETUP_CORNERS = [
  { path: "LeftFront", label: "front-left", temperatures: "LastTempsOMI" },
  { path: "RightFront", label: "front-right", temperatures: "LastTempsIMO" },
  { path: "LeftRear", label: "rear-left", temperatures: "LastTempsOMI" },
  { path: "RightRear", label: "rear-right", temperatures: "LastTempsIMO" },
] as const;

function setupField(
  path: string,
  label: string,
  unit: string,
  description: string,
  semanticId: string,
): IRacingSessionInfoCatalogField {
  return {
    path: `CarSetup.${path}`,
    label,
    unit,
    description,
    semanticId,
    retention: "not-recorded",
  };
}

function setupCornerFields(
  section: string,
  leaves: readonly SetupLeaf[],
): IRacingSessionInfoCatalogField[] {
  return IRACING_SETUP_CORNERS.flatMap((corner) =>
    leaves.map((leaf) =>
      setupField(
        `${section}.${corner.path}.${leaf.field}`,
        `${humanize(leaf.label)} ${corner.label}`,
        leaf.unit,
        `${leaf.description} for ${corner.label} wheel.`,
        leaf.semanticId,
      ),
    ),
  );
}

function setupTemperatureFields(
  section: string,
): IRacingSessionInfoCatalogField[] {
  return IRACING_SETUP_CORNERS.map((corner) =>
    setupField(
      `${section}.${corner.path}.${corner.temperatures}`,
      `Last temperature bands ${corner.label}`,
      "value-with-unit",
      `Last three setup-screen tire temperature bands for ${corner.label} wheel; source order is encoded by OMI or IMO field name.`,
      "setup.tires.last-temperature-bands",
    ),
  );
}

const TIRE_SETUP_LEAVES: readonly SetupLeaf[] = [
  {
    field: "LastHotPressure",
    label: "last hot pressure",
    unit: "value-with-unit",
    description: "Last setup-screen hot tire pressure",
    semanticId: "setup.tires.last-hot-pressure",
  },
  {
    field: "TreadRemaining",
    label: "tread remaining",
    unit: "value-with-unit",
    description: "Three-band tread remaining",
    semanticId: "setup.tires.tread-remaining",
  },
];

const CORNER_SETUP_LEAVES: readonly SetupLeaf[] = [
  {
    field: "CornerWeight",
    label: "corner weight",
    unit: "value-with-unit",
    description: "Static corner weight",
    semanticId: "setup.weight.corner-weight",
  },
  {
    field: "RideHeight",
    label: "ride height",
    unit: "value-with-unit",
    description: "Static setup ride height",
    semanticId: "setup.suspension.ride-height",
  },
  {
    field: "ShockDeflection",
    label: "shock deflection",
    unit: "value-with-unit",
    description: "Static setup shock deflection",
    semanticId: "setup.suspension.shock-deflection",
  },
  {
    field: "SpringPerchOffset",
    label: "spring perch offset",
    unit: "value-with-unit",
    description: "Spring perch offset",
    semanticId: "setup.suspension.spring-perch-offset",
  },
  {
    field: "SpringRate",
    label: "spring rate",
    unit: "value-with-unit",
    description: "Spring-rate setting",
    semanticId: "setup.suspension.spring-rate",
  },
  {
    field: "SpringSelected",
    label: "spring selection",
    unit: "index",
    description: "Discrete spring selection",
    semanticId: "setup.suspension.spring-selection",
  },
  {
    field: "BumpStiffness",
    label: "bump stiffness",
    unit: "level",
    description: "Single-rate compression damping",
    semanticId: "setup.dampers.compression",
  },
  {
    field: "ReboundStiffness",
    label: "rebound stiffness",
    unit: "level",
    description: "Single-rate rebound damping",
    semanticId: "setup.dampers.rebound",
  },
  {
    field: "CompDamping",
    label: "compression damping",
    unit: "level",
    description: "Single-rate compression damping",
    semanticId: "setup.dampers.compression",
  },
  {
    field: "RbdDamping",
    label: "rebound damping",
    unit: "level",
    description: "Single-rate rebound damping",
    semanticId: "setup.dampers.rebound",
  },
  {
    field: "LsCompDamping",
    label: "slow compression damping",
    unit: "level",
    description: "Low-speed compression damping",
    semanticId: "setup.dampers.slow-compression",
  },
  {
    field: "HsCompDamping",
    label: "fast compression damping",
    unit: "level",
    description: "High-speed compression damping",
    semanticId: "setup.dampers.fast-compression",
  },
  {
    field: "LsRbdDamping",
    label: "slow rebound damping",
    unit: "level",
    description: "Low-speed rebound damping",
    semanticId: "setup.dampers.slow-rebound",
  },
  {
    field: "HsRbdDamping",
    label: "fast rebound damping",
    unit: "level",
    description: "High-speed rebound damping",
    semanticId: "setup.dampers.fast-rebound",
  },
  {
    field: "Camber",
    label: "camber",
    unit: "value-with-unit",
    description: "Static camber",
    semanticId: "setup.alignment.camber",
  },
  {
    field: "Caster",
    label: "caster",
    unit: "value-with-unit",
    description: "Static caster",
    semanticId: "setup.alignment.caster",
  },
  {
    field: "ToeIn",
    label: "toe",
    unit: "value-with-unit",
    description: "Static toe-in",
    semanticId: "setup.alignment.toe",
  },
];

const FRONT_SETUP_LEAVES: readonly SetupLeaf[] = [
  {
    field: "ArbArms",
    label: "front ARB arms",
    unit: "count",
    description: "Front anti-roll-bar arm count or position",
    semanticId: "setup.suspension.front-anti-roll-bar.arms",
  },
  {
    field: "ArbBlades",
    label: "front ARB blades",
    unit: "level",
    description: "Front anti-roll-bar blade setting",
    semanticId: "setup.suspension.front-anti-roll-bar.blades",
  },
  {
    field: "ArbDiameter",
    label: "front ARB diameter",
    unit: "value-with-unit",
    description: "Front anti-roll-bar diameter",
    semanticId: "setup.suspension.front-anti-roll-bar.diameter",
  },
  {
    field: "ArbOuterDiameter",
    label: "front ARB outer diameter",
    unit: "value-with-unit",
    description: "Front anti-roll-bar outer diameter",
    semanticId: "setup.suspension.front-anti-roll-bar.outer-diameter",
  },
  {
    field: "AntiRollBar",
    label: "front anti-roll bar",
    unit: "configuration",
    description: "Front anti-roll-bar setting",
    semanticId: "setup.suspension.front-anti-roll-bar.setting",
  },
  {
    field: "BrakeBias",
    label: "brake bias",
    unit: "value-with-unit",
    description: "Configured front brake bias",
    semanticId: "setup.brakes.bias",
  },
  {
    field: "BrakePads",
    label: "brake pads",
    unit: "enum",
    description: "Configured brake-pad compound",
    semanticId: "setup.brakes.pad-compound",
  },
  {
    field: "FrontMasterCyl",
    label: "front master cylinder",
    unit: "value-with-unit",
    description: "Front brake master-cylinder setting",
    semanticId: "setup.brakes.front-master-cylinder",
  },
  {
    field: "RearMasterCyl",
    label: "rear master cylinder",
    unit: "value-with-unit",
    description: "Rear brake master-cylinder setting",
    semanticId: "setup.brakes.rear-master-cylinder",
  },
  {
    field: "ToeIn",
    label: "front toe",
    unit: "value-with-unit",
    description: "Front-axle toe-in",
    semanticId: "setup.alignment.toe",
  },
  {
    field: "SteeringRatio",
    label: "steering ratio",
    unit: "ratio",
    description: "Steering ratio",
    semanticId: "setup.alignment.steering-ratio",
  },
  {
    field: "CrossWeight",
    label: "cross weight",
    unit: "value-with-unit",
    description: "Diagonal cross-weight percentage",
    semanticId: "setup.weight.cross-weight",
  },
];

const REAR_SETUP_LEAVES: readonly SetupLeaf[] = [
  {
    field: "FuelLevel",
    label: "fuel level",
    unit: "value-with-unit",
    description: "Configured starting fuel volume",
    semanticId: "setup.strategy.fuel-volume",
  },
  {
    field: "ArbArms",
    label: "rear ARB arms",
    unit: "count",
    description: "Rear anti-roll-bar arm count or position",
    semanticId: "setup.suspension.rear-anti-roll-bar.arms",
  },
  {
    field: "ArbBlades",
    label: "rear ARB blades",
    unit: "level",
    description: "Rear anti-roll-bar blade setting",
    semanticId: "setup.suspension.rear-anti-roll-bar.blades",
  },
  {
    field: "ArbDiameter",
    label: "rear ARB diameter",
    unit: "value-with-unit",
    description: "Rear anti-roll-bar diameter",
    semanticId: "setup.suspension.rear-anti-roll-bar.diameter",
  },
  {
    field: "ArbOuterDiameter",
    label: "rear ARB outer diameter",
    unit: "value-with-unit",
    description: "Rear anti-roll-bar outer diameter",
    semanticId: "setup.suspension.rear-anti-roll-bar.outer-diameter",
  },
  {
    field: "AntiRollBar",
    label: "rear anti-roll bar",
    unit: "configuration",
    description: "Rear anti-roll-bar setting",
    semanticId: "setup.suspension.rear-anti-roll-bar.setting",
  },
  {
    field: "ToeIn",
    label: "rear toe",
    unit: "value-with-unit",
    description: "Rear-axle toe-in",
    semanticId: "setup.alignment.toe",
  },
  {
    field: "DiffPreload",
    label: "differential preload",
    unit: "value-with-unit",
    description: "Mechanical differential preload",
    semanticId: "setup.drivetrain.differential-preload",
  },
  {
    field: "WingAngle",
    label: "rear wing angle",
    unit: "value-with-unit",
    description: "Rear wing angle",
    semanticId: "setup.aero.rear-wing.angle",
  },
  {
    field: "WingSetting",
    label: "rear wing setting",
    unit: "configuration",
    description: "Rear wing setting",
    semanticId: "setup.aero.rear-wing.setting",
  },
  {
    field: "FrictionFaces",
    label: "differential friction faces",
    unit: "count",
    description: "Number of differential friction faces",
    semanticId: "setup.drivetrain.differential-clutch-plates",
  },
  {
    field: "SixthGear",
    label: "sixth gear",
    unit: "ratio",
    description: "Sixth-gear ratio or selection",
    semanticId: "setup.drivetrain.gear-ratios",
  },
];

const IN_CAR_DIAL_LEAVES: readonly SetupLeaf[] = [
  {
    field: "BrakePressureBias",
    label: "brake bias",
    unit: "value-with-unit",
    description: "In-car brake-pressure bias",
    semanticId: "setup.brakes.bias",
  },
  {
    field: "AbsSetting",
    label: "ABS",
    unit: "level",
    description: "Configured ABS level",
    semanticId: "setup.electronics.abs",
  },
  {
    field: "TractionControlSetting",
    label: "traction control",
    unit: "level",
    description: "Configured traction-control level",
    semanticId: "setup.electronics.traction-control",
  },
  {
    field: "EngineMapSetting",
    label: "engine map",
    unit: "level",
    description: "Configured engine-map level",
    semanticId: "setup.electronics.engine-map",
  },
  {
    field: "ThrottleShapeSetting",
    label: "throttle shape",
    unit: "level",
    description: "Configured throttle-response shape",
    semanticId: "setup.electronics.throttle-shape",
  },
  {
    field: "DisplayPage",
    label: "display page",
    unit: "index",
    description: "Configured in-car display page",
    semanticId: "setup.electronics.display-page",
  },
  {
    field: "CrossWeight",
    label: "cross weight",
    unit: "value-with-unit",
    description: "Diagonal cross-weight percentage",
    semanticId: "setup.weight.cross-weight",
  },
];

const IRACING_CAR_SETUP_FIELDS: readonly IRacingSessionInfoCatalogField[] = [
  setupField(
    "UpdateCount",
    "Setup update count",
    "count",
    "Revision counter for active iRacing setup.",
    "setup.metadata.update-count",
  ),
  ...setupCornerFields("TiresAero", [
    {
      field: "StartingPressure",
      label: "starting pressure",
      unit: "value-with-unit",
      description: "Configured starting tire pressure",
      semanticId: "setup.tires.starting-pressure",
    },
    ...TIRE_SETUP_LEAVES,
  ]),
  ...setupTemperatureFields("TiresAero"),
  ...setupCornerFields("Tires", [
    {
      field: "ColdPressure",
      label: "cold pressure",
      unit: "value-with-unit",
      description: "Configured cold tire pressure",
      semanticId: "setup.tires.starting-pressure",
    },
    ...TIRE_SETUP_LEAVES,
  ]),
  ...setupTemperatureFields("Tires"),
  ...setupCornerFields("Chassis", CORNER_SETUP_LEAVES),
  ...setupCornerFields("Suspension", [
    {
      field: "ColdPressure",
      label: "cold pressure",
      unit: "value-with-unit",
      description: "Configured cold tire pressure",
      semanticId: "setup.tires.starting-pressure",
    },
    ...TIRE_SETUP_LEAVES,
    ...CORNER_SETUP_LEAVES,
  ]),
  ...setupTemperatureFields("Suspension"),
  ...FRONT_SETUP_LEAVES.flatMap((leaf) => [
    setupField(
      `Chassis.Front.${leaf.field}`,
      leaf.label,
      leaf.unit,
      `${leaf.description} from iRacing chassis setup.`,
      leaf.semanticId,
    ),
    setupField(
      `Suspension.Front.${leaf.field}`,
      leaf.label,
      leaf.unit,
      `${leaf.description} from iRacing suspension setup.`,
      leaf.semanticId,
    ),
  ]),
  ...REAR_SETUP_LEAVES.flatMap((leaf) => [
    setupField(
      `Chassis.Rear.${leaf.field}`,
      leaf.label,
      leaf.unit,
      `${leaf.description} from iRacing chassis setup.`,
      leaf.semanticId,
    ),
    setupField(
      `Suspension.Rear.${leaf.field}`,
      leaf.label,
      leaf.unit,
      `${leaf.description} from iRacing suspension setup.`,
      leaf.semanticId,
    ),
  ]),
  ...IN_CAR_DIAL_LEAVES.map((leaf) =>
    setupField(
      `Chassis.InCarDials.${leaf.field}`,
      leaf.label,
      leaf.unit,
      `${leaf.description} from iRacing in-car setup dials.`,
      leaf.semanticId,
    ),
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.FrontRhAtSpeed",
    "Front ride height at speed",
    "value-with-unit",
    "Calculated front ride height at reference speed.",
    "setup.aero.front-ride-height-at-speed",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.RearRhAtSpeed",
    "Rear ride height at speed",
    "value-with-unit",
    "Calculated rear ride height at reference speed.",
    "setup.aero.rear-ride-height-at-speed",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.RearWingAngle",
    "Rear wing angle",
    "value-with-unit",
    "Rear wing angle used by iRacing aero calculator.",
    "setup.aero.rear-wing.angle",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.WingSetting",
    "Wing setting",
    "configuration",
    "Wing setting used by iRacing aero calculator.",
    "setup.aero.rear-wing.setting",
  ),
  setupField(
    "TiresAero.AeroBalanceCalc.FrontDownforce",
    "Front downforce",
    "value-with-unit",
    "Calculated front downforce or aero balance.",
    "setup.aero.front-downforce",
  ),
  setupField(
    "Drivetrain.Differential.ClutchPlates",
    "Differential clutch plates",
    "count",
    "Number of differential clutch plates.",
    "setup.drivetrain.differential-clutch-plates",
  ),
  setupField(
    "Drivetrain.Differential.FrictionFaces",
    "Differential friction faces",
    "count",
    "Number of differential friction faces.",
    "setup.drivetrain.differential-clutch-plates",
  ),
  setupField(
    "Drivetrain.Differential.Preload",
    "Differential preload",
    "value-with-unit",
    "Mechanical differential preload.",
    "setup.drivetrain.differential-preload",
  ),
  setupField(
    "Drivetrain.Differential.DriveRampAngle",
    "Differential drive ramp",
    "value-with-unit",
    "Power-side differential ramp angle.",
    "setup.drivetrain.differential-drive-ramp",
  ),
  setupField(
    "Drivetrain.Differential.CoastRampAngle",
    "Differential coast ramp",
    "value-with-unit",
    "Coast-side differential ramp angle.",
    "setup.drivetrain.differential-coast-ramp",
  ),
  setupField(
    "Drivetrain.Transmission.FinalDrive",
    "Final drive",
    "ratio",
    "Transmission final-drive ratio or selection.",
    "setup.drivetrain.final-drive",
  ),
  ...[
    "FirstGear",
    "SecondGear",
    "ThirdGear",
    "FourthGear",
    "FifthGear",
    "SixthGear",
    "SeventhGear",
    "EighthGear",
  ].map((field) =>
    setupField(
      `Drivetrain.Transmission.${field}`,
      humanize(field),
      "ratio",
      `${humanize(field)} ratio or selection.`,
      "setup.drivetrain.gear-ratios",
    ),
  ),
];

export const IRACING_SESSION_INFO_CATALOG_FIELDS: readonly IRacingSessionInfoCatalogField[] = [
  ...SECTIONS.flatMap(({ prefix, context, fields }) =>
    fields.map((field) => {
      const path = `${prefix}.${field}`;
      return {
        path,
        label: humanize(field),
        unit: unitFor(path),
        description:
          DESCRIPTION_OVERRIDES[path] ??
          `${humanize(field)} from iRacing ${context}.`,
        retention: NORMALIZED_PATHS.has(path)
          ? ("normalized" as const)
          : ("not-recorded" as const),
      };
    }),
  ),
  ...IRACING_CAR_SETUP_FIELDS,
  {
    path: "CarSetup.**",
    label: "Unmapped car-specific setup values",
    unit: "structured",
    description:
      "Fallback for car- or build-specific setup leaves not represented by stable catalogued paths.",
    semanticId: "setup.metadata.unmapped-source-values",
    retention: "not-recorded",
  },
];
